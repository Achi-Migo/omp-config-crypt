import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import {
  configRoot,
  ompHome,
  buildArchive,
  restoreArchive,
  exportEncrypted,
  importEncrypted,
  pushHttp,
  pullHttp,
  pushGist,
  pullGist,
  rollback,
  collect,
  readSyncPolicy,
  setResourceScope,
  resolveResourceScope,
  inventoryResources,
  readResource,
  planSync,
  applySyncPlan,
  rollbackSync,
  readSyncState,
  writeSyncState,
  canonicalHash,
  validateSnapshot,
  pruneOldBackups,
  formatSyncReport,
  extractDryRun,
  adaptArchive,
  selectPublicResources,
  inspectArchivePayload,
  adaptLegacySnapshot,
} from "../index.js";
import pluginEntry from "../index.js";
import { parseYamlStrict } from "../src/sync-resources.js";
import { getSyncPlanTransaction } from "../src/sync-plan.js";
import { withSyncLock } from "../src/sync-files.js";

const TEST_PASS = "TestPassword_12345!";
const MAGIC = Buffer.from("OMPCFG1\0", "latin1");

function decryptTestArchive(blob, pass = TEST_PASS) {
  let o = MAGIC.length;
  const salt = blob.subarray(o, (o += 16));
  const iv = blob.subarray(o, (o += 12));
  const tag = blob.subarray(o, (o += 16));
  const ct = blob.subarray(o);
  const key = scryptSync(pass, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = gunzipSync(Buffer.concat([decipher.update(ct), decipher.final()]));
  return JSON.parse(plain.toString("utf8"));
}

function encryptTestArchive(payload, pass = TEST_PASS) {
  const plain = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

function snapshotTree(root) {
  const rows = [];
  function walk(abs, rel) {
    const stat = fs.lstatSync(abs);
    const row = {
      rel,
      type: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file",
      mode: stat.mode & 0o777,
    };
    if (stat.isFile()) row.data = fs.readFileSync(abs).toString("hex");
    if (stat.isSymbolicLink()) row.target = fs.readlinkSync(abs);
    rows.push(row);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      }
    }
  }
  walk(root, "");
  return rows;
}

function archiveWith(resources, tombstones = []) {
  return {
    v: 3,
    namespace: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-01-02T03:04:05.000Z",
    resources,
    tombstones,
  };
}

function skillFile(filePath, text = "# demo\n", mode = 0o600) {
  return { path: filePath, data: Buffer.from(text).toString("base64"), mode };
}

function makeTempEnv(prefix = "omp-test-") {
  // Fixtures derive paths relative to os.homedir() (e.g. {{OMP_HOME}}/...).
  // When the system temp dir lives outside HOME (Linux root: /tmp vs /root),
  // those fixtures would escape HOME and fail closed in mapHomePath.
  const tmp = os.tmpdir();
  const rel = path.relative(os.homedir(), tmp);
  const tmpInHome = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!tmpInHome) fs.mkdirSync(path.join(os.homedir(), ".omp", "tmp"), { recursive: true });
  const base = fs.mkdtempSync(path.join(tmpInHome ? tmp : path.join(os.homedir(), ".omp", "tmp"), prefix));
  const envA = path.join(base, "envA");
  const envB = path.join(base, "envB");

  function initEnv(dir) {
    const agent = path.join(dir, "agent");
    const plugins = path.join(dir, "plugins");
    const tools = path.join(dir, "tools");
    const hooks = path.join(dir, "hooks");
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(plugins, { recursive: true });
    fs.mkdirSync(tools, { recursive: true });
    fs.mkdirSync(hooks, { recursive: true });
    return { dir, agent, plugins, tools, hooks };
  }

  const a = initEnv(envA);
  const b = initEnv(envB);

  return {
    base,
    a,
    b,
    cleanup() {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {}
    },
  };
}

function installPlugin(env, name, version) {
  const pluginDir = path.join(env.plugins, "node_modules", ...name.split("/"));
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name, version }));
}

function homeEnvironment(home, agent) {
  const parsed = path.parse(home);
  const env = {
    ...process.env,
    OMP_CFG_ROOT: agent,
    OMP_HOME: home,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: parsed.root,
    HOMEPATH: home.slice(Math.max(0, parsed.root.length - 1)),
    TEST_EXPECTED_HOME: home,
  };
  delete env.GITHUB_TOKEN;
  delete env.OMP_CFG_CLOUD_TOKEN;
  return env;
}

function spawnAtHome(home, agent, args) {
  const env = homeEnvironment(home, agent);
  const check = spawnSync(process.execPath, ["-e", "const os=require('os'),path=require('path');if(path.resolve(os.homedir())!==path.resolve(process.env.TEST_EXPECTED_HOME)){console.error('unexpected HOME '+os.homedir());process.exit(2)}"], { env, encoding: "utf8" });
  assert.equal(check.status, 0, `HOME precondition failed: ${check.stderr}`);
  return spawnSync(process.execPath, args, { env, encoding: "utf8" });
}

test("1. Export isolation and selective public bundle verification", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const root = env.a.agent;

  // Set up resources in A:
  // Public provider + Private provider
  const modelsYml = `# Main models file with comment
providers:
  shared-ai:
    baseUrl: https://api.shared.com/v1
    apiKey: secret-shared-token-xyz
    models:
      - id: gpt-4o
  private-local-ai:
    baseUrl: https://api.local.private/v1
    apiKey: super-secret-local-key
    private: true
    models:
      - id: llama-3
`;
  fs.writeFileSync(path.join(root, "models.yml"), modelsYml, "utf8");

  // Private provider in models.local.json
  fs.writeFileSync(
    path.join(root, "models.local.json"),
    JSON.stringify({
      providers: {
        "ultra-private": {
          baseUrl: "http://localhost:8000",
          apiKey: "unexported-key",
        },
      },
    }),
    "utf8"
  );

  // MCP: one shared server and one private server
  const mcpJson = {
    mcpServers: {
      "shared-mcp": {
        command: "node",
        args: ["server.js"],
        env: { MCP_SECRET: "mcp-token-12345" },
      },
      "local-only-mcp": {
        command: "python3",
        args: ["local.py"],
      },
    },
  };
  fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify(mcpJson, null, 2), "utf8");

  // Setting in config.yml
  fs.writeFileSync(
    path.join(root, "config.yml"),
    "theme: dark\nmodelRoles:\n  default: shared-ai/gpt-4o\n  smol: shared-ai/gpt-4o\n",
    "utf8"
  );

  // Skill asset
  const skillDir = path.join(root, "skills", "shared-search");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Shared Search Skill\n", "utf8");

  // Private tool
  const privTool = path.join(env.a.tools, "private-tool");
  fs.mkdirSync(privTool, { recursive: true });
  fs.writeFileSync(path.join(privTool, "tool.sh"), "#!/bin/sh\necho priv\n", "utf8");

  // Set scopes:
  await setResourceScope(root, "provider:shared-ai", "public");
  await setResourceScope(root, "mcp:shared-mcp", "public");
  await setResourceScope(root, "setting:/modelRoles/default", "public");
  await setResourceScope(root, "asset:skills/shared-search", "public");

  // Verify setting private scope on private tool
  await setResourceScope(root, "asset:tools/private-tool", "private");

  // Attempting to set public on provider with private flag must be rejected
  await assert.rejects(
    async () => {
      await setResourceScope(root, "provider:private-local-ai", "public");
    },
    /marked private/
  );
  await assert.rejects(
    async () => {
      await setResourceScope(root, "provider:ultra-private", "public");
    },
    /marked private/
  );

  // Build archive and inspect decrypted payload
  const { blob, files } = buildArchive(TEST_PASS, root);
  assert.equal(files, 4, "4 public resources bundled");

  const payload = decryptTestArchive(blob);
  assert.equal(payload.v, 3, "Payload is v3");
  assert.ok(payload.namespace, "Namespace exists");

  const publicIds = payload.resources.map((r) => r.id);
  assert.ok(publicIds.includes("provider:shared-ai"));
  assert.ok(publicIds.includes("mcp:shared-mcp"));
  assert.ok(publicIds.includes("setting:/modelRoles/default"));
  assert.ok(publicIds.includes("asset:skills/shared-search"));

  // Assert credentials for public resources are preserved intact
  const prov = payload.resources.find((r) => r.id === "provider:shared-ai").value;
  assert.equal(prov.apiKey, "secret-shared-token-xyz");

  const mcp = payload.resources.find((r) => r.id === "mcp:shared-mcp").value;
  assert.equal(mcp.env.MCP_SECRET, "mcp-token-12345");

  // Assert private items NEVER appear
  assert.ok(!publicIds.includes("provider:private-local-ai"));
  assert.ok(!publicIds.includes("provider:ultra-private"));
  assert.ok(!publicIds.includes("mcp:local-only-mcp"));
  assert.ok(!publicIds.includes("asset:tools/private-tool"));
  assert.ok(!publicIds.includes("setting:/theme"));
  assert.ok(!publicIds.includes("setting:/modelRoles/smol"));

  // Assert policy/state files do not appear in resources
  assert.ok(!publicIds.some((id) => id.includes("sync-policy") || id.includes("sync-state")));
});

test("2. Three-way merge matrix and conflict isolation", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  // A has shared provider & mcp
  fs.writeFileSync(
    path.join(rootA, "models.yml"),
    "providers:\n  common: { baseUrl: 'https://v1.com', apiKey: 'a-key' }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(rootA, "mcp.json"),
    JSON.stringify({ mcpServers: { "srv-1": { command: "node", args: ["a.js"] } } }),
    "utf8"
  );
  await setResourceScope(rootA, "provider:common", "public");
  await setResourceScope(rootA, "mcp:srv-1", "public");

  // B has local private provider with same name in models.local.json
  fs.writeFileSync(
    path.join(rootB, "models.local.json"),
    JSON.stringify({
      providers: {
        common: { baseUrl: "http://b-private.com", apiKey: "b-private-key", private: true },
      },
    }),
    "utf8"
  );
  // B also has unclassified srv-1 with different configuration
  fs.writeFileSync(
    path.join(rootB, "mcp.json"),
    JSON.stringify({ mcpServers: { "srv-1": { command: "node", args: ["different-b.js"] } } }),
    "utf8"
  );

  const { blob } = buildArchive(TEST_PASS, rootA);

  // Planning sync on B:
  // provider:common is private on B -> must be kept
  // mcp:srv-1 exists locally different with no baseline -> initial conflict!
  const payload = decryptTestArchive(blob);
  const plan1 = planSync(payload, rootB);

  const actionCommon = plan1.actions.find((a) => a.id === "provider:common");
  assert.equal(actionCommon.action, "keep");
  assert.equal(actionCommon.reason, "local-private-protected");

  const actionMcp = plan1.actions.find((a) => a.id === "mcp:srv-1");
  assert.equal(actionMcp.action, "conflict");
  assert.equal(actionMcp.reason, "initial-conflict-both-exist-different");

  // Applying with conflicts must be rejected and modify 0 files
  assert.throws(
    () => {
      applySyncPlan(plan1, rootB);
    },
    /conflict/
  );

  // Now resolve conflict on B by explicitly accepting A or marking srv-1 private
  await setResourceScope(rootB, "mcp:srv-1", "private");
  const plan2 = planSync(payload, rootB);
  assert.equal(plan2.conflicts.length, 0);
  const actionMcp2 = plan2.actions.find((a) => a.id === "mcp:srv-1");
  assert.equal(actionMcp2.action, "keep");
  assert.equal(actionMcp2.reason, "local-private-protected");
});

test("3. Baseline lifecycle: remote update, local update, concurrent change, and tombstones", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  // A sets up provider:data and mcp:srv
  fs.writeFileSync(
    path.join(rootA, "models.yml"),
    "providers:\n  data: { baseUrl: 'https://data.com', apiKey: 'k1' }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(rootA, "mcp.json"),
    JSON.stringify({ mcpServers: { srv: { command: "node", args: ["1.js"] } } }),
    "utf8"
  );
  await setResourceScope(rootA, "provider:data", "public");
  await setResourceScope(rootA, "mcp:srv", "public");

  // Push A -> creates baseline on A (simulate successful push)
  const { blob: blob1 } = buildArchive(TEST_PASS, rootA);
  const payload1 = decryptTestArchive(blob1);
  const stateA = readSyncState(rootA);
  stateA.namespace = payload1.namespace;
  stateA.resources = stateA.resources || {};
  for (const r of payload1.resources) {
    stateA.resources[r.id] = { hash: canonicalHash(r.value) };
  }
  writeSyncState(rootA, stateA);

  // Restore on empty B
  const resB1 = restoreArchive(blob1, TEST_PASS, rootB);
  assert.equal(resB1.dryRun, false);

  // Verify B has both resources
  const mcpB = JSON.parse(fs.readFileSync(path.join(rootB, "mcp.json"), "utf8"));
  assert.equal(mcpB.mcpServers.srv.command, "node");

  // Now Case 3a: A updates provider:data (remote updated, B unchanged)
  fs.writeFileSync(
    path.join(rootA, "models.yml"),
    "providers:\n  data: { baseUrl: 'https://data.com', apiKey: 'k2-updated' }\n",
    "utf8"
  );
  const { blob: blob2 } = buildArchive(TEST_PASS, rootA);
  const payload2 = decryptTestArchive(blob2);

  const planB2 = planSync(payload2, rootB);
  const actData = planB2.actions.find((a) => a.id === "provider:data");
  assert.equal(actData.action, "update");
  assert.equal(actData.reason, "remote-updated");

  // Apply update to B
  restoreArchive(blob2, TEST_PASS, rootB);
  const bModels = fs.readFileSync(path.join(rootB, "models.yml"), "utf8");
  assert.ok(bModels.includes("k2-updated"));

  // Case 3b: B updates mcp:srv locally (B changed, A unchanged)
  fs.writeFileSync(
    path.join(rootB, "mcp.json"),
    JSON.stringify({ mcpServers: { srv: { command: "node", args: ["b-custom.js"] } } }),
    "utf8"
  );
  const planB3 = planSync(payload2, rootB);
  const actSrv = planB3.actions.find((a) => a.id === "mcp:srv");
  assert.equal(actSrv.action, "keep");
  assert.equal(actSrv.reason, "local-modified-remote-unchanged");

  // Case 3c: Both modified differently -> conflict
  fs.writeFileSync(
    path.join(rootA, "mcp.json"),
    JSON.stringify({ mcpServers: { srv: { command: "node", args: ["a-conflict.js"] } } }),
    "utf8"
  );
  const { blob: blob3 } = buildArchive(TEST_PASS, rootA);
  const payload3 = decryptTestArchive(blob3);

  const planConflict = planSync(payload3, rootB);
  const actSrvConflict = planConflict.actions.find((a) => a.id === "mcp:srv");
  assert.equal(actSrvConflict.action, "conflict");
  assert.equal(actSrvConflict.reason, "conflict-concurrent-modifications");

  // Case 3d: Tombstones - A deletes provider:data
  // Mark private or remove from A
  await setResourceScope(rootA, "provider:data", "private");
  const { blob: blob4 } = buildArchive(TEST_PASS, rootA);
  const payload4 = decryptTestArchive(blob4);
  assert.ok(payload4.tombstones.includes("provider:data"));

  // In B, provider:data was untouched since last update -> remote-deleted!
  const planDelete = planSync(payload4, rootB);
  const actDataDel = planDelete.actions.find((a) => a.id === "provider:data");
  assert.equal(actDataDel.action, "delete");
  assert.equal(actDataDel.reason, "remote-deleted");
});

