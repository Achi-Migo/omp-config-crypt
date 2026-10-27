import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  collect,
  buildArchive,
  restoreArchive,
  rollback,
  exportEncrypted,
  importEncrypted,
  resolveDestination,
  inferModelCapabilities,
  filterChatModels,
  saveProvider,
  listProviders,
  removeProvider,
  getRoles,
  setRole,
  runMaintenance,
} from "../index.js";

const TEST_DIR = path.join(os.tmpdir(), `omp-test-sync-${Date.now()}`);
const SOURCE_DIR = path.join(TEST_DIR, "source");
const SOURCE_AGENT = path.join(SOURCE_DIR, ".omp", "agent");
const SOURCE_EXT = path.join(SOURCE_DIR, ".omp", "extensions");
const SOURCE_PLUGINS = path.join(SOURCE_DIR, ".omp", "plugins");

const TARGET_DIR = path.join(TEST_DIR, "target");
const TARGET_AGENT = path.join(TARGET_DIR, ".omp", "agent");

function setupFixtures() {
  fs.mkdirSync(SOURCE_AGENT, { recursive: true });
  fs.mkdirSync(path.join(SOURCE_AGENT, "memories"), { recursive: true });
  fs.mkdirSync(path.join(SOURCE_AGENT, "managed-skills", "demo-skill"), { recursive: true });
  fs.mkdirSync(SOURCE_EXT, { recursive: true });
  fs.mkdirSync(SOURCE_PLUGINS, { recursive: true });
  fs.mkdirSync(TARGET_AGENT, { recursive: true });

  const currentHome = os.homedir();

  // 1. Core configs
  fs.writeFileSync(
    path.join(SOURCE_AGENT, "config.yml"),
    `theme: dark\nextensions:\n  - ${currentHome}/.omp/extensions/custom.js\n`
  );

  fs.writeFileSync(
    path.join(SOURCE_AGENT, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        opc: {
          headers: {
            "X-OPC-MCP-Token": `!cat ${currentHome}/.omp/agent/opc-mcp-token`,
          },
        },
      },
    })
  );

  // 2. Token & companions
  fs.writeFileSync(path.join(SOURCE_AGENT, "opc-mcp-token"), "token_secret_value_123");
  fs.writeFileSync(path.join(SOURCE_AGENT, "models.yml"), "providers:\n  custom: ok\n");
  fs.writeFileSync(path.join(SOURCE_AGENT, "memories", "memory-1.md"), "# Memory Note\n");
  fs.writeFileSync(
    path.join(SOURCE_AGENT, "managed-skills", "demo-skill", "SKILL.md"),
    "# Managed Skill\n"
  );

  // 3. Extensions
  fs.writeFileSync(
    path.join(SOURCE_EXT, "custom.js"),
    `import fs from "fs";\nconst f = "${currentHome}/.pi/agent/models.json";\n`
  );

  // 4. Plugins lockfile
  fs.writeFileSync(
    path.join(SOURCE_PLUGINS, "omp-plugins.lock.json"),
    JSON.stringify({ plugins: { "omp-config-crypt": { version: "0.4.0" } } })
  );

  // 5. Blacklisted SQLite DB files (MUST NOT be packed)
  fs.writeFileSync(path.join(SOURCE_AGENT, "agent.db"), "SQLITE_MOCK_DATA");
  fs.writeFileSync(path.join(SOURCE_AGENT, "agent.db-wal"), "SQLITE_WAL_DATA");
  // 6. Blacklisted private model files & local extensions
  fs.writeFileSync(
    path.join(SOURCE_AGENT, "models.local.json"),
    JSON.stringify({ providers: { priv: { baseUrl: "http://local" } } })
  );
  fs.writeFileSync(path.join(SOURCE_EXT, "local-models.js"), "export default function() {}");
}

function teardownFixtures() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