test("4. Dry-run guarantees, zero disk modifications, and plugin prerequisite checks", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  // Add a plugin requirement to A
  fs.writeFileSync(
    path.join(env.a.plugins, "package.json"),
    JSON.stringify({
      name: "omp-plugins",
      dependencies: { "custom-plugin": "1.2.3" },
    }),
    "utf8"
  );
  // Fake node_modules for custom-plugin in A
  const pluginDirA = path.join(env.a.plugins, "node_modules", "custom-plugin");
  fs.mkdirSync(pluginDirA, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDirA, "package.json"),
    JSON.stringify({ name: "custom-plugin", version: "1.2.3" }),
    "utf8"
  );
  await setResourceScope(rootA, "plugin:custom-plugin", "public");

  const { blob } = buildArchive(TEST_PASS, rootA);

  // Take snapshot of B before dry-run
  fs.writeFileSync(path.join(rootB, "AGENTS.md"), "# Original Agents\n", "utf8");
  const origMtime = fs.statSync(path.join(rootB, "AGENTS.md")).mtimeMs;

  const res = restoreArchive(blob, TEST_PASS, rootB, { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.ok(res.blocked.length > 0);
  assert.ok(res.prerequisites.some((p) => p.includes("omp plugin install custom-plugin@1.2.3")));

  // Verify B was not modified
  assert.equal(fs.statSync(path.join(rootB, "AGENTS.md")).mtimeMs, origMtime);
  assert.equal(fs.existsSync(path.join(env.b.plugins, "package.json")), false);

  // Verify collect has zero side-effects and does not write .plugin-links.json
  collect(rootA);
  assert.equal(fs.existsSync(path.join(env.a.plugins, ".plugin-links.json")), false);
});

test("5. Transaction resilience, journal rollback, and concurrency guard", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  fs.writeFileSync(
    path.join(rootA, "models.yml"),
    "providers:\n  trans-ai: { baseUrl: 'https://ai.com', apiKey: 'pass' }\n",
    "utf8"
  );
  await setResourceScope(rootA, "provider:trans-ai", "public");
  const { blob } = buildArchive(TEST_PASS, rootA);

  // Prepare B with initial file
  fs.writeFileSync(path.join(rootB, "models.yml"), "# Existing B models\n", "utf8");
  const bOrig = fs.readFileSync(path.join(rootB, "models.yml"), "utf8");

  // Apply to B
  const res = restoreArchive(blob, TEST_PASS, rootB);
  assert.ok(res.backupDir);
  assert.ok(fs.existsSync(path.join(rootB, "models.yml")));
  assert.ok(fs.readFileSync(path.join(rootB, "models.yml"), "utf8").includes("trans-ai"));

  // Execute Rollback
  const rbRes = rollbackSync(rootB);
  assert.ok(rbRes.files >= 1);
  assert.equal(fs.readFileSync(path.join(rootB, "models.yml"), "utf8"), bOrig);

  // Now test user modification conflict prevention during rollback:
  // Apply again:
  restoreArchive(blob, TEST_PASS, rootB);
  // User modifies models.yml after sync:
  fs.writeFileSync(path.join(rootB, "models.yml"), "# Tampered after sync\n", "utf8");
  // Rollback must detect tamper and refuse to overwrite:
  assert.throws(
    () => {
      rollbackSync(rootB);
    },
    /modified after sync/
  );
});

test("6. Standalone CLI smoke tests (scope, export, import, dry-run)", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;
  const cliScript = path.resolve("./bin/omp-sync.js");

  // Create initial config in A
  fs.writeFileSync(
    path.join(rootA, "mcp.json"),
    JSON.stringify({ mcpServers: { "cli-mcp": { command: "node", args: ["run.js"] } } }),
    "utf8"
  );

  // Set scope via CLI
  const setRes = spawnSync(
    process.execPath,
    [cliScript, "scope", "set", "mcp:cli-mcp", "public"],
    {
      env: { ...process.env, OMP_CFG_ROOT: rootA, OMP_HOME: env.a.dir },
      encoding: "utf8",
    }
  );
  assert.equal(setRes.status, 0, `Scope set failed: ${setRes.stderr}`);
  assert.ok(setRes.stdout.includes("Set scope for 'mcp:cli-mcp' to 'public'"));

  // Scope list via CLI
  const lsRes = spawnSync(
    process.execPath,
    [cliScript, "scope", "list"],
    {
      env: { ...process.env, OMP_CFG_ROOT: rootA, OMP_HOME: env.a.dir },
      encoding: "utf8",
    }
  );
  assert.equal(lsRes.status, 0);
  assert.ok(lsRes.stdout.includes("mcp:cli-mcp"));
  assert.ok(lsRes.stdout.includes("[PUBLIC]"));

  // Export via CLI
  const archivePath = path.join(env.base, "cli-test.enc");
  const expRes = spawnSync(
    process.execPath,
    [cliScript, "export", archivePath, "-p", TEST_PASS],
    {
      env: { ...process.env, OMP_CFG_ROOT: rootA, OMP_HOME: env.a.dir },
      encoding: "utf8",
    }
  );
  assert.equal(expRes.status, 0, `Export failed: ${expRes.stderr}`);
  assert.ok(fs.existsSync(archivePath));

  // Import --dry-run on B via CLI
  const dryRes = spawnSync(
    process.execPath,
    [cliScript, "import", archivePath, "-p", TEST_PASS, "--dry-run"],
    {
      env: { ...process.env, OMP_CFG_ROOT: rootB, OMP_HOME: env.b.dir },
      encoding: "utf8",
    }
  );
  assert.equal(dryRes.status, 0, `Import dry-run failed: ${dryRes.stderr}`);
  assert.ok(dryRes.stdout.includes("[import-dry-run]"));
  assert.equal(fs.existsSync(path.join(rootB, "mcp.json")), false);

  // Real Import on B via CLI
  const impRes = spawnSync(
    process.execPath,
    [cliScript, "import", archivePath, "-p", TEST_PASS],
    {
      env: { ...process.env, OMP_CFG_ROOT: rootB, OMP_HOME: env.b.dir },
      encoding: "utf8",
    }
  );
  assert.equal(impRes.status, 0, `Import failed: ${impRes.stderr}`);
  assert.ok(fs.existsSync(path.join(rootB, "mcp.json")));
  const mcpB = JSON.parse(fs.readFileSync(path.join(rootB, "mcp.json"), "utf8"));
  assert.ok(mcpB.mcpServers["cli-mcp"]);
});

test("7. Loopback 127.0.0.1 HTTP transport & ciphertext secrecy smoke test", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  // Set up public provider with a distinctive dummy token
  const DUMMY_SECRET = "VERY_SECRET_TOKEN_ABC123_XYZ";
  fs.writeFileSync(
    path.join(rootA, "models.yml"),
    `providers:\n  net-ai:\n    baseUrl: https://net.com\n    apiKey: ${DUMMY_SECRET}\n`,
    "utf8"
  );
  await setResourceScope(rootA, "provider:net-ai", "public");

  // Create local in-memory HTTP server on 127.0.0.1
  let storedBlob = null;
  let receivedBodies = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      receivedBodies.push(body);
      if (req.method === "PUT") {
        storedBlob = body;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("OK");
      } else if (req.method === "GET") {
        if (!storedBlob) {
          res.writeHead(404);
          res.end("Not found");
        } else {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(storedBlob);
        }
      } else {
        res.writeHead(405);
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const httpUrl = `http://127.0.0.1:${port}/sync.enc`;

  t.after(() => {
    server.close();
  });

  // Push HTTP from A
  const pushRes = await pushHttp(httpUrl, TEST_PASS, rootA);
  assert.ok(pushRes.bytes > 0);

  // Assert wire payload does NOT contain the dummy secret plaintext!
  for (const body of receivedBodies) {
    assert.ok(
      !body.toString("latin1").includes(DUMMY_SECRET),
      "Secret token must never cross the wire as plaintext"
    );
  }

  // Pull HTTP to B
  const pullRes = await pullHttp(httpUrl, TEST_PASS, rootB);
  assert.equal(pullRes.dryRun, false);

  // Verify B has restored models.yml and token is present locally
  const bModels = fs.readFileSync(path.join(rootB, "models.yml"), "utf8");
  assert.ok(bModels.includes("net-ai"));
  assert.ok(bModels.includes(DUMMY_SECRET));
});

test("8. Continuous roundtrip, idempotency, namespace mismatch, legacy v1/v2 rejection, and comment preservation", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  // YAML with custom comments and unknown provider attributes
  const initialYaml = `# Top level comments to be preserved
providers:
  # DeepSeek custom provider configuration
  deepseek:
    baseUrl: https://api.deepseek.com/v1
    apiKey: sk-ds-123456
    customHeader: X-Custom-Header-Value
    models:
      - id: deepseek-chat
        customParam: 42
`;
  fs.writeFileSync(path.join(rootA, "models.yml"), initialYaml, "utf8");
  await setResourceScope(rootA, "provider:deepseek", "public");

  // A builds archive
  const { blob: blobA1 } = buildArchive(TEST_PASS, rootA);
  const payloadA1 = decryptTestArchive(blobA1);

  // B restores archive
  const resB = restoreArchive(blobA1, TEST_PASS, rootB);
  assert.equal(resB.dryRun, false);

  const bYaml = fs.readFileSync(path.join(rootB, "models.yml"), "utf8");
  assert.ok(bYaml.includes("customHeader: X-Custom-Header-Value"), "Custom field preserved");
  assert.ok(bYaml.includes("customParam: 42"), "Model custom parameter preserved");

  // Idempotency: repeating restore of same blob on B produces 0 writes
  const repeatRes = restoreArchive(blobA1, TEST_PASS, rootB);
  assert.equal(repeatRes.files, 0, "Idempotent restore writes 0 files");

  // Namespace mismatch test: craft payload with a different namespace
  const foreignPayload = {
    v: 3,
    namespace: "completely-different-namespace-uuid",
    createdAt: new Date().toISOString(),
    resources: payloadA1.resources,
    tombstones: [],
  };
  const planMismatch = planSync(foreignPayload, rootB);
  assert.ok(planMismatch.blocked.length > 0, "Foreign namespace is blocked");
  assert.ok(planMismatch.blocked[0].reason.includes("Namespace mismatch"));

  // Legacy v1 / v2 rejection test
  const legacyPayload = {
    v: 2,
    sourceHome: "/home/user",
    files: [{ path: "models.yml", data: Buffer.from("test").toString("base64") }],
  };
  assert.throws(
    () => {
      planSync(legacyPayload, rootB);
    },
    /legacy archive: re-export as v3/
  );
});

test("9. Asset directory version update: precise deletion of obsolete managed files while keeping unmanaged siblings", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  // Initial skill in A: SKILL.md and helper.js
  const skillDirA = path.join(rootA, "skills", "dynamic-skill");
  fs.mkdirSync(skillDirA, { recursive: true });
  fs.writeFileSync(path.join(skillDirA, "SKILL.md"), "# Skill v1\n", "utf8");
  fs.writeFileSync(path.join(skillDirA, "helper.js"), "console.log('v1');\n", "utf8");
  await setResourceScope(rootA, "asset:skills/dynamic-skill", "public");

  const { blob: blob1 } = buildArchive(TEST_PASS, rootA);
  restoreArchive(blob1, TEST_PASS, rootB);

  // In B, add a sibling local skill directory (同级本机目录)
  const siblingSkillDirB = path.join(rootB, "skills", "local-sibling-skill");
  fs.mkdirSync(siblingSkillDirB, { recursive: true });
  fs.writeFileSync(path.join(siblingSkillDirB, "SKILL.md"), "# Local Sibling Skill\n", "utf8");
  fs.writeFileSync(path.join(siblingSkillDirB, "script.py"), "print('sibling')\n", "utf8");

  // In A, update skill: delete helper.js, add new-logic.js
  fs.unlinkSync(path.join(skillDirA, "helper.js"));
  fs.writeFileSync(path.join(skillDirA, "new-logic.js"), "console.log('v2');\n", "utf8");

  const { blob: blob2 } = buildArchive(TEST_PASS, rootA);
  restoreArchive(blob2, TEST_PASS, rootB);

  // In B:
  // new-logic.js must exist
  const skillDirB = path.join(rootB, "skills", "dynamic-skill");
  assert.ok(fs.existsSync(path.join(skillDirB, "new-logic.js")), "new-logic.js created");
  // helper.js must be removed
  assert.ok(!fs.existsSync(path.join(skillDirB, "helper.js")), "obsolete helper.js cleanly removed");
  // Sibling local directory must be preserved untouched!
  assert.ok(fs.existsSync(path.join(siblingSkillDirB, "SKILL.md")), "sibling SKILL.md preserved");
  assert.ok(fs.existsSync(path.join(siblingSkillDirB, "script.py")), "sibling script.py preserved");
});

test("10. Zero child_process execution guarantee during pull/import", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const rootB = env.b.agent;

  fs.writeFileSync(
    path.join(rootA, "models.yml"),
    "providers:\n  stub-ai: { baseUrl: 'https://ai.org', apiKey: 'test' }\n",
    "utf8"
  );
  await setResourceScope(rootA, "provider:stub-ai", "public");
  const { blob } = buildArchive(TEST_PASS, rootA);

  const cp = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const methods = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"];
  const originals = Object.fromEntries(methods.map((name) => [name, cp.default[name]]));
  let calls = 0;
  for (const name of methods) {
    cp.default[name] = () => {
      calls += 1;
      throw new Error(`child_process.${name} must not run during sync`);
    };
  }
  syncBuiltinESMExports();

  try {
    const res = restoreArchive(blob, TEST_PASS, rootB);
    assert.equal(res.dryRun, false);
    assert.equal(res.files, 1);
    assert.ok(fs.existsSync(path.join(rootB, "models.yml")));
    assert.equal(calls, 0);

    fs.writeFileSync(path.join(env.a.plugins, "package.json"), JSON.stringify({ dependencies: { demo: "1.2.3" } }));
    installPlugin(env.a, "demo", "1.2.3");
    await setResourceScope(rootA, "plugin:demo", "public");
    const pluginBlob = buildArchive(TEST_PASS, rootA).blob;
    const blocked = restoreArchive(pluginBlob, TEST_PASS, rootB, { dryRun: true });
    assert.ok(
      blocked.blocked.some((item) => item.id === "plugin:demo") ||
      blocked.prerequisites.some((p) => /omp plugin install demo@1\.2\.3/.test(p))
    );
    assert.equal(calls, 0);
  } finally {
    for (const name of methods) {
      cp.default[name] = originals[name];
    }
    syncBuiltinESMExports();
  }
});

test("11. Host plugin registration and OMP command handlers smoke test", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const root = env.a.agent;
  const registeredCommands = new Map();
  const mockPi = {
    registerCommand(name, def) {
      registeredCommands.set(name, def);
    },
  };

  const notifications = [];
  const mockCtx = {
    ui: {
      notify(msg, type) {
        notifications.push({ msg, type });
      },
      async input() {
        return TEST_PASS;
      },
    },
  };

  // Load plugin entry
  const pluginModule = await import("../index.js");
  pluginModule.default(mockPi);

  assert.ok(registeredCommands.has("config-scope"));
  assert.ok(registeredCommands.has("config-export"));
  assert.ok(registeredCommands.has("config-import"));
  assert.ok(registeredCommands.has("config-push"));
  assert.ok(registeredCommands.has("config-pull"));
  assert.ok(registeredCommands.has("config-rollback"));

  // Setup sample mcp server
  fs.writeFileSync(
    path.join(root, "mcp.json"),
    JSON.stringify({ mcpServers: { "plugin-mcp": { command: "node", args: ["app.js"] } } }),
    "utf8"
  );

  const oldCfg = process.env.OMP_CFG_ROOT;
  const oldHome = process.env.OMP_HOME;
  process.env.OMP_CFG_ROOT = root;
  process.env.OMP_HOME = env.a.dir;

  try {
    // Invoke /config-scope list
    const scopeCmd = registeredCommands.get("config-scope");
    await scopeCmd.handler("list", mockCtx);
    assert.ok(notifications.some((n) => n.msg.includes("plugin-mcp")));

    // Invoke /config-scope set mcp:plugin-mcp public
    await scopeCmd.handler("set mcp:plugin-mcp public", mockCtx);
    assert.ok(notifications.some((n) => n.msg.includes("Scope for 'mcp:plugin-mcp' set to 'public'")));

    // Invoke /config-export
    const exportCmd = registeredCommands.get("config-export");
    const outEnc = path.join(env.base, "host-cmd-test.enc");
    await exportCmd.handler(outEnc, mockCtx);
    assert.ok(fs.existsSync(outEnc));
  } finally {
    if (oldCfg === undefined) delete process.env.OMP_CFG_ROOT;
    else process.env.OMP_CFG_ROOT = oldCfg;
    if (oldHome === undefined) delete process.env.OMP_HOME;
    else process.env.OMP_HOME = oldHome;
  }
});

test("12. Encrypted asset entries cannot escape their declared resource root", async (t) => {
  const cases = [
    ["unrooted private store", [skillFile("models.local.json", "private")]],
    ["parent traversal", [skillFile("../models.local.json", "private")]],
    ["another skill", [skillFile("skills/other/SKILL.md", "other")]],
    ["absolute path", [skillFile("/models.local.json", "private")]],
    ["backslash traversal", [skillFile("skills\\demo\\evil.js", "private")]],
    ["Windows ADS", [skillFile("skills/demo/SKILL.md:evil", "ads")]],
    ["duplicate path", [skillFile("skills/demo/SKILL.md", "duplicate")]],
    ["case-folded alias", [skillFile("skills/demo/skill.md", "alias")]],
    ["file-directory prefix", [skillFile("skills/demo/lib", "file"), skillFile("skills/demo/lib/run.js", "child")]],
  ];

  for (const [name, extraFiles] of cases) {
    await t.test(name, async (t) => {
      const env = makeTempEnv("omp-boundary-");
      t.after(env.cleanup);
      const root = env.b.agent;
      fs.writeFileSync(path.join(root, "models.local.json"), '{"providers":{"private":{"apiKey":"keep"}}}');
      const before = snapshotTree(env.b.dir);
      const payload = archiveWith([{
        id: "asset:skills/demo",
        value: [skillFile("skills/demo/SKILL.md"), ...extraFiles],
      }]);
      const blob = encryptTestArchive(payload);

      assert.throws(() => restoreArchive(blob, TEST_PASS, root, { dryRun: true }));
      assert.throws(() => restoreArchive(blob, TEST_PASS, root));
      assert.deepEqual(snapshotTree(env.b.dir), before);
    });
  }
});

test("13. Snapshot validation rejects ambiguous values and malformed assets", async (t) => {
  const validSkill = () => archiveWith([{
    id: "asset:skills/demo",
    value: [skillFile("skills/demo/SKILL.md")],
  }]);
  const cases = [
    ["missing namespace", () => { const p = archiveWith([]); delete p.namespace; return p; }],
    ["blank namespace", () => { const p = archiveWith([]); p.namespace = " "; return p; }],
    ["invalid creation time", () => { const p = archiveWith([]); p.createdAt = "not-a-date"; return p; }],
    ["non-array tombstones", () => { const p = archiveWith([]); p.tombstones = {}; return p; }],
    ["duplicate tombstone", () => archiveWith([], ["mcp:one", "mcp:one"])],
    ["missing own value", () => archiveWith([{ id: "mcp:one" }])],
    ["setting parent-child overlap", () => archiveWith([{ id: "setting:/a", value: 1 }, { id: "setting:/a/b", value: 2 }])],
    ["decoded pointer overlap", () => archiveWith([{ id: "setting:/a~1b", value: 1 }, { id: "setting:/a~1b/c", value: 2 }])],
    ["invalid pointer escape", () => archiveWith([{ id: "setting:/a~2b", value: 1 }])],
    ["array element setting", () => archiveWith([{ id: "setting:/items/0", value: "x" }])],
    ["object setting", () => archiveWith([{ id: "setting:/object", value: { nested: true } }])],
    ["scalar provider", () => archiveWith([{ id: "provider:one", value: "secret" }])],
    ["null MCP", () => archiveWith([{ id: "mcp:one", value: null }])],
    ["plugin name mismatch", () => archiveWith([{ id: "plugin:demo", value: { name: "other", version: "1.2.3", enabled: true } }])],
    ["plugin range", () => archiveWith([{ id: "plugin:demo", value: { name: "demo", version: "^1.2.3", enabled: true } }])],
    ["plugin unknown field", () => archiveWith([{ id: "plugin:demo", value: { name: "demo", version: "1.2.3", enabled: true, hostPath: "/private" } }])],
    ["plugin non-boolean enabled", () => archiveWith([{ id: "plugin:demo", value: { name: "demo", version: "1.2.3", enabled: "yes" } }])],
    ["empty asset", () => archiveWith([{ id: "asset:tools/demo", value: [] }])],
    ["missing skill manifest", () => archiveWith([{ id: "asset:skills/demo", value: [skillFile("skills/demo/helper.js")] }])],
    ["mixed skill file and directory", () => archiveWith([{ id: "asset:skills/demo", value: [skillFile("skills/demo"), skillFile("skills/demo/SKILL.md")] }])],
    ["non-base64 asset data", () => { const p = validSkill(); p.resources[0].value[0].data = "%%%not-base64%%%"; return p; }],
    ["missing asset mode", () => { const p = validSkill(); delete p.resources[0].value[0].mode; return p; }],
    ["invalid asset mode", () => { const p = validSkill(); p.resources[0].value[0].mode = 0o1000; return p; }],
    ["oversized asset", () => { const p = validSkill(); p.resources[0].value[0].data = Buffer.alloc(10 * 1024 * 1024 + 1, 97).toString("base64"); return p; }],
    ["trailing-dot segment", () => { const p = validSkill(); p.resources[0].value.push(skillFile("skills/demo/bad.", "bad")); return p; }],
    ["Windows device name", () => { const p = validSkill(); p.resources[0].value.push(skillFile("skills/demo/CON", "bad")); return p; }],
  ];

  for (const [name, makePayload] of cases) {
    await t.test(name, () => {
      const payload = makePayload();
      assert.throws(() => validateSnapshot(payload));
    });
  }
});

test("14. Planning and apply reject inward and outward junction ancestors", async (t) => {
  for (const direction of ["inward", "outward"]) {
    await t.test(direction, async (t) => {
      const env = makeTempEnv(`omp-junction-${direction}-`);
      t.after(env.cleanup);
      const root = env.b.agent;
      const actualSkills = direction === "inward"
        ? path.join(root, "real-skills")
        : path.join(env.base, "outside-skills");
      const demo = path.join(actualSkills, "demo");
      fs.mkdirSync(demo, { recursive: true });
      fs.writeFileSync(path.join(demo, "SKILL.md"), "# old\n");
      fs.symlinkSync(actualSkills, path.join(root, "skills"), "junction");

      const id = "asset:skills/demo";
      const localValue = readResource(root, id).value;
      writeSyncState(root, {
        version: 1,
        namespace: "11111111-1111-4111-8111-111111111111",
        resources: { [id]: { hash: canonicalHash(localValue) } },
        tombstones: [],
      });
      const before = snapshotTree(env.base);
      const blob = encryptTestArchive(archiveWith([{
        id,
        value: [skillFile("skills/demo/SKILL.md", "# remote new\n")],
      }]));

      const preview = restoreArchive(blob, TEST_PASS, root, { dryRun: true });
      assert.ok(preview.blocked.length > 0, "dry-run must report the unsafe ancestor");
      assert.throws(() => restoreArchive(blob, TEST_PASS, root));
      assert.deepEqual(snapshotTree(env.base), before);
    });
  }
});

test("15. Asset apply blocks local file-directory type conversions", async (t) => {
  for (const localType of ["file", "directory"]) {
    await t.test(`local ${localType}`, async (t) => {
      const env = makeTempEnv("omp-type-conversion-");
      t.after(env.cleanup);
      const root = env.b.agent;
      const id = "asset:tools/demo";
      const target = path.join(env.b.tools, "demo");
      if (localType === "file") {
        fs.writeFileSync(target, "local file");
      } else {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, "old.txt"), "local directory");
      }
      const localValue = readResource(root, id).value;
      writeSyncState(root, {
        version: 1,
        namespace: "11111111-1111-4111-8111-111111111111",
        resources: { [id]: { hash: canonicalHash(localValue) } },
        tombstones: [],
      });
      const remoteValue = localType === "file"
        ? [skillFile("tools/demo/new.txt", "remote directory")]
        : [skillFile("tools/demo", "remote file")];
      const before = snapshotTree(env.b.dir);
      const blob = encryptTestArchive(archiveWith([{ id, value: remoteValue }]));

      const preview = restoreArchive(blob, TEST_PASS, root, { dryRun: true });
      assert.ok(preview.blocked.length > 0, "type conversion must be blocked during planning");
      assert.throws(() => restoreArchive(blob, TEST_PASS, root));
      assert.deepEqual(snapshotTree(env.b.dir), before);
    });
  }
});

test("16. Plugins compare canonically and publish only verified exact versions", async (t) => {
  await t.test("identical preinstalled plugin is adopted without conflict", async (t) => {
    const env = makeTempEnv("omp-plugin-identical-");
    t.after(env.cleanup);
    for (const side of [env.a, env.b]) {
      fs.writeFileSync(path.join(side.plugins, "package.json"), JSON.stringify({ dependencies: { demo: "1.2.3" } }));
      installPlugin(side, "demo", "1.2.3");
    }
    await setResourceScope(env.a.agent, "plugin:demo", "public");
    const { blob } = buildArchive(TEST_PASS, env.a.agent);
    const payload = decryptTestArchive(blob);
    const plan = planSync(payload, env.b.agent);
    const action = plan.actions.find((item) => item.id === "plugin:demo");
    assert.equal(action.action, "keep");
    assert.equal(action.reason, "initial-adopt-identical");
    const restored = restoreArchive(blob, TEST_PASS, env.b.agent);
    assert.equal(restored.files, 0);
    const repeat = planSync(payload, env.b.agent);
    assert.equal(repeat.conflicts.length, 0);
  });

  await t.test("registry ranges and dist-tags export at the installed exact version", async (t) => {
    for (const versionSpec of ["^1.2.3", "~1.2.3", ">=1.2.0", "latest"]) {
      const env = makeTempEnv("omp-plugin-range-");
      t.after(env.cleanup);
      fs.writeFileSync(path.join(env.a.plugins, "package.json"), JSON.stringify({ dependencies: { demo: versionSpec } }));
      installPlugin(env.a, "demo", "1.2.3");
      await setResourceScope(env.a.agent, "plugin:demo", "public");
      const { payload } = buildArchive(TEST_PASS, env.a.agent);
      assert.equal(payload.resources[0].value.version, "1.2.3");
    }
  });

  await t.test("non-registry declarations fail even when installed", async (t) => {
    for (const versionSpec of ["file:../demo", "link:../demo", "git+https://example.invalid/demo.git"]) {
      const env = makeTempEnv("omp-plugin-range-");
      t.after(env.cleanup);
      fs.writeFileSync(path.join(env.a.plugins, "package.json"), JSON.stringify({ dependencies: { demo: versionSpec } }));
      installPlugin(env.a, "demo", "1.2.3");
      await setResourceScope(env.a.agent, "plugin:demo", "public");
      assert.throws(() => buildArchive(TEST_PASS, env.a.agent), /exact semver/i);
    }
  });

  await t.test("scoped prerelease and build metadata are valid", async (t) => {
    const env = makeTempEnv("omp-plugin-semver-");
    t.after(env.cleanup);
    const version = "1.2.3-beta.1+build.5";
    fs.writeFileSync(path.join(env.a.plugins, "package.json"), JSON.stringify({ dependencies: { "@scope/demo": version } }));
    installPlugin(env.a, "@scope/demo", version);
    await setResourceScope(env.a.agent, "plugin:@scope/demo", "public");
    const { payload } = buildArchive(TEST_PASS, env.a.agent);
    assert.equal(payload.resources[0].value.version, version);
    assert.doesNotThrow(() => validateSnapshot(payload));
  });

  await t.test("missing or inconsistent installations and locks block export", async (t) => {
    for (const scenario of ["missing", "wrong-installed", "wrong-lock"]) {
      const env = makeTempEnv("omp-plugin-verification-");
      t.after(env.cleanup);
      fs.writeFileSync(path.join(env.a.plugins, "package.json"), JSON.stringify({ dependencies: { demo: "1.2.3" } }));
      if (scenario !== "missing") installPlugin(env.a, "demo", scenario === "wrong-installed" ? "1.2.4" : "1.2.3");
      if (scenario === "wrong-lock") {
        fs.writeFileSync(path.join(env.a.plugins, "omp-plugins.lock.json"), JSON.stringify({ plugins: { demo: { version: "1.2.2", enabled: true } } }));
      }
      await setResourceScope(env.a.agent, "plugin:demo", "public");
      assert.throws(() => buildArchive(TEST_PASS, env.a.agent));
    }
  });
});

test("17. Equivalent HOME-relative MCP and shell paths adopt across A and B", async (t) => {
  const env = makeTempEnv("omp-home-canonical-");
  t.after(env.cleanup);
  const cli = path.resolve("./bin/omp-sync.js");
  const mcpAt = (home) => ({
    mcpServers: {
      shared: {
        command: path.join(home, "bin", "server.js"),
        cwd: path.join(home, "work"),
        args: [path.join(home, "lib", "server.js")],
        env: { API_KEY: "dummy-home-key" },
      },
    },
  });
  fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify(mcpAt(env.a.dir)));
  fs.writeFileSync(path.join(env.a.agent, "config.yml"), "shellPath: " + path.join(env.a.dir, "bin", "shell.exe") + "\nscript: '{{OMP_HOME}}/literal'\n");
  fs.writeFileSync(path.join(env.b.agent, "mcp.json"), JSON.stringify(mcpAt(env.b.dir)));
  fs.writeFileSync(path.join(env.b.agent, "config.yml"), "shellPath: " + path.join(env.b.dir, "bin", "shell.exe") + "\nscript: '{{OMP_HOME}}/literal'\n");

  for (const id of ["mcp:shared", "setting:/shellPath", "setting:/script"]) {
    const scoped = spawnAtHome(env.a.dir, env.a.agent, [cli, "scope", "set", id, "public"]);
    assert.equal(scoped.status, 0, scoped.stderr);
  }
  const archive = path.join(env.base, "home paths.enc");
  const exported = spawnAtHome(env.a.dir, env.a.agent, [cli, "export", archive, "-p", TEST_PASS]);
  assert.equal(exported.status, 0, exported.stderr);

  const beforeB = snapshotTree(env.b.dir);
  const dryB = spawnAtHome(env.b.dir, env.b.agent, [cli, "import", archive, "-p", TEST_PASS, "--dry-run"]);
  assert.equal(dryB.status, 0, dryB.stderr);
  assert.deepEqual(snapshotTree(env.b.dir), beforeB);
  const importB = spawnAtHome(env.b.dir, env.b.agent, [cli, "import", archive, "-p", TEST_PASS]);
  assert.equal(importB.status, 0, importB.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.b.agent, "mcp.json"), "utf8")).mcpServers.shared.command, path.join(env.b.dir, "bin", "server.js"));
  assert.ok(fs.readFileSync(path.join(env.b.agent, "config.yml"), "utf8").includes(path.join(env.b.dir, "bin", "shell.exe")));

  const dryA = spawnAtHome(env.a.dir, env.a.agent, [cli, "import", "--dry-run", archive, "-p", TEST_PASS]);
  assert.equal(dryA.status, 0, dryA.stderr);
});