test("OMP Universal Sync Test Suite", async (t) => {
  setupFixtures();

  await t.test("Test Case 1: Full asset collection and strict blacklist exclusion", () => {
    const items = collect(SOURCE_AGENT);
    const relPaths = items.map((i) => i.rel);

    assert.ok(relPaths.includes("config.yml"), "config.yml should be collected");
    assert.ok(relPaths.includes("mcp.json"), "mcp.json should be collected");
    assert.ok(relPaths.includes("opc-mcp-token"), "opc-mcp-token should be collected");
    assert.ok(relPaths.includes("memories/memory-1.md"), "memories should be collected");
    assert.ok(
      relPaths.includes("managed-skills/demo-skill/SKILL.md"),
      "managed-skills should be collected"
    );
    assert.ok(relPaths.includes("extensions/custom.js"), "extensions/custom.js should be collected");
    assert.ok(
      relPaths.includes("plugins/omp-plugins.lock.json"),
      "plugins lockfile should be collected"
    );

    // Assert databases are strictly excluded
    assert.ok(!relPaths.includes("agent.db"), "agent.db MUST be excluded");
    assert.ok(!relPaths.includes("agent.db-wal"), "agent.db-wal MUST be excluded");
    assert.ok(!relPaths.includes("models.local.json"), "models.local.json MUST be blacklisted from collection");
    assert.ok(!relPaths.includes("extensions/local-models.js"), "local-models.js MUST be blacklisted from collection");
  });

  await t.test("Test Case 2: Archive encryption, remapping and dry-run", () => {
    const pass = "secret-passphrase-999";
    const { blob, files } = buildArchive(pass, SOURCE_AGENT);
    assert.ok(files >= 7, "At least 7 files packed");
    assert.ok(blob.length > 100, "Archive blob has valid size");

    // Dry-run restore
    const dryRunRes = restoreArchive(blob, pass, TARGET_AGENT, { dryRun: true });
    assert.equal(dryRunRes.dryRun, true);
    assert.equal(dryRunRes.files, files);
    assert.ok(!fs.existsSync(path.join(TARGET_AGENT, "config.yml")), "Dry-run must not write files");

    // Real restore
    const restoreRes = restoreArchive(blob, pass, TARGET_AGENT);
    assert.equal(restoreRes.dryRun, false);
    assert.equal(restoreRes.files, files);

    // Verify restored files exist
    assert.ok(fs.existsSync(path.join(TARGET_AGENT, "config.yml")));
    assert.ok(fs.existsSync(path.join(TARGET_AGENT, "opc-mcp-token")));
    assert.ok(fs.existsSync(path.join(TARGET_DIR, ".omp", "extensions", "custom.js")));

    const restoredConfig = fs.readFileSync(path.join(TARGET_AGENT, "config.yml"), "utf8");
    const currentHome = os.homedir();
    assert.ok(
      restoredConfig.includes(`${currentHome}/.omp/extensions/custom.js`),
      "Path in config.yml should match target home"
    );

    const restoredToken = fs.readFileSync(path.join(TARGET_AGENT, "opc-mcp-token"), "utf8");
    assert.equal(restoredToken, "token_secret_value_123");
  });

  await t.test("Test Case 3: Atomic backup and rollback", () => {
    const pass = "secret-passphrase-999";
    const archivePath = path.join(TEST_DIR, "archive.enc");
    exportEncrypted(archivePath, pass, SOURCE_AGENT);

    // Import again into target to trigger backup of pre-existing files
    const importRes = importEncrypted(archivePath, pass, TARGET_AGENT);
    assert.ok(importRes.backupDir, "Backup directory should be created for pre-existing files");
    assert.ok(fs.existsSync(importRes.backupDir), "Backup directory exists on disk");

    // Mutate a file in target
    const targetConfig = path.join(TARGET_AGENT, "config.yml");
    fs.writeFileSync(targetConfig, "corrupted: true\n");
    assert.equal(fs.readFileSync(targetConfig, "utf8"), "corrupted: true\n");

    // Rollback
    const rollbackRes = rollback(TARGET_AGENT);
    assert.ok(rollbackRes.files > 0, "Files restored during rollback");
    const revertedConfig = fs.readFileSync(targetConfig, "utf8");
    assert.ok(!revertedConfig.includes("corrupted: true"), "Corrupted content must be reverted");
    assert.ok(revertedConfig.includes("theme: dark"), "Original content restored");
  });

  await t.test("Test Case 4: Standalone CLI runner integration", () => {
    const cliPath = path.resolve("./bin/omp-sync.js");
    const bundleFile = path.join(TEST_DIR, "cli-bundle.enc");
    const cliTargetAgent = path.join(TEST_DIR, "cli-target", ".omp", "agent");
    fs.mkdirSync(cliTargetAgent, { recursive: true });

    // CLI export
    execFileSync(process.execPath, [
      cliPath,
      "export",
      bundleFile,
      "--pass",
      "cli-test-pass",
      "--root",
      SOURCE_AGENT,
    ]);
    assert.ok(fs.existsSync(bundleFile), "CLI export created archive file");

    // CLI dry-run import
    const dryRunOutput = execFileSync(process.execPath, [
      cliPath,
      "import",
      bundleFile,
      "--pass",
      "cli-test-pass",
      "--root",
      cliTargetAgent,
      "--dry-run",
    ]).toString("utf8");

    assert.ok(dryRunOutput.includes("[import-dry-run]"), "CLI dry-run reported correctly");
    assert.ok(
      !fs.existsSync(path.join(cliTargetAgent, "config.yml")),
      "CLI dry run did not touch filesystem"
    );

    // CLI real import
    const realImportOutput = execFileSync(process.execPath, [
      cliPath,
      "import",
      bundleFile,
      "--pass",
      "cli-test-pass",
      "--root",
      cliTargetAgent,
    ]).toString("utf8");

    assert.ok(realImportOutput.includes("[import] Successfully restored"), "CLI import succeeded");
    assert.ok(
      fs.existsSync(path.join(cliTargetAgent, "config.yml")),
      "CLI import wrote configuration files"
    );
  });

  await t.test("Test Case 5: Autonomous plugin rehydration and link repair", () => {
    const rehydrateTarget = path.join(TEST_DIR, "rehydrate-target");
    const rehydrateAgent = path.join(rehydrateTarget, ".omp", "agent");
    const rehydratePluginsDir = path.join(rehydrateTarget, ".omp", "plugins");
    fs.mkdirSync(rehydratePluginsDir, { recursive: true });

    // Create a mock plugin directory on disk to act as link source
    const mockPluginSrc = path.join(TEST_DIR, "mock-plugin");
    fs.mkdirSync(mockPluginSrc, { recursive: true });
    fs.writeFileSync(
      path.join(mockPluginSrc, "package.json"),
      JSON.stringify({ name: "mock-plugin", version: "1.0.0" })
    );

    // Write mock lockfile and .plugin-links.json
    fs.writeFileSync(
      path.join(rehydratePluginsDir, "omp-plugins.lock.json"),
      JSON.stringify({ plugins: { "mock-plugin": { version: "1.0.0", enabled: true } } })
    );
    fs.writeFileSync(
      path.join(rehydratePluginsDir, ".plugin-links.json"),
      JSON.stringify({ "mock-plugin": mockPluginSrc })
    );

    // Run rehydrate CLI command
    const cliPath = path.resolve("./bin/omp-sync.js");
    const output = execFileSync(process.execPath, [
      cliPath,
      "rehydrate",
      "--root",
      rehydrateAgent,
    ]).toString("utf8");

    assert.ok(output.includes("[rehydrate] Completed"), "Rehydrate command executed");
    const linkedPath = path.join(rehydratePluginsDir, "node_modules", "mock-plugin");
    assert.ok(fs.existsSync(linkedPath), "Symlink was created in node_modules");
    assert.equal(fs.realpathSync(linkedPath), mockPluginSrc, "Symlink points to target");
  });

  await t.test("Test Case 6: Model capability heuristics and filtering", () => {
    const filtered = filterChatModels([
      "text-embedding-3-small",
      "gpt-4o",
      "whisper-large-v3",
      "dall-e-3",
      "deepseek-r1",
    ]);
    assert.deepEqual(filtered, ["gpt-4o", "deepseek-r1"]);

    const m1 = inferModelCapabilities("deepseek-r1");
    assert.equal(m1.reasoning, true);
    assert.equal(m1.contextWindow, 128000);

    const m2 = inferModelCapabilities("gemini-3.8-flash-high");
    assert.equal(m2.reasoning, true);
    assert.deepEqual(m2.input, ["text", "image"]);
    assert.equal(m2.contextWindow, 256000);

    const m3 = inferModelCapabilities("kimi-k3.1-pro");
    assert.equal(m3.compat?.supportsForcedToolChoice, false);
  });

  await t.test("Test Case 7: Dual-tier provider storage separation", () => {
    const testAgent = path.join(TEST_DIR, "tier-agent");
    fs.mkdirSync(testAgent, { recursive: true });

    // 1. Save public provider
    saveProvider({
      name: "test-pub",
      providerConfig: {
        baseUrl: "https://pub.test/v1",
        api: "openai-completions",
        apiKey: "pub-key",
        models: [{ id: "m-pub", name: "Public Model" }],
      },
      isPrivate: false,
      agentDir: testAgent,
    });

    const pubYml = fs.readFileSync(path.join(testAgent, "models.yml"), "utf8");
    assert.ok(pubYml.includes("test-pub:"));
    assert.ok(!fs.existsSync(path.join(testAgent, "models.local.json")));

    // 2. Save private provider
    saveProvider({
      name: "test-priv",
      providerConfig: {
        baseUrl: "https://priv.test/v1",
        api: "openai-completions",
        apiKey: "priv-key",
        models: [{ id: "m-priv", name: "Private Model" }],
      },
      isPrivate: true,
      agentDir: testAgent,
    });

    const privJson = JSON.parse(
      fs.readFileSync(path.join(testAgent, "models.local.json"), "utf8")
    );
    assert.ok(privJson.providers["test-priv"]);
    const updatedPubYml = fs.readFileSync(path.join(testAgent, "models.yml"), "utf8");
    assert.ok(updatedPubYml.includes("test-priv:"), "Provider must be in models.yml so /model sees it");
    assert.ok(updatedPubYml.includes("private: true"), "Private provider must have private: true tag");

    // 3. Verify buildArchive strips private provider so it is never exported
    const { blob } = buildArchive("testpass", testAgent);
    const restoredTmp = path.join(TEST_DIR, "tier-restore-tmp");
    restoreArchive(blob, "testpass", restoredTmp);
    const restoredYml = fs.readFileSync(path.join(restoredTmp, "models.yml"), "utf8");
    assert.ok(restoredYml.includes("test-pub:"), "Public provider was exported");
    assert.ok(!restoredYml.includes("test-priv:"), "Private provider was NOT exported (zero leak)");
    // 4. List providers
    const list = listProviders({ agentDir: testAgent });
    assert.equal(list.length, 2);
    const pubItem = list.find((p) => p.name === "test-pub");
    const privItem = list.find((p) => p.name === "test-priv");
    assert.equal(pubItem.isPrivate, false);
    assert.equal(privItem.isPrivate, true);

    // 5. Remove provider
    removeProvider({ name: "test-pub", agentDir: testAgent });
    const listAfter = listProviders({ agentDir: testAgent });
    assert.equal(listAfter.length, 1);
    assert.equal(listAfter[0].name, "test-priv");
  });

  await t.test("Test Case 8: Role manager surgical updates and validation", () => {
    const roleAgent = path.join(TEST_DIR, "role-agent");
    fs.mkdirSync(roleAgent, { recursive: true });
    fs.writeFileSync(
      path.join(roleAgent, "config.yml"),
      "# Main Config\ntheme: titanium\nmodelRoles:\n  web: web/firecrawl\n"
    );

    // Set role
    setRole("smol", "custom-prov/smol-model", { agentDir: roleAgent, validate: false });
    const roles = getRoles(roleAgent);
    assert.equal(roles.web, "web/firecrawl");
    assert.equal(roles.smol, "custom-prov/smol-model");

    const content = fs.readFileSync(path.join(roleAgent, "config.yml"), "utf8");
    assert.ok(content.includes("# Main Config"), "Comments preserved");
    assert.ok(content.includes("theme: titanium"), "Unrelated settings preserved");

    // Invalid role rejected
    assert.throws(() => {
      setRole("invalid-role", "prov/mod", { agentDir: roleAgent, validate: false });
    });
  });

  await t.test("Test Case 9: Standalone CLI provider and role commands", () => {
    const cliAgent = path.join(TEST_DIR, "cli-agent");
    fs.mkdirSync(cliAgent, { recursive: true });
    fs.writeFileSync(path.join(cliAgent, "config.yml"), "theme: titanium\n");

    const cliPath = path.resolve("./bin/omp-sync.js");

    // Provider add via CLI (non-interactive, private)
    execFileSync(process.execPath, [
      cliPath,
      "provider",
      "add",
      "cli-test-provider",
      "--url",
      "https://example.com/v1",
      "--key",
      "dummy-key",
      "--model",
      "cli-test-model",
      "--role",
      "smol",
      "--private",
      "--yes",
      "--root",
      cliAgent,
    ]);

    // Check provider list CLI output
    const listOut = execFileSync(process.execPath, [
      cliPath,
      "provider",
      "list",
      "--root",
      cliAgent,
    ]).toString("utf8");
    assert.ok(listOut.includes("cli-test-provider"));
    assert.ok(listOut.includes("PRIVATE"));

    // Check role list CLI output
    const roleOut = execFileSync(process.execPath, [
      cliPath,
      "role",
      "list",
      "--root",
      cliAgent,
    ]).toString("utf8");
    assert.ok(roleOut.includes("cli-test-provider/cli-test-model"));
  });

  await t.test(
    "Test Case 10: Automatic storage maintenance, corrupt purging, backup pruning and debouncing",
    async () => {
      const maintAgent = path.join(TEST_DIR, "maint-agent");
      fs.mkdirSync(maintAgent, { recursive: true });

      // Create corrupt file
      fs.writeFileSync(path.join(maintAgent, "history.db.corrupt-test-123"), "crash dump");
      // Create obsolete file
      fs.writeFileSync(path.join(maintAgent, "models.local.json"), "{}");
      // Create 5 backup dirs
      for (let i = 1; i <= 5; i++) {
        fs.mkdirSync(path.join(maintAgent, `.import-backup-${1000 + i}`), { recursive: true });
      }

      // First run: forced
      const res1 = await runMaintenance({
        agentDir: maintAgent,
        skipGc: true,
        force: true,
        keepBackups: 3,
      });

      assert.equal(res1.skipped, false);
      assert.equal(res1.corruptCleaned.length, 1);
      assert.equal(res1.obsoletePurged.length, 1);
      assert.equal(res1.backupsPruned.length, 2);

      // Verify files removed
      assert.ok(!fs.existsSync(path.join(maintAgent, "history.db.corrupt-test-123")));
      assert.ok(!fs.existsSync(path.join(maintAgent, "models.local.json")));
      const remainingBackups = fs
        .readdirSync(maintAgent)
        .filter((f) => f.startsWith(".import-backup-"));
      assert.equal(remainingBackups.length, 3);

      // Second run: debounced
      const res2 = await runMaintenance({
        agentDir: maintAgent,
        skipGc: true,
        force: false,
      });
      assert.equal(res2.skipped, true);
      assert.equal(res2.reason, "debounced");
    }
  );

  teardownFixtures();
});