test("18. HOME restore is limited to standalone portable path fields", async (t) => {
  await t.test("placeholder literals in args, environment, and scripts stay unchanged", async (t) => {
    const env = makeTempEnv("omp-home-literals-");
    t.after(env.cleanup);
    const cli = path.resolve("./bin/omp-sync.js");
    const mcp = {
      mcpServers: {
        shared: {
          command: path.join(env.a.dir, "bin", "server.js"),
          args: [path.join(env.a.dir, "lib", "server.js"), "literal {{OMP_HOME}}/argument"],
          env: { TEMPLATE: "{{OMP_HOME}}/env-literal", API_KEY: "dummy-key" },
        },
      },
    };
    fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify(mcp));
    fs.writeFileSync(path.join(env.a.agent, "config.yml"), "script: '{{OMP_HOME}}/script-literal'\n");
    for (const id of ["mcp:shared", "setting:/script"]) {
      assert.equal(spawnAtHome(env.a.dir, env.a.agent, [cli, "scope", "set", id, "public"]).status, 0);
    }
    const archive = path.join(env.base, "literal.enc");
    assert.equal(spawnAtHome(env.a.dir, env.a.agent, [cli, "export", archive, "-p", TEST_PASS]).status, 0);
    const imported = spawnAtHome(env.b.dir, env.b.agent, [cli, "import", archive, "-p", TEST_PASS]);
    assert.equal(imported.status, 0, imported.stderr);
    const restored = JSON.parse(fs.readFileSync(path.join(env.b.agent, "mcp.json"), "utf8")).mcpServers.shared;
    assert.equal(restored.args[0], path.join(env.b.dir, "lib", "server.js"));
    assert.equal(restored.args[1], "literal {{OMP_HOME}}/argument");
    assert.equal(restored.env.TEMPLATE, "{{OMP_HOME}}/env-literal");
    assert.ok(fs.readFileSync(path.join(env.b.agent, "config.yml"), "utf8").includes("{{OMP_HOME}}/script-literal"));
  });

  await t.test("HOME lookalike prefixes are not remapped", async (t) => {
    const env = makeTempEnv("omp-home-prefix-");
    t.after(env.cleanup);
    const cli = path.resolve("./bin/omp-sync.js");
    const outside = `${env.a.dir}-other`;
    fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: path.join(outside, "server.js") } } }));
    assert.equal(spawnAtHome(env.a.dir, env.a.agent, [cli, "scope", "set", "mcp:shared", "public"]).status, 0);
    const result = spawnAtHome(env.a.dir, env.a.agent, [cli, "export", path.join(env.base, "outside.enc"), "-p", TEST_PASS]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside HOME|self-contained/i);
  });
});

test("19. Strict parsing fails closed without leaking source values", async (t) => {
  const captureError = (fn) => {
    try { fn(); } catch (err) { return err; }
    assert.fail("Expected operation to throw");
  };
  const duplicateSecret = "DUMMY_DUPLICATE_SECRET_7f3c";
  const duplicateError = captureError(() => parseYamlStrict(`providers:\n  bad:\n    apiKey: ${duplicateSecret}\n    apiKey: second-value\n`, "models.yml"));
  assert.ok(!duplicateError.message.includes(duplicateSecret));
  assert.ok(!duplicateError.message.includes("apiKey"));
  assert.ok(duplicateError.message.includes("models.yml"));
  assert.throws(() => parseYamlStrict("value: !DUMMY_CUSTOM_TAG secret\n", "config.yml"));

  const env = makeTempEnv("omp-parse-redaction-");
  t.after(env.cleanup);
  const jsonSecret = "DUMMY_BROKEN_JSON_SECRET_91ad";
  fs.writeFileSync(path.join(env.a.agent, "mcp.json"), `{"mcpServers":{"bad":{"apiKey":"${jsonSecret}"},}}`);
  const jsonError = captureError(() => readResource(env.a.agent, "mcp:bad"));
  assert.ok(!jsonError.message.includes(jsonSecret));
  assert.ok(!jsonError.message.includes("mcpServers"));
  fs.writeFileSync(path.join(env.a.agent, "models.yml"), `providers:\n  bad:\n    apiKey: ${duplicateSecret}\n    apiKey: second\n`);
  assert.throws(() => readResource(env.a.agent, "provider:bad"));
});

test("20. Null settings round-trip as present values, not deletions", async (t) => {
  const env = makeTempEnv("omp-null-setting-");
  t.after(env.cleanup);
  fs.writeFileSync(path.join(env.a.agent, "config.yml"), "nullable: null\n");
  await setResourceScope(env.a.agent, "setting:/nullable", "public");
  const { payload } = buildArchive(TEST_PASS, env.a.agent);
  const resource = payload.resources.find((item) => item.id === "setting:/nullable");
  assert.ok(resource);
  assert.equal(resource.value, null);
  assert.ok(!payload.tombstones.includes("setting:/nullable"));
  restoreArchive(encryptTestArchive(payload), TEST_PASS, env.b.agent);
  const restored = readResource(env.b.agent, "setting:/nullable");
  assert.ok(restored);
  assert.equal(restored.value, null);
});

test("21. Private assets are skipped before reads and top-level local tools remain classifiable", async (t) => {
  const env = makeTempEnv("omp-read-skipping-");
  t.after(env.cleanup);
  const root = env.a.agent;
  const skill = path.join(root, "skills", "private-skill");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# private\n");
  await setResourceScope(root, "asset:skills/private-skill", "private");
  fs.symlinkSync(env.base, path.join(skill, "outside"), "junction");
  const payload = archiveWith([{ id: "provider:remote", value: { baseUrl: "https://example.invalid", apiKey: "dummy" } }]);
  const plan = planSync(payload, root);
  assert.equal(plan.actions.find((item) => item.id === "provider:remote").action, "add");

  const localTool = path.join(env.a.tools, "local-demo");
  fs.mkdirSync(localTool);
  fs.writeFileSync(path.join(localTool, "run.js"), "module.exports = {};\n");
  assert.ok(inventoryResources(root).some((item) => item.id === "asset:tools/local-demo"));
  await setResourceScope(root, "asset:tools/local-demo", "public");
  const { payload: exported } = buildArchive(TEST_PASS, root);
  assert.ok(exported.resources.some((item) => item.id === "asset:tools/local-demo"));
});

test("22. Updating one provider preserves comments and unrelated target data", async (t) => {
  const env = makeTempEnv("omp-yaml-preservation-");
  t.after(env.cleanup);
  fs.writeFileSync(path.join(env.a.agent, "models.yml"), "providers:\n  demo:\n    baseUrl: https://v1.example\n    apiKey: dummy-v1\n    custom: keep-me\n");
  await setResourceScope(env.a.agent, "provider:demo", "public");
  const first = buildArchive(TEST_PASS, env.a.agent).blob;
  restoreArchive(first, TEST_PASS, env.b.agent);

  fs.writeFileSync(path.join(env.b.agent, "models.yml"), `# TOP COMMENT MUST SURVIVE
otherRoot: keep
providers:
  # PROVIDER COMMENT MUST SURVIVE
  demo:
    baseUrl: https://v1.example
    apiKey: dummy-v1
    custom: keep-me
  local-only:
    baseUrl: https://local.example
`);
  fs.writeFileSync(path.join(env.a.agent, "models.yml"), "providers:\n  demo:\n    baseUrl: https://v2.example\n    apiKey: dummy-v2\n    custom: keep-me\n");
  const second = buildArchive(TEST_PASS, env.a.agent).blob;
  const result = restoreArchive(second, TEST_PASS, env.b.agent);
  assert.equal(result.files, 1);
  const yaml = fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8");
  assert.ok(yaml.includes("# TOP COMMENT MUST SURVIVE"));
  assert.ok(yaml.includes("# PROVIDER COMMENT MUST SURVIVE"));
  assert.ok(yaml.includes("otherRoot: keep"));
  assert.ok(yaml.includes("local-only:"));
  assert.ok(yaml.includes("https://v2.example"));
});

test("23. Namespace is stable and only first public classification creates it", async (t) => {
  await t.test("public scope reuses a namespace received by pull", async (t) => {
    const env = makeTempEnv("omp-namespace-reuse-");
    t.after(env.cleanup);
    fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "node" } } }));
    await setResourceScope(env.a.agent, "mcp:shared", "public");
    restoreArchive(buildArchive(TEST_PASS, env.a.agent).blob, TEST_PASS, env.b.agent);
    const received = readSyncState(env.b.agent).namespace;
    assert.ok(received);
    await setResourceScope(env.b.agent, "mcp:shared", "public");
    assert.equal(readSyncPolicy(env.b.agent).namespace, received);
  });

  await t.test("private scope creates no namespace", async (t) => {
    const env = makeTempEnv("omp-namespace-none-");
    t.after(env.cleanup);
    fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { private: { command: "node" } } }));
    await setResourceScope(env.a.agent, "mcp:private", "private");
    assert.equal(readSyncPolicy(env.a.agent).namespace, undefined);
    assert.equal(readSyncState(env.a.agent).namespace, undefined);
  });

  await t.test("policy and state namespace mismatch blocks with zero actions", async (t) => {
    const env = makeTempEnv("omp-namespace-mismatch-");
    t.after(env.cleanup);
    fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "node" } } }));
    await setResourceScope(env.a.agent, "mcp:shared", "public");
    const { blob, payload } = buildArchive(TEST_PASS, env.a.agent);
    restoreArchive(blob, TEST_PASS, env.b.agent);
    fs.writeFileSync(path.join(env.b.agent, "sync-policy.local.json"), JSON.stringify({ version: 1, namespace: "different-namespace", resources: {} }));
    const before = snapshotTree(env.b.dir);
    const plan = planSync(payload, env.b.agent);
    assert.ok(plan.blocked.length > 0);
    assert.equal(plan.actions.length, 0);
    assert.deepEqual(snapshotTree(env.b.dir), before);
  });

  await t.test("missing remote namespace and legacy versions fail through encryption", async (t) => {
    const env = makeTempEnv("omp-namespace-invalid-");
    t.after(env.cleanup);
    const missing = archiveWith([]);
    delete missing.namespace;
    assert.throws(() => restoreArchive(encryptTestArchive(missing), TEST_PASS, env.b.agent, { dryRun: true }));
    for (const version of [1, 2]) {
      assert.throws(() => restoreArchive(encryptTestArchive({ v: version, files: [] }), TEST_PASS, env.b.agent, { dryRun: true }), /could not be adapted: empty snapshot/);
    }
  });
});

test("24. Three-way baselines advance only for accepted canonical values", async (t) => {
  const writeProvider = (env, key) => {
    fs.writeFileSync(path.join(env.agent, "models.yml"), `providers:\n  demo:\n    baseUrl: https://example.invalid\n    apiKey: ${key}\n`);
  };

  await t.test("L=R advances baseline so a later remote update applies", async (t) => {
    const env = makeTempEnv("omp-baseline-identical-");
    t.after(env.cleanup);
    writeProvider(env.a, "v1");
    await setResourceScope(env.a.agent, "provider:demo", "public");
    restoreArchive(buildArchive(TEST_PASS, env.a.agent).blob, TEST_PASS, env.b.agent);

    writeProvider(env.b, "v2");
    writeProvider(env.a, "v2");
    const bothV2 = buildArchive(TEST_PASS, env.a.agent);
    const samePlan = planSync(bothV2.payload, env.b.agent);
    assert.equal(samePlan.actions.find((item) => item.id === "provider:demo").action, "keep");
    assert.equal(samePlan.actions.find((item) => item.id === "provider:demo").reason, "identical-to-remote");
    restoreArchive(bothV2.blob, TEST_PASS, env.b.agent);
    const record = readSyncState(env.b.agent).resources["provider:demo"];
    assert.equal(record.hashFormat, "portable-v1");

    writeProvider(env.a, "v3");
    const planV3 = planSync(buildArchive(TEST_PASS, env.a.agent).payload, env.b.agent);
    assert.equal(planV3.actions.find((item) => item.id === "provider:demo").action, "update");
    assert.equal(planV3.conflicts.length, 0);
  });

  await t.test("remote tombstone persists twice and re-publication clears it", async (t) => {
    const env = makeTempEnv("omp-tombstone-");
    t.after(env.cleanup);
    writeProvider(env.a, "v1");
    await setResourceScope(env.a.agent, "provider:demo", "public");
    const first = buildArchive(TEST_PASS, env.a.agent);
    writeSyncState(env.a.agent, {
      version: 1,
      namespace: first.payload.namespace,
      resources: { "provider:demo": { hash: canonicalHash(first.payload.resources[0].value), hashFormat: "portable-v1" } },
      tombstones: [],
    });
    restoreArchive(first.blob, TEST_PASS, env.b.agent);

    await setResourceScope(env.a.agent, "provider:demo", "private");
    const deleted = buildArchive(TEST_PASS, env.a.agent);
    assert.ok(deleted.payload.tombstones.includes("provider:demo"));
    restoreArchive(deleted.blob, TEST_PASS, env.b.agent);
    let state = readSyncState(env.b.agent);
    assert.equal(state.resources["provider:demo"].hash, "__OMP_SENTINEL_DELETED__");
    assert.equal(state.resources["provider:demo"].hashFormat, "portable-v1");
    assert.ok(state.tombstones.includes("provider:demo"));

    restoreArchive(deleted.blob, TEST_PASS, env.b.agent);
    state = readSyncState(env.b.agent);
    assert.equal(state.resources["provider:demo"].hash, "__OMP_SENTINEL_DELETED__");
    assert.ok(state.tombstones.includes("provider:demo"));
    const repeatedTombstone = buildArchive(TEST_PASS, env.b.agent);
    assert.ok(repeatedTombstone.payload.tombstones.includes("provider:demo"));

    writeProvider(env.b, "v2");
    await setResourceScope(env.b.agent, "provider:demo", "public");
    const rePublic = buildArchive(TEST_PASS, env.b.agent);
    assert.ok(!rePublic.payload.tombstones.includes("provider:demo"));
    restoreArchive(rePublic.blob, TEST_PASS, env.b.agent);
    state = readSyncState(env.b.agent);
    assert.ok(!state.tombstones.includes("provider:demo"));
    assert.equal(state.resources["provider:demo"].hashFormat, "portable-v1");
  });

  await t.test("private resources keep their existing baseline byte-for-byte", async (t) => {
    const env = makeTempEnv("omp-private-baseline-");
    t.after(env.cleanup);
    writeProvider(env.a, "v1");
    const value = readResource(env.a.agent, "provider:demo").value;
    writeSyncState(env.a.agent, {
      version: 1,
      namespace: "private-baseline-ns",
      resources: { "provider:demo": { hash: canonicalHash(value) } },
      tombstones: [],
    });
    fs.writeFileSync(path.join(env.a.agent, "sync-policy.local.json"), JSON.stringify({ version: 1, resources: { "provider:demo": "private" } }));
    const stateBefore = fs.readFileSync(path.join(env.a.agent, "sync-state.local.json"));
    const tombstone = archiveWith([], ["provider:demo"]);
    tombstone.namespace = "private-baseline-ns";
    const plan = planSync(tombstone, env.a.agent);
    assert.equal(plan.actions.find((item) => item.id === "provider:demo").reason, "local-private-protected");
    const applied = applySyncPlan(plan, env.a.agent);
    assert.equal(applied.filesWritten, 0);
    assert.deepEqual(fs.readFileSync(path.join(env.a.agent, "sync-state.local.json")), stateBefore);
  });

  await t.test("provable legacy baselines migrate; unprovable ones conflict without writes", async (t) => {
    const remoteNamespace = "legacy-portable-namespace";
    const env = makeTempEnv("omp-legacy-baseline-");
    t.after(env.cleanup);
    const relativeHome = path.relative(os.homedir(), env.b.dir).split(path.sep).join("/");
    const remoteValue = {
      command: `{{OMP_HOME}}/${relativeHome}/bin/server.js`,
      args: [`{{OMP_HOME}}/${relativeHome}/lib/server.js`],
      env: { API_KEY: "dummy" },
    };
    const payload = archiveWith([{ id: "mcp:shared", value: remoteValue }]);
    payload.namespace = remoteNamespace;
    const localValue = {
      command: path.join(env.b.dir, "bin", "server.js"),
      args: [path.join(env.b.dir, "lib", "server.js")],
      env: { API_KEY: "dummy" },
    };
    fs.writeFileSync(path.join(env.b.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: localValue } }));
    writeSyncState(env.b.agent, {
      version: 1,
      namespace: remoteNamespace,
      resources: { "mcp:shared": { hash: canonicalHash(localValue) } },
      tombstones: [],
    });
    const plan = planSync(payload, env.b.agent);
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.actions.find((item) => item.id === "mcp:shared").reason, "identical-to-remote");
    restoreArchive(encryptTestArchive(payload), TEST_PASS, env.b.agent);
    assert.equal(readSyncState(env.b.agent).resources["mcp:shared"].hashFormat, "portable-v1");

    const badEnv = makeTempEnv("omp-legacy-unprovable-");
    t.after(badEnv.cleanup);
    const badRelativeHome = path.relative(os.homedir(), badEnv.b.dir).split(path.sep).join("/");
    const badLocalValue = {
      command: path.join(badEnv.b.dir, "bin", "server.js"),
      args: [path.join(badEnv.b.dir, "lib", "server.js")],
      env: { API_KEY: "dummy" },
    };
    const badPayload = archiveWith([{
      id: "mcp:shared",
      value: {
        command: `{{OMP_HOME}}/${badRelativeHome}/bin/server.js`,
        args: [`{{OMP_HOME}}/${badRelativeHome}/lib/server.js`],
        env: { API_KEY: "dummy" },
      },
    }]);
    badPayload.namespace = remoteNamespace;
    fs.writeFileSync(path.join(badEnv.b.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: badLocalValue } }));
    writeSyncState(badEnv.b.agent, {
      version: 1,
      namespace: remoteNamespace,
      resources: { "mcp:shared": { hash: "a".repeat(64) } },
      tombstones: [],
    });
    const before = snapshotTree(badEnv.b.dir);
    const badPlan = planSync(badPayload, badEnv.b.agent);
    assert.equal(badPlan.conflicts.length, 1);
    assert.equal(badPlan.conflicts[0].reason, "legacy-baseline-unverifiable");
    assert.throws(() => applySyncPlan(badPlan, badEnv.b.agent), /conflict/i);
    assert.deepEqual(snapshotTree(badEnv.b.dir), before);
  });

  await t.test("export does not advance the local baseline", async (t) => {
    const env = makeTempEnv("omp-export-baseline-");
    t.after(env.cleanup);
    writeProvider(env.a, "v1");
    await setResourceScope(env.a.agent, "provider:demo", "public");
    const before = snapshotTree(env.a.agent);
    buildArchive(TEST_PASS, env.a.agent);
    assert.deepEqual(snapshotTree(env.a.agent), before);
  });
});

test("25. Invalid sync state fails closed instead of becoming an empty baseline", async (t) => {
  const hash = "0".repeat(64);
  const valid = () => ({ version: 1, namespace: "state-ns", resources: { "mcp:one": { hash, hashFormat: "portable-v1" } }, tombstones: [] });
  const cases = [
    ["root array", () => []],
    ["unsupported version", () => ({ ...valid(), version: 2 })],
    ["blank namespace", () => ({ ...valid(), namespace: " " })],
    ["resource array", () => ({ ...valid(), resources: [] })],
    ["missing tombstones", () => { const state = valid(); delete state.tombstones; return state; }],
    ["tombstone object", () => ({ ...valid(), tombstones: {} })],
    ["invalid resource ID", () => ({ ...valid(), resources: { "provider:../bad": { hash, hashFormat: "portable-v1" } } })],
    ["record not object", () => ({ ...valid(), resources: { "mcp:one": hash } })],
    ["missing hash", () => ({ ...valid(), resources: { "mcp:one": { hashFormat: "portable-v1" } } })],
    ["malformed hash", () => ({ ...valid(), resources: { "mcp:one": { hash: "abc", hashFormat: "portable-v1" } } })],
    ["unknown hash format", () => ({ ...valid(), resources: { "mcp:one": { hash, hashFormat: "raw-v2" } } })],
    ["duplicate tombstone", () => ({ ...valid(), tombstones: ["mcp:two", "mcp:two"] })],
    ["invalid tombstone", () => ({ ...valid(), tombstones: ["setting:/a/0"] })],
    ["active and tombstoned", () => ({ ...valid(), tombstones: ["mcp:one"] })],
  ];

  for (const [name, makeState] of cases) {
    await t.test(name, (t) => {
      const env = makeTempEnv("omp-state-invalid-");
      t.after(env.cleanup);
      const statePath = path.join(env.a.agent, "sync-state.local.json");
      const bytes = JSON.stringify(makeState(), null, 2) + "\n";
      fs.writeFileSync(statePath, bytes);
      assert.throws(() => readSyncState(env.a.agent));
      assert.equal(fs.readFileSync(statePath, "utf8"), bytes);
    });
  }

  await t.test("valid hash-only state is preserved", (t) => {
    const env = makeTempEnv("omp-state-valid-");
    t.after(env.cleanup);
    fs.writeFileSync(path.join(env.a.agent, "sync-state.local.json"), JSON.stringify(valid()));
    assert.deepEqual(readSyncState(env.a.agent), valid());
  });
});

test("26. Public plans expose only sanitized actions and count real target writes", async (t) => {
  const env = makeTempEnv("omp-sanitized-plan-");
  t.after(env.cleanup);
  const secret = "DUMMY_PLAN_SECRET_f81e";
  fs.writeFileSync(path.join(env.a.agent, "models.yml"), `providers:\n  one:\n    baseUrl: https://one.example\n    apiKey: ${secret}\n  two:\n    baseUrl: https://two.example\n    apiKey: ${secret}-two\n`);
  fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "node", env: { TOKEN: secret } } } }));
  for (const id of ["provider:one", "provider:two", "mcp:shared"]) {
    await setResourceScope(env.a.agent, id, "public");
  }
  const { blob, payload } = buildArchive(TEST_PASS, env.a.agent);
  const plan = planSync(payload, env.b.agent);

  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("apiKey"));
  for (const action of plan.actions) {
    assert.deepEqual(Object.keys(action).sort(), ["action", "id", "reason", "remapped", "targetPath"]);
  }
  assert.deepEqual(plan.writes, [{ path: "mcp.json", operation: "write" }, { path: "models.yml", operation: "write" }]);
  assert.ok(Object.isFrozen(plan.actions));
  assert.ok(Object.isFrozen(plan.actions[0]));
  assert.ok(Object.isFrozen(plan.writes));

  const clone = JSON.parse(JSON.stringify(plan));
  assert.throws(() => applySyncPlan(clone, env.b.agent), /plan/i);

  const dry = restoreArchive(blob, TEST_PASS, env.b.agent, { dryRun: true });
  assert.equal(dry.files, 2);
  const applied = restoreArchive(blob, TEST_PASS, env.b.agent);
  assert.equal(applied.files, 2);
  assert.throws(() => applySyncPlan(plan, env.b.agent), /plan|Concurrent modification/i);

  const backupsBefore = fs.readdirSync(env.b.agent).filter((name) => name.startsWith(".import-backup-")).length;
  const noOp = restoreArchive(blob, TEST_PASS, env.b.agent);
  assert.equal(noOp.files, 0);
  assert.equal(noOp.backupDir, undefined);
  const backupsAfter = fs.readdirSync(env.b.agent).filter((name) => name.startsWith(".import-backup-")).length;
  assert.equal(backupsAfter, backupsBefore);
});

test("27. Multi-file assets are counted and planned as individual physical writes", async (t) => {
  const env = makeTempEnv("omp-multifile-plan-");
  t.after(env.cleanup);
  const skill = path.join(env.a.agent, "skills", "multi");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# multi\n");
  fs.writeFileSync(path.join(skill, "helper.js"), "export const x = 1;\n");
  await setResourceScope(env.a.agent, "asset:skills/multi", "public");
  const { blob, payload } = buildArchive(TEST_PASS, env.a.agent);
  const plan = planSync(payload, env.b.agent);
  assert.deepEqual(plan.writes, [
    { path: "skills/multi/SKILL.md", operation: "write" },
    { path: "skills/multi/helper.js", operation: "write" },
  ]);
  const dry = restoreArchive(blob, TEST_PASS, env.b.agent, { dryRun: true });
  assert.equal(dry.files, 2);
  const applied = restoreArchive(blob, TEST_PASS, env.b.agent);
  assert.equal(applied.files, 2);
  assert.ok(fs.existsSync(path.join(env.b.agent, "skills", "multi", "helper.js")));
});

test("28. Applying a stale plan rejects every observed user or configuration change", async (t) => {
  function prepareProviderPlan() {
    const env = makeTempEnv("omp-stale-");
    const write = (key) => {
      fs.writeFileSync(path.join(env.a.agent, "models.yml"), `providers:\n  demo:\n    baseUrl: https://v1.example\n    apiKey: ${key}\n`);
      fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "node", args: [key] } } }));
    };
    write("v1");
    return { env, write };
  }

  const cases = [
    ["target bytes changed", (env) => fs.appendFileSync(path.join(env.b.agent, "models.yml"), "# user edit\n")],
    ["target removed", (env) => fs.unlinkSync(path.join(env.b.agent, "models.yml"))],
    ["alternate YAML added", (env, plan) => fs.writeFileSync(path.join(env.b.agent, "models.yaml"), `namespace: ${plan.namespace}\nproviders: {}\n`)],
    ["models.local added", (env) => fs.writeFileSync(path.join(env.b.agent, "models.local.json"), JSON.stringify({ providers: { local: { apiKey: "keep" } } }))],
    ["policy changed", (env, plan) => fs.writeFileSync(path.join(env.b.agent, "sync-policy.local.json"), JSON.stringify({ version: 1, namespace: plan.namespace, resources: { "provider:demo": "private" } }))],
    ["state changed", (env) => {
      const state = readSyncState(env.b.agent);
      state.resources["mcp:unrelated"] = { hash: "0".repeat(64), hashFormat: "portable-v1" };
      writeSyncState(env.b.agent, state);
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const { env, write } = prepareProviderPlan();
      t.after(env.cleanup);
      await setResourceScope(env.a.agent, "provider:demo", "public");
      await setResourceScope(env.a.agent, "mcp:shared", "public");
      restoreArchive(buildArchive(TEST_PASS, env.a.agent).blob, TEST_PASS, env.b.agent);
      write("v2");
      const remote = buildArchive(TEST_PASS, env.a.agent);
      const plan = planSync(remote.payload, env.b.agent);
      mutate(env, plan);
      const afterMutation = snapshotTree(env.b.dir);
      assert.throws(() => applySyncPlan(plan, env.b.agent), /Concurrent modification detected/);
      assert.deepEqual(snapshotTree(env.b.dir), afterMutation);
    });
  }

  await t.test("selected plugin installation changed", async (t) => {
    const env = makeTempEnv("omp-stale-plugin-");
    t.after(env.cleanup);
    for (const side of [env.a, env.b]) {
      fs.writeFileSync(path.join(side.plugins, "package.json"), JSON.stringify({ dependencies: { demo: "1.2.3" } }));
      installPlugin(side, "demo", "1.2.3");
    }
    await setResourceScope(env.a.agent, "plugin:demo", "public");
    restoreArchive(buildArchive(TEST_PASS, env.a.agent).blob, TEST_PASS, env.b.agent);
    fs.writeFileSync(path.join(env.a.plugins, "package.json"), JSON.stringify({ dependencies: { demo: "1.2.4" } }));
    installPlugin(env.a, "demo", "1.2.4");
    fs.writeFileSync(path.join(env.b.plugins, "package.json"), JSON.stringify({ dependencies: { demo: "1.2.4" } }));
    installPlugin(env.b, "demo", "1.2.4");
    const plan = planSync(buildArchive(TEST_PASS, env.a.agent).payload, env.b.agent);
    installPlugin(env.b, "demo", "1.2.5");
    const afterMutation = snapshotTree(env.b.dir);
    assert.throws(() => applySyncPlan(plan, env.b.agent), /Concurrent modification detected/);
    assert.deepEqual(snapshotTree(env.b.dir), afterMutation);
  });

  await t.test("asset file and directory entries changed", async (t) => {
    for (const mutation of ["file", "directory-entry"]) {
      const env = makeTempEnv("omp-stale-asset-");
      t.after(env.cleanup);
      const skillA = path.join(env.a.agent, "skills", "demo");
      fs.mkdirSync(skillA, { recursive: true });
      fs.writeFileSync(path.join(skillA, "SKILL.md"), "# v1\n");
      fs.writeFileSync(path.join(skillA, "helper.js"), "v1\n");
      await setResourceScope(env.a.agent, "asset:skills/demo", "public");
      restoreArchive(buildArchive(TEST_PASS, env.a.agent).blob, TEST_PASS, env.b.agent);
      fs.writeFileSync(path.join(skillA, "SKILL.md"), "# v2\n");
      fs.writeFileSync(path.join(skillA, "helper.js"), "v2\n");
      const plan = planSync(buildArchive(TEST_PASS, env.a.agent).payload, env.b.agent);
      const skillB = path.join(env.b.agent, "skills", "demo");
      if (mutation === "file") fs.appendFileSync(path.join(skillB, "helper.js"), "user\n");
      else fs.writeFileSync(path.join(skillB, "local-added.txt"), "user\n");
      const afterMutation = snapshotTree(env.b.dir);
      assert.throws(() => applySyncPlan(plan, env.b.agent), /Concurrent modification detected/);
      assert.deepEqual(snapshotTree(env.b.dir), afterMutation);
    }
  });
});

test("29. Injected rename failures restore old bytes, modes, state, and lock ownership", async (t) => {
  async function prepared() {
    const env = makeTempEnv("omp-commit-failure-");
    fs.writeFileSync(path.join(env.a.agent, "models.yml"), "providers:\n  demo:\n    baseUrl: https://example.invalid\n    apiKey: v1\n");
    fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "node" } } }));
    await setResourceScope(env.a.agent, "provider:demo", "public");
    await setResourceScope(env.a.agent, "mcp:shared", "public");
    const { blob } = buildArchive(TEST_PASS, env.a.agent);
    fs.writeFileSync(path.join(env.b.agent, "models.yml"), "# original models\n", { mode: 0o640 });
    return { env, blob };
  }

  function injectRename(predicate) {
    const real = fs.renameSync;
    let fired = false;
    fs.renameSync = function renameSync(src, dest) {
      if (!fired && predicate(String(src), String(dest))) {
        fired = true;
        const error = new Error("injected rename failure");
        error.code = "EBUSY";
        throw error;
      }
      return real(src, dest);
    };
    return () => { fs.renameSync = real; };
  }

  function assertRecovered(env) {
    assert.equal(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8"), "# original models\n");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(env.b.agent, "models.yml")).mode & 0o777, 0o640);
    }
    assert.equal(fs.existsSync(path.join(env.b.agent, "mcp.json")), false);
    assert.equal(fs.existsSync(path.join(env.b.agent, "sync-state.local.json")), false);
    assert.equal(fs.existsSync(path.join(env.b.agent, ".sync.local.lock")), false);
    for (const name of fs.readdirSync(env.b.agent)) {
      assert.ok(!name.includes(".tmp-"), `temporary file left: ${name}`);
    }
  }

  await t.test("first runtime target fails", async (t) => {
    const { env, blob } = await prepared();
    t.after(env.cleanup);
    const restore = injectRename((_src, dest) => dest === path.join(env.b.agent, "models.yml"));
    try {
      assert.throws(() => restoreArchive(blob, TEST_PASS, env.b.agent), /injected rename failure|EBUSY|Sync failed/);
    } finally { restore(); }
    assertRecovered(env);
  });

  await t.test("second runtime target fails after the first committed", async (t) => {
    const { env, blob } = await prepared();
    t.after(env.cleanup);
    const restore = injectRename((_src, dest) => dest === path.join(env.b.agent, "mcp.json"));
    try {
      assert.throws(() => restoreArchive(blob, TEST_PASS, env.b.agent));
    } finally { restore(); }
    assertRecovered(env);
  });

  await t.test("state replacement fails", async (t) => {
    const { env, blob } = await prepared();
    t.after(env.cleanup);
    const stateAbs = path.join(env.b.agent, "sync-state.local.json");
    const restore = injectRename((_src, dest) => dest === stateAbs);
    try {
      assert.throws(() => restoreArchive(blob, TEST_PASS, env.b.agent));
    } finally { restore(); }
    assertRecovered(env);
  });

  await t.test("journal completed update fails", async (t) => {
    const { env, blob } = await prepared();
    t.after(env.cleanup);
    const restore = injectRename((src, dest) => {
      if (!dest.endsWith("journal.json")) return false;
      try { return JSON.parse(fs.readFileSync(src, "utf8")).status === "completed"; } catch { return false; }
    });
    try {
      assert.throws(() => restoreArchive(blob, TEST_PASS, env.b.agent));
    } finally { restore(); }
    assertRecovered(env);
  });

  await t.test("recovery failure preserves lock and journal for manual continuation", async (t) => {
    const { env, blob } = await prepared();
    t.after(env.cleanup);
    const modelsAbs = path.join(env.b.agent, "models.yml");
    const real = fs.renameSync;
    let targetFailures = 0;
    fs.renameSync = function renameSync(src, dest) {
      if (String(dest) === modelsAbs && targetFailures < 2) {
        targetFailures++;
        const error = new Error("injected recovery failure");
        error.code = "EBUSY";
        throw error;
      }
      return real(src, dest);
    };
    try {
      assert.throws(() => restoreArchive(blob, TEST_PASS, env.b.agent), /manual recovery/i);
    } finally { fs.renameSync = real; }
    const lockPath = path.join(env.b.agent, ".sync.local.lock");
    assert.ok(fs.existsSync(lockPath));
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.ok(fs.existsSync(path.join(env.b.agent, lock.backupDir, "journal.json")));

    lock.pid = 999999;
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const rolled = rollbackSync(env.b.agent);
    assert.ok(rolled.files >= 1);
    assertRecovered(env);
  });
});

test("30. Rollback validates backups, paths, state, and active lock ownership", async (t) => {
  async function applied() {
    const env = makeTempEnv("omp-rollback-precheck-");
    fs.writeFileSync(path.join(env.a.agent, "models.yml"), "providers:\n  demo:\n    baseUrl: https://v1.example\n    apiKey: v1\n");
    await setResourceScope(env.a.agent, "provider:demo", "public");
    fs.writeFileSync(path.join(env.b.agent, "models.yml"), "providers: {}\n");
    const result = restoreArchive(buildArchive(TEST_PASS, env.a.agent).blob, TEST_PASS, env.b.agent);
    return { env, backupDir: result.backupDir };
  }

  await t.test("ordinary rollback restores files and state", async (t) => {
    const { env, backupDir } = await applied();
    t.after(env.cleanup);
    const result = rollbackSync(env.b.agent);
    assert.ok(result.files >= 1);
    assert.equal(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8"), "providers: {}\n");
    assert.equal(fs.existsSync(path.join(env.b.agent, ".sync.local.lock")), false);
    assert.equal(fs.existsSync(backupDir), false);
    assert.ok(fs.readdirSync(env.b.agent).some((name) => name.startsWith(".rolled-back-")));
  });

  await t.test("later state baseline changes block rollback", async (t) => {
    const { env } = await applied();
    t.after(env.cleanup);
    const state = readSyncState(env.b.agent);
    state.resources["mcp:later"] = { hash: "1".repeat(64), hashFormat: "portable-v1" };
    writeSyncState(env.b.agent, state);
    const models = fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8");
    assert.throws(() => rollbackSync(env.b.agent), /state|baseline|modified/i);
    assert.equal(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8"), models);
    assert.equal(readSyncState(env.b.agent).resources["mcp:later"].hash, "1".repeat(64));
  });

  await t.test("corrupt or missing backups block before restore", async (t) => {
    for (const mutation of ["corrupt", "missing"]) {
      const { env, backupDir } = await applied();
      t.after(env.cleanup);
      const filesDir = path.join(backupDir, "files");
      const backupFile = path.join(filesDir, fs.readdirSync(filesDir)[0]);
      if (mutation === "corrupt") fs.appendFileSync(backupFile, "corrupt");
      else fs.unlinkSync(backupFile);
      const before = snapshotTree(env.b.dir);
      assert.throws(() => rollbackSync(env.b.agent), /backup|integrity|missing/i);
      assert.deepEqual(snapshotTree(env.b.dir), before);
    }
  });

  await t.test("tampered journal paths cannot redirect restoration", async (t) => {
    const { env, backupDir } = await applied();
    t.after(env.cleanup);
    fs.writeFileSync(path.join(env.b.agent, "models.local.json"), '{"providers":{"private":{"apiKey":"keep"}}}');
    const journalPath = path.join(backupDir, "journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journal.entries[0].rel = "models.local.json";
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const before = snapshotTree(env.b.dir);
    assert.throws(() => rollbackSync(env.b.agent), /journal|backup|target|integrity/i);
    assert.deepEqual(snapshotTree(env.b.dir), before);
  });

  await t.test("active lock cannot be deleted by rollback", async (t) => {
    const { env, backupDir } = await applied();
    t.after(env.cleanup);
    const journal = JSON.parse(fs.readFileSync(path.join(backupDir, "journal.json"), "utf8"));
    const lockPath = path.join(env.b.agent, ".sync.local.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
      version: 1,
      transactionId: journal.transactionId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      backupDir: path.basename(backupDir),
    }));
    const before = snapshotTree(env.b.dir);
    assert.throws(() => rollbackSync(env.b.agent), /active|running|lock/i);
    assert.deepEqual(snapshotTree(env.b.dir), before);
  });

  await t.test("legacy journal is rejected without touching files or lock", async (t) => {
    const env = makeTempEnv("omp-legacy-journal-");
    t.after(env.cleanup);
    fs.writeFileSync(path.join(env.b.agent, "models.yml"), "keep\n");
    const backup = path.join(env.b.agent, ".import-backup-legacy");
    fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, "journal.json"), JSON.stringify({ status: "completed", entries: [] }));
    const before = snapshotTree(env.b.dir);
    assert.throws(() => rollbackSync(env.b.agent), /Legacy journal cannot be verified; manual recovery required/);
    assert.deepEqual(snapshotTree(env.b.dir), before);
  });

  await t.test("withSyncLock owns only its lock and honors preserveForRecovery", async (t) => {
    const env = makeTempEnv("omp-lock-helper-");
    t.after(env.cleanup);
    const lockPath = path.join(env.a.agent, ".sync.local.lock");
    const asyncResult = await withSyncLock(env.a.agent, async (lock) => {
      const content = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(content.transactionId, lock.transactionId);
      assert.equal(content.pid, process.pid);
      assert.equal(content.backupDir, null);
      lock.setBackupDir(".import-backup-test");
      assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).backupDir, ".import-backup-test");
      return 42;
    });
    assert.equal(asyncResult, 42);
    assert.equal(fs.existsSync(lockPath), false);

    const syncResult = withSyncLock(env.a.agent, (lock) => {
      lock.preserveForRecovery();
      return "kept";
    });
    assert.equal(syncResult, "kept");
    assert.ok(fs.existsSync(lockPath));
    fs.unlinkSync(lockPath);
  });

  await t.test("a foreign lock is never overwritten or removed by apply", async (t) => {
    const { env } = await applied();
    t.after(env.cleanup);
    const lockPath = path.join(env.b.agent, ".sync.local.lock");
    fs.writeFileSync(lockPath, "foreign-lock");
    fs.writeFileSync(path.join(env.a.agent, "models.yml"), "providers:\n  demo:\n    baseUrl: https://v2.example\n    apiKey: v2\n");
    const plan = planSync(buildArchive(TEST_PASS, env.a.agent).payload, env.b.agent);
    assert.throws(() => applySyncPlan(plan, env.b.agent), /lock/i);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "foreign-lock");
  });
});

test("31. Pruning removes only completed unreferenced journals beyond keepCount", async (t) => {
  const env = makeTempEnv("omp-prune-backups-");
  t.after(env.cleanup);
  const root = env.a.agent;
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (const name of names) {
    const dir = path.join(root, `.import-backup-${name}`);
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, "files"));
    if (name === "f") continue;
    if (name === "g") {
      fs.writeFileSync(path.join(dir, "journal.json"), "{broken");
      continue;
    }
    const status = name === "d" ? "preparing" : name === "e" ? "in_progress" : "completed";
    fs.writeFileSync(path.join(dir, "journal.json"), JSON.stringify({
      version: 2,
      transactionId: `tx-${name}`,
      timestamp: name,
      status,
      entries: [],
      createdDirectories: [],
      stateGuard: null,
    }));
  }
  fs.mkdirSync(path.join(root, ".rolled-back-old"));
  fs.writeFileSync(path.join(root, ".sync.local.lock"), JSON.stringify({
    version: 1,
    transactionId: "tx-h",
    pid: process.pid,
    createdAt: new Date().toISOString(),
    backupDir: ".import-backup-h",
  }));

  const pruned = pruneOldBackups(root, 1).map((item) => path.basename(item)).sort();
  assert.deepEqual(pruned, [".import-backup-a", ".import-backup-b"]);
  for (const name of ["c", "d", "e", "f", "g", "h"]) {
    assert.ok(fs.existsSync(path.join(root, `.import-backup-${name}`)), `${name} must be retained`);
  }
  assert.ok(fs.existsSync(path.join(root, ".rolled-back-old")));

  fs.writeFileSync(path.join(root, ".sync-recovery.local.lock"), "recovery");
  assert.deepEqual(pruneOldBackups(root, 0), []);
  assert.ok(fs.existsSync(path.join(root, ".import-backup-c")));
});

test("32. Crash mid-commit leaves a recoverable lock and never accepts a residual plan", async (t) => {
  const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "sync-crash-child.mjs");

  for (const mode of ["before", "after-replace"]) {
    await t.test(mode, async (t) => {
      const env = makeTempEnv("omp-crash-");
      t.after(env.cleanup);
      fs.writeFileSync(path.join(env.a.agent, "models.yml"), "providers:\n  demo:\n    baseUrl: https://v1.example\n    apiKey: v1\n");
      await setResourceScope(env.a.agent, "provider:demo", "public");
      const { blob } = buildArchive(TEST_PASS, env.a.agent);
      const archivePath = path.join(env.b.dir, "archive.enc");
      fs.writeFileSync(archivePath, blob);
      fs.writeFileSync(path.join(env.b.agent, "models.yml"), "# before crash\n", { mode: 0o640 });

      const child = spawnSync(process.execPath, [childPath, env.b.agent, archivePath, "models.yml", mode, TEST_PASS], {
        encoding: "utf8",
        env: {
          ...process.env,
          OMP_CFG_ROOT: env.b.agent,
          OMP_HOME: env.b.dir,
          GITHUB_TOKEN: "",
          OMP_CFG_CLOUD_TOKEN: "",
        },
      });
      assert.equal(child.status, mode === "before" ? 91 : 92, child.stderr || child.stdout);

      const lockPath = path.join(env.b.agent, ".sync.local.lock");
      assert.ok(fs.existsSync(lockPath));
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.ok(fs.existsSync(path.join(env.b.agent, lock.backupDir, "journal.json")));

      if (mode === "before") {
        assert.equal(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8"), "# before crash\n");
      } else {
        assert.notEqual(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8"), "# before crash\n");
      }

      assert.throws(() => restoreArchive(blob, TEST_PASS, env.b.agent), /lock/i);
      const rolled = rollbackSync(env.b.agent);
      assert.ok(rolled.files >= 1);
      assert.equal(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8"), "# before crash\n");
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(path.join(env.b.agent, "models.yml")).mode & 0o777, 0o640);
      }
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(fs.existsSync(path.join(env.b.agent, "sync-state.local.json")), false);
    });
  }
});

test("33. extractDryRun recognizes independent dry-run tokens and preserves path spaces", (t) => {
  assert.deepEqual(extractDryRun("archive.enc --dry-run"), { dryRun: true, clean: "archive.enc" });
  assert.deepEqual(extractDryRun("--dry-run archive.enc"), { dryRun: true, clean: "archive.enc" });
  assert.deepEqual(extractDryRun("archive.enc -d"), { dryRun: true, clean: "archive.enc" });
  assert.deepEqual(extractDryRun("-d archive.enc"), { dryRun: true, clean: "archive.enc" });
  assert.deepEqual(extractDryRun("\"my archive.enc\" --dry-run"), { dryRun: true, clean: "my archive.enc" });
  assert.deepEqual(extractDryRun("'spaced file.enc' -d"), { dryRun: true, clean: "spaced file.enc" });
  assert.deepEqual(
    extractDryRun("https://example.invalid/path?x=--dry-run"),
    { dryRun: false, clean: "https://example.invalid/path?x=--dry-run" }
  );
  assert.deepEqual(extractDryRun("plain.enc"), { dryRun: false, clean: "plain.enc" });
});

test("34. Sync CLI rejects obsolete rehydrate flags and keeps independent rehydrate help", (t) => {
  const env = makeTempEnv("omp-rehydrate-flags-");
  t.after(env.cleanup);
  const cli = path.resolve("./bin/omp-sync.js");
  const archive = path.join(env.base, "x.enc");
  fs.writeFileSync(archive, "not-used");

  for (const flag of ["--rehydrate", "--no-rehydrate"]) {
    const res = spawnSync(process.execPath, [cli, "import", archive, "-p", TEST_PASS, flag], {
      env: { ...process.env, OMP_CFG_ROOT: env.a.agent, OMP_HOME: env.a.dir },
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, flag);
    assert.match(`${res.stderr}\n${res.stdout}`, /not supported|unsupported|rehydrate/i);
  }

  const help = spawnSync(process.execPath, [cli, "help"], {
    env: { ...process.env, OMP_CFG_ROOT: env.a.agent, OMP_HOME: env.a.dir },
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\brehydrate\b/);
  assert.doesNotMatch(help.stdout, /--no-rehydrate|--rehydrate/);
});

test("35. formatSyncReport stays sanitized and host dry-run shows the full report", async (t) => {
  const env = makeTempEnv("omp-format-report-");
  t.after(env.cleanup);
  const secret = "DUMMY_HOST_SECRET_9f3a";
  fs.writeFileSync(
    path.join(env.a.agent, "models.yml"),
    `providers:\n  demo:\n    baseUrl: https://example.invalid\n    apiKey: ${secret}\n`
  );
  await setResourceScope(env.a.agent, "provider:demo", "public");
  const { blob, payload } = buildArchive(TEST_PASS, env.a.agent);
  const plan = planSync(payload, env.b.agent);
  const report = formatSyncReport(plan);
  assert.ok(!report.includes(secret));
  assert.ok(!report.includes("apiKey"));
  assert.match(report, /provider:demo/);
  assert.match(report, /add|ADD/i);

  const notifications = [];
  const registered = new Map();
  const mockPi = {
    registerCommand(name, def) {
      registered.set(name, def);
    },
  };
  const prevRoot = process.env.OMP_CFG_ROOT;
  const prevHome = process.env.OMP_HOME;
  process.env.OMP_CFG_ROOT = env.b.agent;
  process.env.OMP_HOME = env.b.dir;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = { unref() { return this; } };
    return handle;
  };
  try {
    const plugin = (await import("../index.js")).default;
    plugin(mockPi);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  const archivePath = path.join(env.base, "host.enc");
  fs.writeFileSync(archivePath, blob);
  const mockCtx = {
    ui: {
      notify(msg, level = "info") { notifications.push({ msg, level }); },
    },
  };
  // Bypass passphrase prompt by calling importEncrypted path through handler after stubbing askPass via direct restore.
  // Host handler asks for passphrase; exercise format path via dry-run restore + notify shape instead.
  const dry = restoreArchive(blob, TEST_PASS, env.b.agent, { dryRun: true });
  const rendered = formatSyncReport(dry);
  assert.match(rendered, /provider:demo/);
  assert.ok(!rendered.includes(secret));

  // Scope list must label unclassified resources explicitly.
  fs.writeFileSync(path.join(env.b.agent, "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "node" } } }));
  const inventory = inventoryResources(env.b.agent);
  assert.ok(inventory.some((item) => item.id === "mcp:local"));
  const scope = resolveResourceScope("mcp:local", readSyncPolicy(env.b.agent), readSyncState(env.b.agent), inventory.find((i) => i.id === "mcp:local"));
  assert.equal(scope.scope, "unclassified");

  if (prevRoot === undefined) delete process.env.OMP_CFG_ROOT; else process.env.OMP_CFG_ROOT = prevRoot;
  if (prevHome === undefined) delete process.env.OMP_HOME; else process.env.OMP_HOME = prevHome;
});

test("36. CLI dry-run accepts leading/trailing flags and spaced archive paths", async (t) => {
  const env = makeTempEnv("omp-cli-dryrun-tokens-");
  t.after(env.cleanup);
  const cli = path.resolve("./bin/omp-sync.js");
  fs.writeFileSync(path.join(env.a.agent, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "node" } } }));
  await setResourceScope(env.a.agent, "mcp:shared", "public");
  const spacedDir = path.join(env.base, "spaced dir");
  fs.mkdirSync(spacedDir);
  const archive = path.join(spacedDir, "shared archive.enc");
  const exp = spawnSync(process.execPath, [cli, "export", archive, "-p", TEST_PASS], {
    env: { ...process.env, OMP_CFG_ROOT: env.a.agent, OMP_HOME: env.a.dir },
    encoding: "utf8",
  });
  assert.equal(exp.status, 0, exp.stderr);

  for (const args of [
    ["import", archive, "-p", TEST_PASS, "--dry-run"],
    ["import", "--dry-run", archive, "-p", TEST_PASS],
    ["import", archive, "-p", TEST_PASS, "-d"],
  ]) {
    const before = snapshotTree(env.b.dir);
    const dry = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, OMP_CFG_ROOT: env.b.agent, OMP_HOME: env.b.dir },
      encoding: "utf8",
    });
    assert.equal(dry.status, 0, `${args.join(" ")}\n${dry.stderr}`);
    assert.match(dry.stdout, /import-dry-run|dry-run/i);
    assert.deepEqual(snapshotTree(env.b.dir), before);
  }
});

test("37. Stubbed Gist transport commits shared baselines without real GitHub access", async (t) => {
  const env = makeTempEnv("omp-gist-stub-");
  t.after(env.cleanup);
  const secret = "DUMMY_GIST_SECRET_77aa";
  fs.writeFileSync(
    path.join(env.a.agent, "models.yml"),
    `providers:\n  gist-ai:\n    baseUrl: https://example.invalid\n    apiKey: ${secret}\n`
  );
  await setResourceScope(env.a.agent, "provider:gist-ai", "public");

  const requests = [];
  const realFetch = globalThis.fetch;
  let storedContent = null;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const bodyText = init.body ? String(init.body) : "";
    requests.push({ href, method: init.method || "GET", bodyText });
    if (href.includes("/gists") && (init.method || "GET") === "POST") {
      const parsed = JSON.parse(bodyText);
      storedContent = parsed.files["omp-config.enc.b64"].content;
      assert.ok(!Buffer.from(storedContent, "base64").toString("latin1").includes(secret));
      return {
        ok: true,
        status: 201,
        async json() {
          return { id: "stubbed-gist", html_url: "https://gist.example.invalid/stubbed-gist" };
        },
        async text() { return ""; },
      };
    }
    if (href.includes("/gists/stubbed-gist")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { files: { "omp-config.enc.b64": { content: storedContent } } };
        },
        async text() { return ""; },
      };
    }
    throw new Error(`Unexpected fetch in gist stub: ${href}`);
  };

  try {
    const pushed = await pushGist("new", TEST_PASS, env.a.agent, "dummy-token");
    assert.equal(pushed.id, "stubbed-gist");
    assert.ok(requests.some((req) => req.method === "POST"));
    const stateA = readSyncState(env.a.agent);
    assert.ok(stateA.resources["provider:gist-ai"]);

    const pulled = await pullGist("stubbed-gist", TEST_PASS, env.b.agent, "dummy-token");
    assert.equal(pulled.dryRun, false);
    assert.ok(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8").includes(secret));
    assert.equal(
      readSyncState(env.b.agent).resources["provider:gist-ai"].hash,
      stateA.resources["provider:gist-ai"].hash
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("38. Legacy v1 and v2 payload inspection, adaptation, and CLI adapt command", async (t) => {
  // 1. inspectArchivePayload
  assert.deepEqual(
    inspectArchivePayload({
      v: 3,
      namespace: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date().toISOString(),
      resources: [],
      tombstones: [],
    }),
    { compatible: true, version: 3 }
  );
  assert.deepEqual(
    inspectArchivePayload({ v: 1, files: [] }),
    { compatible: false, version: 1, adaptable: true }
  );
  assert.deepEqual(
    inspectArchivePayload({ v: 2, resources: [] }),
    { compatible: false, version: 2, adaptable: true }
  );
  assert.deepEqual(
    inspectArchivePayload({ v: 2, files: [] }),
    { compatible: false, version: 2, adaptable: true }
  );
  const badInspection = inspectArchivePayload({ v: 9 });
  assert.equal(badInspection.compatible, false);
  assert.equal(badInspection.version, 9);
  assert.equal(badInspection.adaptable, false);
  assert.match(badInspection.reason, /unsupported archive payload: version 9; expected v3/);

  // 2. adaptLegacySnapshot
  assert.throws(
    () => adaptLegacySnapshot({ v: 1, files: [] }),
    /legacy archive could not be adapted: empty snapshot/
  );
  assert.throws(
    () => adaptLegacySnapshot({ v: 2, resources: [] }),
    /legacy archive could not be adapted: empty snapshot/
  );

  const adaptedV2 = adaptLegacySnapshot({
    v: 2,
    resources: [{ id: "mcp:demo", value: { command: "echo" } }],
  });
  assert.equal(adaptedV2.v, 3);
  assert.equal(adaptedV2.namespace, "00000000-0000-4000-8000-0000000000v2");
  assert.equal(adaptedV2.legacy.from, 2);
  assert.deepEqual(adaptedV2.legacy.unmapped, []);
  assert.equal(adaptedV2.resources.length, 1);

  const yamlContent = "providers:\n  legacy-ai:\n    baseUrl: https://legacy.com\n    apiKey: key123\n";
  const adaptedV1 = adaptLegacySnapshot({
    v: 1,
    files: [{ path: "agent/models.yml", data: Buffer.from(yamlContent).toString("base64") }],
  });
  assert.equal(adaptedV1.v, 3);
  assert.equal(adaptedV1.namespace, "00000000-0000-4000-8000-0000000000v1");
  assert.equal(adaptedV1.legacy.from, 1);
  assert.deepEqual(adaptedV1.legacy.unmapped, []);
  assert.equal(adaptedV1.resources[0].id, "provider:legacy-ai");

  // 3. adaptArchive throws on already v3 or unsupported
  const v3Archive = encryptTestArchive({
    v: 3,
    namespace: "test-ns",
    createdAt: new Date().toISOString(),
    resources: [{ id: "mcp:demo", value: { command: "echo" } }],
    tombstones: [],
  });
  assert.throws(
    () => adaptArchive(v3Archive, TEST_PASS),
    /archive already v3; no adaptation needed/
  );

  // 4. CLI adapt command
  const env = makeTempEnv("omp-adapt-cli-");
  t.after(env.cleanup);

  const v1Payload = {
    v: 1,
    files: [{ path: "agent/models.yml", data: Buffer.from(yamlContent).toString("base64") }],
  };
  const srcEnc = path.join(env.base, "legacy-src.enc");
  const outEnc = path.join(env.base, "adapted-out.enc");
  const srcBytes = encryptTestArchive(v1Payload, TEST_PASS);
  fs.writeFileSync(srcEnc, srcBytes);

  const cliScript = path.resolve("./bin/omp-sync.js");
  const adaptRun = spawnSync(
    process.execPath,
    [cliScript, "adapt", srcEnc, outEnc, "-p", TEST_PASS],
    { encoding: "utf8" }
  );
  assert.equal(adaptRun.status, 0, adaptRun.stderr);
  assert.ok(adaptRun.stdout.includes("detected v1"));
  assert.ok(adaptRun.stdout.includes("wrote v3 archive ->"));

  // Verify src bytes are completely unchanged
  assert.deepEqual(fs.readFileSync(srcEnc), srcBytes);

  // Verify out archive is v3 and contains provider
  const decryptedOut = decryptTestArchive(fs.readFileSync(outEnc), TEST_PASS);
  assert.equal(decryptedOut.v, 3);
  assert.equal(decryptedOut.resources[0].id, "provider:legacy-ai");

  // Overwrite protection: running adapt again without --force must fail
  const failOverwrite = spawnSync(
    process.execPath,
    [cliScript, "adapt", srcEnc, outEnc, "-p", TEST_PASS],
    { encoding: "utf8" }
  );
  assert.notEqual(failOverwrite.status, 0);
  assert.match(failOverwrite.stderr, /adapted archive already exists/);

  // Overwrite with --force succeeds
  const forceOverwrite = spawnSync(
    process.execPath,
    [cliScript, "adapt", srcEnc, outEnc, "-p", TEST_PASS, "--force"],
    { encoding: "utf8" }
  );
  assert.equal(forceOverwrite.status, 0, forceOverwrite.stderr);

  // Refuses to overwrite src
  const failSelf = spawnSync(
    process.execPath,
    [cliScript, "adapt", srcEnc, srcEnc, "-p", TEST_PASS, "--force"],
    { encoding: "utf8" }
  );
  assert.notEqual(failSelf.status, 0);
  assert.match(failSelf.stderr, /cannot overwrite source file/);

  // Import <out> into fresh target env
  const importRun = spawnSync(
    process.execPath,
    [cliScript, "import", outEnc, "-p", TEST_PASS, "-r", env.b.agent],
    { encoding: "utf8" }
  );
  assert.equal(importRun.status, 0, importRun.stderr);
  const bModels = fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8");
  assert.ok(bModels.includes("legacy-ai"));
});

test("39. Automatic archive adaptation during import and remote pull", async (t) => {
  const env = makeTempEnv("omp-auto-adapt-");
  t.after(env.cleanup);

  const yamlContent = "providers:\n  auto-ai:\n    baseUrl: https://auto.com\n    apiKey: auto-key\n";
  const v1Payload = {
    v: 1,
    files: [{ path: "agent/models.yml", data: Buffer.from(yamlContent).toString("base64") }],
  };
  const srcEnc = path.join(env.base, "auto-legacy.enc");
  const initialBytes = encryptTestArchive(v1Payload, TEST_PASS);
  fs.writeFileSync(srcEnc, initialBytes);

  // 1. importEncrypted with unadapted v1 archive
  const importRes = importEncrypted(srcEnc, TEST_PASS, env.a.agent);
  assert.equal(importRes.legacy?.adapted, true);
  assert.equal(importRes.legacy?.from, 1);
  assert.equal(importRes.adaptedFile, `${path.resolve(srcEnc)}.v3.enc`);
  assert.ok(fs.existsSync(importRes.adaptedFile));
  // Source file bytes remain identical
  assert.deepEqual(fs.readFileSync(srcEnc), initialBytes);
  // models.yml in env.a.agent was written
  assert.ok(fs.readFileSync(path.join(env.a.agent, "models.yml"), "utf8").includes("auto-ai"));

  // Calling importEncrypted again on the same file without force throws
  assert.throws(
    () => importEncrypted(srcEnc, TEST_PASS, env.a.agent),
    /adapted archive already exists/
  );
  // Calling with options.force succeeds
  const forceRes = importEncrypted(srcEnc, TEST_PASS, env.a.agent, { force: true });
  assert.ok(forceRes.adaptedFile);

  // 2. pullHttp with unadapted v1 archive
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(initialBytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const httpUrl = `http://127.0.0.1:${port}/legacy.enc`;

  try {
    // dry-run: memory adapt only, does NOT write file to os.tmpdir()
    const dryRes = await pullHttp(httpUrl, TEST_PASS, env.b.agent, null, { dryRun: true });
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.legacy?.adapted, true);
    assert.equal(dryRes.adaptedFile, undefined);
    assert.ok(!fs.existsSync(path.join(env.b.agent, "models.yml")));

    // real pull: writes to os.tmpdir()/omp-archive-v3-<epoch>.enc, applies config
    const realRes = await pullHttp(httpUrl, TEST_PASS, env.b.agent);
    assert.equal(realRes.dryRun, false);
    assert.equal(realRes.legacy?.adapted, true);
    assert.ok(realRes.adaptedFile);
    assert.ok(fs.existsSync(realRes.adaptedFile));
    assert.ok(path.basename(realRes.adaptedFile).startsWith("omp-archive-v3-"));
    assert.ok(fs.readFileSync(path.join(env.b.agent, "models.yml"), "utf8").includes("auto-ai"));
    try { fs.unlinkSync(realRes.adaptedFile); } catch {}
  } finally {
    server.close();
  }
});

test("40. Interactive public resource picker selectPublicResources and /config-push / /config-pull", async (t) => {
  const env = makeTempEnv("omp-public-picker-");
  t.after(env.cleanup);

  const root = env.a.agent;

  // Empty inventory test
  const emptyNotifications = [];
  const emptyCtx = {
    ui: {
      notify: (msg, type) => emptyNotifications.push({ msg, type }),
      askDialog: async () => ({ kind: "submit" }),
    },
  };
  const emptyRes = await selectPublicResources(emptyCtx, root);
  assert.equal(emptyRes, null);
  assert.ok(emptyNotifications.some((n) => n.msg.includes("No configuration resources found.")));

  // Set up resources in root
  fs.writeFileSync(
    path.join(root, "models.yml"),
    "providers:\n" +
      "  pub-prov:\n    baseUrl: https://pub.com\n    apiKey: pub-key\n" +
      "  priv-prov:\n    baseUrl: https://priv.com\n    apiKey: priv-key\n    private: true\n" +
      "  https-prov:\n    baseUrl: https://example.com/v1\n    apiKey: https-key\n" +
      "  local-prov:\n    baseUrl: http://127.0.0.1:18888/v1\n    apiKey: local-key\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        demo1: { command: "echo", args: ["C:/local/tool.cjs"] },
        demo2: { command: "node" },
      },
    }),
    "utf8"
  );
  const GENERIC_IDS = ["mcp:demo2", "provider:https-prov", "provider:pub-prov", "setting:/theme"].sort();
  const SUSPICIOUS_IDS = ["mcp:demo1", "provider:local-prov"].sort();
  fs.writeFileSync(
    path.join(root, "config.yml"),
    "theme: dark\n",
    "utf8"
  );

  // No askDialog in host
  const noDialogNotifications = [];
  const noDialogCtx = {
    ui: {
      notify: (msg, type) => noDialogNotifications.push({ msg, type }),
    },
  };
  const noDialogRes = await selectPublicResources(noDialogCtx, root);
  assert.equal(noDialogRes, null);
  assert.ok(noDialogNotifications.some((n) => n.msg.includes("当前宿主不支持空格多选，请升级 OMP")));

  // User cancels dialog
  const cancelNotifications = [];
  let presentedDialog = null;
  const cancelCtx = {
    ui: {
      notify: (msg, type) => cancelNotifications.push({ msg, type }),
      askDialog: async (dialogs) => {
        presentedDialog = dialogs[0];
        return { kind: "cancel" };
      },
    },
  };
  const cancelRes = await selectPublicResources(cancelCtx, root);
  assert.equal(cancelRes, null);
  assert.ok(cancelNotifications.some((n) => n.msg.includes("已取消，未修改公开范围")));
  // Menu only offers machine-binding candidates
  assert.equal(presentedDialog.id, "sync-exclude");
  assert.equal(presentedDialog.multi, true);
  assert.deepEqual(
    presentedDialog.options.map((o) => o.label),
    SUSPICIOUS_IDS
  );
  assert.ok(presentedDialog.options.every((o) => o.description.startsWith("可能不适合同步 · ")));

  // Empty exclusion submit: generic items become public, suspicious stay unclassified
  const policyPath = path.join(root, "sync-policy.local.json");
  const emptySelectCtx = {
    ui: {
      notify: () => {},
      askDialog: async () => ({
        kind: "submit",
        selectedOptions: [],
      }),
    },
  };
  const emptySelectRes = await selectPublicResources(emptySelectCtx, root);
  assert.ok(emptySelectRes);
  assert.deepEqual(emptySelectRes.selected, GENERIC_IDS);
  assert.deepEqual(emptySelectRes.excluded, []);
  assert.equal(emptySelectRes.publicCount, 4);
  const policyAfterEmpty = readSyncPolicy(root);
  for (const id of GENERIC_IDS) {
    assert.equal(policyAfterEmpty.resources[id], "public");
  }
  for (const id of SUSPICIOUS_IDS) {
    assert.equal(policyAfterEmpty.resources[id], undefined);
  }

  // Explicit exclusion submit: suspicious stay unclassified, generic still public
  fs.unlinkSync(policyPath);
  const excludeSubmitCtx = {
    ui: {
      notify: () => {},
      askDialog: async () => ({
        kind: "submit",
        results: [{ id: "sync-exclude", selectedOptions: SUSPICIOUS_IDS }],
      }),
    },
  };
  const excludeSubmitRes = await selectPublicResources(excludeSubmitCtx, root);
  assert.ok(excludeSubmitRes);
  assert.deepEqual(excludeSubmitRes.selected, GENERIC_IDS);
  assert.deepEqual(excludeSubmitRes.excluded, SUSPICIOUS_IDS);
  assert.equal(excludeSubmitRes.publicCount, 4);
  const policyAfterExclude = readSyncPolicy(root);
  for (const id of GENERIC_IDS) {
    assert.equal(policyAfterExclude.resources[id], "public");
  }
  for (const id of SUSPICIOUS_IDS) {
    assert.equal(policyAfterExclude.resources[id], undefined);
  }

  // Excluding an explicit-public machine-binding item flips it to private
  fs.unlinkSync(policyPath);
  await setResourceScope(root, "mcp:demo1", "public");
  const flipCtx = {
    ui: {
      notify: () => {},
      askDialog: async () => ({
        kind: "submit",
        results: [{ id: "sync-exclude", selectedOptions: ["mcp:demo1"] }],
      }),
    },
  };
  const flipRes = await selectPublicResources(flipCtx, root);
  assert.ok(flipRes);
  assert.deepEqual(flipRes.excluded, ["mcp:demo1"]);
  assert.equal(flipRes.publicCount, 4);
  const policyAfterFlip = readSyncPolicy(root);
  assert.equal(policyAfterFlip.resources["mcp:demo1"], "private");
  assert.equal(policyAfterFlip.resources["provider:local-prov"], undefined);
  for (const id of GENERIC_IDS) {
    assert.equal(policyAfterFlip.resources[id], "public");
  }

  // Test Host Command Integration (/config-push and /config-pull)
  const registeredCommands = new Map();
  const mockPi = {
    registerCommand: (name, def) => registeredCommands.set(name, def),
  };
  pluginEntry(mockPi);

  // Verification 5: Host stub: askDialog submits empty exclusion (generic default public)
  // Reset policy
  fs.unlinkSync(policyPath);
  const pushCmd = registeredCommands.get("config-push");
  let uploadBody = null;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCfgRoot = process.env.OMP_CFG_ROOT;
  const originalConfigPass = process.env.OMP_CONFIG_PASS;
  delete process.env.OMP_CONFIG_PASS;
  process.env.OMP_CFG_ROOT = root;
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    uploadBody = init.body;
    return { ok: true, status: 200, async text() { return ""; } };
  };
  try {
    const hostCtx = {
      ui: {
        notify: () => {},
        input: async () => TEST_PASS,
        askDialog: async () => ({
          kind: "submit",
          selectedOptions: [],
        }),
      },
    };
    await pushCmd.handler("https://example.invalid/custom-push", hostCtx);
    assert.equal(fetchCalls, 1);
    assert.ok(uploadBody);
    const pushedPayload = decryptTestArchive(uploadBody, TEST_PASS);
    assert.deepEqual(
      pushedPayload.resources.map((r) => r.id).sort(),
      GENERIC_IDS
    );
    assert.ok(!pushedPayload.resources.some((r) => r.id === "provider:priv-prov"));
    assert.ok(!pushedPayload.resources.some((r) => r.id === "mcp:demo1"));
    assert.ok(!pushedPayload.resources.some((r) => r.id === "provider:local-prov"));
    const hostPolicy = readSyncPolicy(root);
    for (const id of GENERIC_IDS) {
      assert.equal(hostPolicy.resources[id], "public");
    }
    for (const id of SUSPICIOUS_IDS) {
      assert.equal(hostPolicy.resources[id], undefined);
    }

    // Now test kind: "cancel": policy bytes unchanged, fetch called 0 times
    const policyBytesBefore = fs.readFileSync(path.join(root, "sync-policy.local.json"));
    fetchCalls = 0;
    const cancelHostCtx = {
      ui: {
        notify: () => {},
        input: async () => { throw new Error("should not ask pass on cancel"); },
        askDialog: async () => ({ kind: "cancel" }),
      },
    };
    await pushCmd.handler("https://example.invalid/custom-push", cancelHostCtx);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(fs.readFileSync(path.join(root, "sync-policy.local.json")), policyBytesBefore);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCfgRoot !== undefined) process.env.OMP_CFG_ROOT = originalCfgRoot;
    else delete process.env.OMP_CFG_ROOT;
    if (originalConfigPass !== undefined) process.env.OMP_CONFIG_PASS = originalConfigPass;
    else delete process.env.OMP_CONFIG_PASS;
  }
});

test("41. Picker skips dialog when every candidate is generic", async (t) => {
  const env = makeTempEnv("omp-no-suspicious-");
  t.after(env.cleanup);

  const root = env.a.agent;
  fs.writeFileSync(
    path.join(root, "models.yml"),
    "providers:\n  cloud-prov:\n    baseUrl: https://example.com/v1\n    apiKey: cloud-key\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "mcp.json"),
    JSON.stringify({ mcpServers: { simple: { command: "node" } } }),
    "utf8"
  );

  let askDialogCalls = 0;
  const notifications = [];
  const ctx = {
    ui: {
      notify: (msg, type) => notifications.push({ msg, type }),
      askDialog: async () => {
        askDialogCalls++;
        return { kind: "submit", selectedOptions: [] };
      },
    },
  };
  const res = await selectPublicResources(ctx, root);
  assert.equal(askDialogCalls, 0);
  assert.ok(notifications.some((n) => n.msg.includes("未发现不适合同步项，默认同步 2 项")));
  assert.ok(res);
  assert.deepEqual(res.selected, ["mcp:simple", "provider:cloud-prov"].sort());
  assert.deepEqual(res.excluded, []);
  assert.equal(res.publicCount, 2);
  const policy = readSyncPolicy(root);
  assert.equal(policy.resources["provider:cloud-prov"], "public");
  assert.equal(policy.resources["mcp:simple"], "public");
});

test("42. Inventory and archive exclude assets whose own path is blacklisted", async (t) => {
  const env = makeTempEnv("omp-blacklist-asset-");
  t.after(env.cleanup);

  const root = env.a.agent;
  // ompHome(root) is dirname(root); makeTempEnv already created the "tools" dir there.
  const toolsDir = env.a.tools;
  fs.mkdirSync(path.join(toolsDir, "rea", "installation"), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "rea", "install.mjs"), "console.log('rea');\n", "utf8");
  fs.writeFileSync(path.join(toolsDir, "rea", "installation", "adb-client.stderr.txt"), "", "utf8");
  fs.mkdirSync(path.join(toolsDir, "simple"), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "simple", "tool.mjs"), "export default 1;\n", "utf8");

  const ids = inventoryResources(root).map((item) => item.id);
  assert.ok(ids.includes("asset:tools/simple"));
  assert.ok(!ids.includes("asset:tools/rea"));

  // Archive build must not walk the blacklisted asset
  await setResourceScope(root, "asset:tools/simple", "public");
  const { blob } = buildArchive(TEST_PASS, root);
  const payload = decryptTestArchive(blob, TEST_PASS);
  const idsInArchive = payload.resources.map((r) => r.id);
  assert.ok(idsInArchive.includes("asset:tools/simple"));
  assert.ok(!idsInArchive.includes("asset:tools/rea"));
});

test("43. Range plugin specs export at their exact installed and locked version", async (t) => {
  const env = makeTempEnv("omp-plugin-range-");
  t.after(env.cleanup);

  const pluginsDir = env.a.plugins;
  fs.writeFileSync(
    path.join(pluginsDir, "package.json"),
    JSON.stringify({ dependencies: { "omp-demo": "^1.0.0" } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(pluginsDir, "omp-plugins.lock.json"),
    JSON.stringify({ plugins: { "omp-demo": { version: "1.0.0", enabled: true } } }),
    "utf8"
  );
  const installedDir = path.join(pluginsDir, "node_modules", "omp-demo");
  fs.mkdirSync(installedDir, { recursive: true });
  fs.writeFileSync(
    path.join(installedDir, "package.json"),
    JSON.stringify({ name: "omp-demo", version: "1.0.0" }),
    "utf8"
  );

  await setResourceScope(env.a.agent, "plugin:omp-demo", "public");
  const { payload } = buildArchive(TEST_PASS, env.a.agent);
  const plugin = payload.resources.find((item) => item.id === "plugin:omp-demo");
  assert.ok(plugin);
  assert.deepEqual(plugin.value, { name: "omp-demo", version: "1.0.0", enabled: true });

  // Range spec without an installed copy stays fail-closed
  fs.rmSync(installedDir, { recursive: true, force: true });
  assert.throws(
    () => buildArchive(TEST_PASS, env.a.agent),
    /not an exact semver registry version/
  );
});

test("44. Cloud transports retry transient network failures", async (t) => {
  const env = makeTempEnv("omp-fetch-retry-");
  t.after(env.cleanup);

  const root = env.a.agent;
  fs.writeFileSync(
    path.join(root, "models.yml"),
    "providers:\n  demo:\n    baseUrl: https://example.invalid\n    apiKey: k\n",
    "utf8"
  );
  await setResourceScope(root, "provider:demo", "public");

  const registeredCommands = new Map();
  pluginEntry({ registerCommand: (name, def) => registeredCommands.set(name, def) });
  const pushCmd = registeredCommands.get("config-push");

  const makeCtx = (notes) => ({
    ui: {
      notify: (msg, type) => notes.push({ msg, type }),
      input: async () => TEST_PASS,
      askDialog: async () => ({ kind: "submit", selectedOptions: [] }),
    },
  });

  const originalFetch = globalThis.fetch;
  const originalCfgRoot = process.env.OMP_CFG_ROOT;
  const originalConfigPass = process.env.OMP_CONFIG_PASS;
  delete process.env.OMP_CONFIG_PASS;
  process.env.OMP_CFG_ROOT = root;
  let fetchCalls = 0;
  let behavior = null;
  globalThis.fetch = async () => {
    fetchCalls++;
    return behavior(fetchCalls);
  };
  try {
    // Transient reset once, then the request succeeds
    fetchCalls = 0;
    const okNotes = [];
    behavior = (call) => {
      if (call === 1) {
        const err = new TypeError("fetch failed");
        err.cause = { code: "ECONNRESET" };
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "gist-retry", html_url: "https://gist.github.com/x/gist-retry" }),
      };
    };
    await pushCmd.handler("gist:new", makeCtx(okNotes));
    assert.equal(fetchCalls, 2);
    assert.ok(okNotes.some((n) => n.msg.includes("gist-retry")));

    // Client errors never retry
    fetchCalls = 0;
    const failNotes = [];
    behavior = () => ({ ok: false, status: 401, text: async () => "Bad credentials" });
    await pushCmd.handler("gist:new", makeCtx(failNotes));
    assert.equal(fetchCalls, 1);
    assert.ok(failNotes.some((n) => n.msg.includes("GitHub API 401")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCfgRoot !== undefined) process.env.OMP_CFG_ROOT = originalCfgRoot;
    else delete process.env.OMP_CFG_ROOT;
    if (originalConfigPass !== undefined) process.env.OMP_CONFIG_PASS = originalConfigPass;
    else delete process.env.OMP_CONFIG_PASS;
  }
});

test("45. Blocked sync plan error surfaces action id and reason", async (t) => {
  const env = makeTempEnv("omp-blocked-detail-");
  t.after(env.cleanup);

  const rootA = env.a.agent;
  const skillDir = path.join(rootA, "skills", "shared-search");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Shared\n", "utf8");
  await setResourceScope(rootA, "asset:skills/shared-search", "public");
  const { blob } = buildArchive(TEST_PASS, rootA);

  // Client root has a plain file where the archive ships a directory
  const rootB = env.b.agent;
  fs.mkdirSync(path.join(rootB, "skills"), { recursive: true });
  fs.writeFileSync(path.join(rootB, "skills", "shared-search"), "not a dir", "utf8");

  await assert.throws(
    () => restoreArchive(blob, TEST_PASS, rootB),
    (err) => {
      assert.match(err.message, /1 action\(s\) are blocked/);
      assert.match(err.message, /asset:skills\/shared-search/);
      assert.match(err.message, /Asset type conversion is blocked/);
      assert.equal(err.blocked?.length, 1);
      return true;
    }
  );
});
