/**
 * Universal, Zero-Repair Cross-Platform OMP Sync & Portability Engine
 * Exports an encrypted AES-256-GCM blob (scrypt-derived key); import restores files,
 * remaps host paths adaptively, and maintains atomic backups for instant rollback.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  rehydratePlugins,
  getPluginLinks,
  savePluginLinks,
  detectMissingPlugins,
} from "./src/rehydrator.js";

export {
  rehydratePlugins,
  getPluginLinks,
  savePluginLinks,
  detectMissingPlugins,
};
import {
  probeProvider,
  inferModelCapabilities,
  filterChatModels,
} from "./src/prober.js";
import {
  saveProvider,
  removeProvider,
  listProviders,
  getProvider,
  readPublicProviders,
  writePublicProviders,
  readPrivateProviders,
  writePrivateProviders,
  ensureLocalExtension,
  parseYamlModels,
  formatYamlModels,
} from "./src/provider-store.js";
import { getRoles, setRole, VALID_ROLES } from "./src/role-manager.js";
import {
  runMaintenance,
  cleanCorruptFiles,
  pruneOldBackups,
  cleanObsoleteFiles,
  runOmpGc,
  scheduleAutoMaintenance,
  getCronStatus,
  installCron,
  removeCron,
} from "./src/maintenance.js";

export {
  probeProvider,
  inferModelCapabilities,
  filterChatModels,
  saveProvider,
  removeProvider,
  listProviders,
  getProvider,
  readPublicProviders,
  writePublicProviders,
  readPrivateProviders,
  writePrivateProviders,
  ensureLocalExtension,
  getRoles,
  setRole,
  VALID_ROLES,
  runMaintenance,
  cleanCorruptFiles,
  pruneOldBackups,
  cleanObsoleteFiles,
  runOmpGc,
  scheduleAutoMaintenance,
  getCronStatus,
  installCron,
  removeCron,
};

const MAGIC = Buffer.from("OMPCFG1\0", "latin1");
const HOME_PLACEHOLDER = "{{OMP_HOME}}";

const FILES = [
  "config.yml",
  "config.yaml",
  "models.yml",
  "models.yaml",
  "mcp.json",
  "AGENTS.md",
  "STYLE.md",
  "RULES.md",
];

const DIRS = ["memories", "managed-skills"];

const BLACKLIST_PATTERNS = [
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.corrupt-/,
  /\.local\./,
  /\.local\//,
  /(^|\/)local-/,
  /^\.import-backup/,
  /\/\.import-backup/,
  /^\.rolled-back/,
  /\/\.rolled-back/,
  /(^|\/)\.git\//,
  /(^|\/)cache\//,
  /(^|\/)blobs\//,
  /(^|\/)sessions\//,
  /(^|\/)terminal-sessions\//,
  /(^|\/)predict\//,
  /(^|\/)node_modules\//,
];

/** User agent directory, or OMP_CFG_ROOT for tests. */
export function configRoot() {
  return process.env.OMP_CFG_ROOT || path.join(os.homedir(), ".omp", "agent");
}

/** Root .omp folder (parent of agent directory). */
export function ompHome(root = configRoot()) {
  return process.env.OMP_HOME || path.dirname(root);
}

function shouldIgnore(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  return BLACKLIST_PATTERNS.some((rx) => rx.test(norm));
}

function isText(buf) {
  const len = Math.min(buf.length, 1024);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

function walk(dir, prefix = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!shouldIgnore(rel + "/")) {
        out.push(...walk(abs, rel));
      }
    } else if (ent.isFile()) {
      if (!shouldIgnore(rel)) {
        out.push(rel);
      }
    }
  }
  return out;
}

export function collect(root) {
  const out = [];
  const seen = new Set();

  function addItem(rel, abs) {
    const norm = rel.replace(/\\/g, "/");
    if (!seen.has(norm) && !shouldIgnore(norm) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      seen.add(norm);
      out.push({ rel: norm, abs });
    }
  }

  // 1. Files directly under root (agent/)
  if (fs.existsSync(root)) {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.isFile()) {
        const name = ent.name;
        const isCore = FILES.includes(name);
        const isToken = name.includes("token");
        const isExtra = name.endsWith(".yml") || name.endsWith(".yaml") || name.endsWith(".json");
        if (isCore || isToken || isExtra) {
          addItem(name, path.join(root, name));
        }
      }
    }

    // 2. Category directories under root (memories, managed-skills)
    for (const d of DIRS) {
      const base = path.join(root, d);
      if (fs.existsSync(base)) {
        for (const file of walk(base)) {
          addItem(`${d}/${file}`, path.join(base, file));
        }
      }
    }
  }

  // 3. User extensions under ~/.omp/extensions/ (sibling to agent/)
  const ompDir = ompHome(root);
  const extDir = path.join(ompDir, "extensions");
  if (fs.existsSync(extDir) && fs.statSync(extDir).isDirectory()) {
    for (const file of walk(extDir)) {
      addItem(`extensions/${file}`, path.join(extDir, file));
    }
  }

  // 4. Installed plugins lockfile & manifest under ~/.omp/plugins/
  const pluginsDir = path.join(ompDir, "plugins");
  const links = getPluginLinks(pluginsDir);
  if (Object.keys(links).length > 0) {
    savePluginLinks(pluginsDir, links);
  }
  const linksFile = path.join(pluginsDir, ".plugin-links.json");
  if (fs.existsSync(linksFile) && fs.statSync(linksFile).isFile()) {
    addItem("plugins/.plugin-links.json", linksFile);
  }
  const lockFile = path.join(pluginsDir, "omp-plugins.lock.json");
  if (fs.existsSync(lockFile) && fs.statSync(lockFile).isFile()) {
    addItem("plugins/omp-plugins.lock.json", lockFile);
  }
  const pluginPkg = path.join(pluginsDir, "package.json");
  if (fs.existsSync(pluginPkg) && fs.statSync(pluginPkg).isFile()) {
    addItem("plugins/package.json", pluginPkg);
  }
  // 5. Global tools under ~/.omp/tools/
  const toolsDir = path.join(ompDir, "tools");
  if (fs.existsSync(toolsDir) && fs.statSync(toolsDir).isDirectory()) {
    for (const file of walk(toolsDir)) {
      addItem(`tools/${file}`, path.join(toolsDir, file));
    }
  }

  // 6. Global hooks under ~/.omp/hooks/
  const hooksDir = path.join(ompDir, "hooks");
  if (fs.existsSync(hooksDir) && fs.statSync(hooksDir).isDirectory()) {
    for (const file of walk(hooksDir)) {
      addItem(`hooks/${file}`, path.join(hooksDir, file));
    }
  }

  return out;
}

/** Determine target path for relative archive key. */
export function resolveDestination(rel, root = configRoot()) {
  const norm = rel.replace(/\\/g, "/");
  if (
    norm.startsWith("extensions/") ||
    norm.startsWith("plugins/") ||
    norm.startsWith("tools/") ||
    norm.startsWith("hooks/")
  ) {
    return path.join(ompHome(root), norm);
  }
  return path.join(root, norm);
}

/** Build the encrypted archive in memory with path sanitization. */
export function buildArchive(pass, root = configRoot()) {
  if (!pass) throw new Error("empty passphrase");
  const items = collect(root);
  const home = os.homedir();
  const homePosix = home.replace(/\\/g, "/");

  const files = items.map(({ rel, abs }) => {
    let raw = fs.readFileSync(abs);
    const mode = fs.statSync(abs).mode & 0o777;

    // Sanitize private providers from models.yml so they are never exported to cloud
    if (rel === "models.yml" || rel === "models.yaml") {
      try {
        const providers = parseYamlModels(raw.toString("utf8"));
        const publicProviders = {};
        for (const [name, cfg] of Object.entries(providers)) {
          if (!cfg.private) {
            publicProviders[name] = cfg;
          }
        }
        raw = Buffer.from(formatYamlModels(publicProviders), "utf8");
      } catch {}
    }
    let data;
    if (isText(raw)) {
      let str = raw.toString("utf8");
      if (home) {
        str = str.split(home).join(HOME_PLACEHOLDER);
        if (homePosix !== home) {
          str = str.split(homePosix).join(HOME_PLACEHOLDER);
        }
      }
      data = Buffer.from(str, "utf8").toString("base64");
    } else {
      data = raw.toString("base64");
    }
    return { path: rel, data, mode };
  });

  const payload = {
    v: 2,
    createdAt: new Date().toISOString(),
    sourceHome: home,
    sourcePlatform: process.platform,
    files,
  };

  const plain = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const blob = Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct]);
  return { blob, files: files.length };
}

/** Restore an encrypted archive buffer into the config tree with adaptive remapping. */
export function restoreArchive(blob, pass, root = configRoot(), options = {}) {
  if (!pass) throw new Error("empty passphrase");
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not an omp-config-crypt archive");
  }

  let o = MAGIC.length;
  const salt = blob.subarray(o, (o += 16));
  const iv = blob.subarray(o, (o += 12));
  const tag = blob.subarray(o, (o += 16));
  const ct = blob.subarray(o);
  const key = scryptSync(pass, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const payload = JSON.parse(gunzipSync(Buffer.concat([decipher.update(ct), decipher.final()])).toString("utf8"));
  if (![1, 2].includes(payload.v) || !Array.isArray(payload.files)) {
    throw new Error("unsupported archive payload");
  }

  const dryRun = Boolean(options.dryRun);
  const targetHome = os.homedir();
  const targetHomePosix = targetHome.replace(/\\/g, "/");
  const sourceHome = payload.sourceHome;
  const backupDir = path.join(root, `.import-backup-${Date.now()}`);
  const actions = [];
  let restored = 0;

  for (const f of payload.files) {
    const rel = String(f.path || "").replace(/\\/g, "/");
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
      throw new Error(`unsafe path in archive: ${rel}`);
    }

    const dst = resolveDestination(rel, root);
    let buf = Buffer.from(f.data, "base64");
    let remapped = false;

    if (payload.v >= 2 && isText(buf)) {
      let str = buf.toString("utf8");
      const orig = str;

      const isJsonOrYaml = rel.endsWith(".json") || rel.endsWith(".yml") || rel.endsWith(".yaml");
      const effectiveHome = process.platform === "win32" && isJsonOrYaml ? targetHomePosix : targetHome;

      str = str.split(HOME_PLACEHOLDER).join(effectiveHome);
      if (sourceHome) {
        str = str.split(sourceHome).join(effectiveHome);
        const sourceHomePosix = sourceHome.replace(/\\/g, "/");
        if (sourceHomePosix !== sourceHome) {
          str = str.split(sourceHomePosix).join(effectiveHome);
        }
      }

      if (str !== orig) {
        remapped = true;
        buf = Buffer.from(str, "utf8");
      }
    }
    const exists = fs.existsSync(dst);

    // Intelligently merge existing local private providers in models.yml so they are never overwritten
    if ((rel === "models.yml" || rel === "models.yaml") && exists) {
      try {
        const existingRaw = fs.readFileSync(dst, "utf8");
        const existingProviders = parseYamlModels(existingRaw);
        const privateProviders = {};
        for (const [name, cfg] of Object.entries(existingProviders)) {
          if (cfg.private) {
            privateProviders[name] = cfg;
          }
        }
        if (Object.keys(privateProviders).length > 0) {
          const incomingProviders = parseYamlModels(buf.toString("utf8"));
          const merged = { ...incomingProviders, ...privateProviders };
          buf = Buffer.from(formatYamlModels(merged), "utf8");
        }
      } catch {}
    }
    actions.push({ path: rel, dest: dst, exists, remapped });

    if (!dryRun) {
      if (exists) {
        const b = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(dst, b);
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf, { mode: f.mode || 0o600 });
    }
    restored++;
  }

  let rehydration = null;
  if (options.rehydrate !== false && !dryRun) {
    const hasPluginChanges = actions.some((a) => a.path.startsWith("plugins/"));
    if (hasPluginChanges || options.rehydrate === true) {
      rehydration = rehydratePlugins(root, options);
    }
  }

  const purged = [];
  if (!dryRun) {
    const obsoleteCandidates = [
      path.join(ompHome(root), "extensions", "agy.js"),
      path.join(ompHome(root), "extensions", "local-models.js"),
      path.join(root, "models.local.json"),
    ];
    for (const p of obsoleteCandidates) {
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { force: true });
          purged.push(p);
        } catch {}
      }
    }
  }

  return {
    files: restored,
    dryRun,
    actions,
    purged,
    backupDir: !dryRun && fs.existsSync(backupDir) ? backupDir : null,
    rehydration,
  };
}

/** Revert the most recent config restore from its backup. */
export function rollback(root = configRoot()) {
  if (!fs.existsSync(root)) throw new Error(`Root directory does not exist: ${root}`);
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(".import-backup-"))
    .map((e) => e.name)
    .sort()
    .reverse();

  if (backups.length === 0) {
    throw new Error("No import backup found to rollback");
  }

  const latest = backups[0];
  const backupDir = path.join(root, latest);
  const files = walk(backupDir);
  let restored = 0;

  for (const rel of files) {
    const src = path.join(backupDir, rel);
    const dst = resolveDestination(rel, root);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    restored++;
  }

  const rolledBackDir = path.join(root, `.rolled-back-${latest.replace(".import-backup-", "")}`);
  fs.renameSync(backupDir, rolledBackDir);

  return { files: restored, rolledBackFrom: latest };
}

/** Write an encrypted archive of the config tree. */
export function exportEncrypted(outFile, pass, root = configRoot()) {
  const { blob, files } = buildArchive(pass, root);
  const abs = path.resolve(outFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, blob, { mode: 0o600 });
  return { outFile: abs, files, bytes: blob.length };
}

/** Restore files from an encrypted archive, backing up overwritten ones. */
export function importEncrypted(srcFile, pass, root = configRoot(), options = {}) {
  return restoreArchive(fs.readFileSync(srcFile), pass, root, options);
}

async function askPass(ctx, title) {
  if (process.env.OMP_CONFIG_PASS) return process.env.OMP_CONFIG_PASS;
  const input = ctx?.ui?.input;
  if (typeof input === "function") {
    let value;
    try {
      value = await input.call(ctx.ui, { title, prompt: title, placeholder: "passphrase" });
    } catch {
      try {
        value = await input.call(ctx.ui, title);
      } catch {
        value = undefined;
      }
    }
    if (typeof value === "string" && value) return value;
  }
  throw new Error("no passphrase: set OMP_CONFIG_PASS or answer the prompt");
}

function envToken() {
  return process.env.OMP_CFG_CLOUD_TOKEN || process.env.GITHUB_TOKEN || null;
}

async function askToken(ctx, title, required) {
  const fromEnv = envToken();
  if (fromEnv) return fromEnv;
  const input = ctx?.ui?.input;
  if (typeof input === "function") {
    let value;
    try {
      value = await input.call(ctx.ui, {
        title,
        prompt: title,
        placeholder: required ? "token" : "token (empty = none)",
      });
    } catch {
      try {
        value = await input.call(ctx.ui, title);
      } catch {
        value = undefined;
      }
    }
    if (typeof value === "string" && value.trim()) return value.trim();
    if (!required) return null;
  }
  if (required) throw new Error("token required: set OMP_CFG_CLOUD_TOKEN or enter it when asked");
  return null;
}

const GIST_FILE = "omp-config.enc.b64";

async function gh(token, pathname, init = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Push the archive to a secret gist; returns its id and URL. */
export async function pushGist(id, pass, root = configRoot(), token = envToken()) {
  if (!token) throw new Error("GitHub token required: set OMP_CFG_CLOUD_TOKEN or GITHUB_TOKEN");
  const { blob, files } = buildArchive(pass, root);
  const content = blob.toString("base64");
  const body = { files: { [GIST_FILE]: { content } } };
  const data =
    id && id !== "new"
      ? await gh(token, `/gists/${id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await gh(token, `/gists`, {
          method: "POST",
          body: JSON.stringify({ description: "omp config (encrypted)", public: false, ...body }),
        });
  return { id: data.id, url: data.html_url, files, bytes: blob.length };
}

/** Pull the archive from a secret gist. */
export async function pullGist(id, pass, root = configRoot(), token = envToken(), options = {}) {
  if (!token) throw new Error("GitHub token required: set OMP_CFG_CLOUD_TOKEN or GITHUB_TOKEN");
  const data = await gh(token, `/gists/${id}`);
  const content = data?.files?.[GIST_FILE]?.content;
  if (!content) throw new Error(`gist ${id} has no ${GIST_FILE}`);
  return restoreArchive(Buffer.from(content, "base64"), pass, root, options);
}

/** Push to any endpoint accepting PUT (presigned S3, WebDAV, custom). */
export async function pushHttp(url, pass, root = configRoot(), token = envToken()) {
  const { blob, files } = buildArchive(pass, root);
  const headers = { "content-type": "application/octet-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "PUT",
    body: blob,
    signal: AbortSignal.timeout(30_000),
    headers,
  });
  if (!res.ok) throw new Error(`PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { url, files, bytes: blob.length };
}

/** Pull from any endpoint serving the archive. */
export async function pullHttp(url, pass, root = configRoot(), token = envToken(), options = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return restoreArchive(Buffer.from(await res.arrayBuffer()), pass, root, options);
}

export function parseSpec(spec) {
  const s = spec.trim();
  if (s.startsWith("gist:")) return { kind: "gist", id: s.slice(5) || "new" };
  if (/^https?:\/\//.test(s)) return { kind: "http", url: s };
  throw new Error("expected gist:<id|new> or an https URL");
}

function extractDryRun(str) {
  const dryRun = /\b--dry-run\b/i.test(str);
  const clean = str.replace(/\b--dry-run\b/gi, "").trim();
  return { dryRun, clean };
}

/** Plugin entry: local and cloud config portability. */
export default function (pi) {
  pi.registerCommand("config-export", {
    description: "Encrypt omp config + instructions to a file",
    handler: async (args, ctx) => {
      const out = (args || "").trim() || path.join(os.homedir(), `omp-config-${Date.now()}.enc`);
      try {
        const pass = await askPass(ctx, "Export passphrase");
        const r = exportEncrypted(out, pass);
        ctx.ui.notify(`exported ${r.files} files (${r.bytes} B) → ${r.outFile}`, "info");
      } catch (error) {
        ctx.ui.notify(`config-export failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("config-import", {
    description: "Decrypt and restore an omp config archive (--dry-run to preview)",
    handler: async (args, ctx) => {
      const { dryRun, clean: src } = extractDryRun(args || "");
      if (!src) {
        ctx.ui.notify("usage: /config-import <file.enc> [--dry-run]", "error");
        return;
      }
      try {
        const pass = await askPass(ctx, "Import passphrase");
        const r = importEncrypted(src, pass, configRoot(), { dryRun });
        if (dryRun) {
          ctx.ui.notify(`[dry-run] would restore ${r.files} files; 0 written`, "info");
        } else {
          ctx.ui.notify(`restored ${r.files} files${r.backupDir ? ` (backup: ${r.backupDir})` : ""}; restart omp`, "info");
        }
      } catch (error) {
        ctx.ui.notify(`config-import failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("config-push", {
    description: "Encrypt and upload config to gist:<id|new> or an https URL",
    handler: async (args, ctx) => {
      const spec = (args || "").trim();
      if (!spec) {
        ctx.ui.notify("usage: /config-push gist:new | gist:<id> | https://…", "error");
        return;
      }
      try {
        const target = parseSpec(spec);
        const pass = await askPass(ctx, "Push passphrase");
        const token = await askToken(ctx, "Cloud token", target.kind === "gist");
        const r = target.kind === "gist"
          ? await pushGist(target.id, pass, configRoot(), token)
          : await pushHttp(target.url, pass, configRoot(), token);
        const where = r.url ? `${r.url} (id ${r.id})` : r.url;
        ctx.ui.notify(`pushed ${r.files} files (${r.bytes} B) → ${where}`, "info");
      } catch (error) {
        ctx.ui.notify(`config-push failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("config-pull", {
    description: "Download and decrypt config from gist:<id> or an https URL (--dry-run to preview)",
    handler: async (args, ctx) => {
      const { dryRun, clean: spec } = extractDryRun(args || "");
      if (!spec) {
        ctx.ui.notify("usage: /config-pull gist:<id> | https://… [--dry-run]", "error");
        return;
      }
      try {
        const target = parseSpec(spec);
        const pass = await askPass(ctx, "Pull passphrase");
        const token = await askToken(ctx, "Cloud token", target.kind === "gist");
        const r = target.kind === "gist"
          ? await pullGist(target.id, pass, configRoot(), token, { dryRun })
          : await pullHttp(target.url, pass, configRoot(), token, { dryRun });
        if (dryRun) {
          ctx.ui.notify(`[dry-run] would restore ${r.files} files; 0 written`, "info");
        } else {
          const rehydratedCount = r.rehydration?.rehydrated ?? 0;
          const rehydratedMsg = rehydratedCount > 0 ? `, rehydrated ${rehydratedCount} plugins` : "";
          ctx.ui.notify(`restored ${r.files} files${rehydratedMsg}${r.backupDir ? ` (backup: ${r.backupDir})` : ""}; restart omp`, "info");
        }
      } catch (error) {
        ctx.ui.notify(`config-pull failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("config-rollback", {
    description: "Revert the latest config restore from its backup snapshot",
    handler: async (_args, ctx) => {
      try {
        const r = rollback(configRoot());
        ctx.ui.notify(`rolled back ${r.files} files from ${r.rolledBackFrom}`, "info");
      } catch (error) {
        ctx.ui.notify(`config-rollback failed: ${error?.message ?? error}`, "error");
      }
    },
  });
  pi.registerCommand("provider", {
    description: "Manage LLM providers (/provider ls | add <name> <url> <key> | rm <name>)",
    getArgumentCompletions: (prefix) => {
      const parts = (prefix || "").split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (!prefix.includes(" ") || parts.length <= 1) {
        const subcommands = [
          { value: "add", description: "Auto-probe and add a new provider (wizard)" },
          { value: "ls", description: "List all configured providers & models" },
          { value: "rm", description: "Remove a provider from configuration" },
        ];
        const p = parts[0]?.toLowerCase() || "";
        return subcommands.filter((s) => s.value.startsWith(p));
      }

      if (sub === "rm" || sub === "remove") {
        if (parts.length === 2) {
          const providers = listProviders({ agentDir: configRoot() });
          const target = parts[1].toLowerCase();
          return providers
            .map((p) => ({
              value: p.name,
              description: `${p.isPrivate ? "Private" : "Public"} (${p.models.length} models)`,
            }))
            .filter((i) => i.value.toLowerCase().startsWith(target));
        }
      }

      if (sub === "add") {
        const last = parts[parts.length - 1];
        if (last.startsWith("-")) {
          const flags = [
            { value: "--private", description: "Save to local-only, unsynced store (default)" },
            { value: "--public", description: "Save to synced models.yml" },
          ];
          return flags.filter((f) => f.value.startsWith(last));
        }
      }

      return null;
    },
    handler: async (args, ctx) => {
      const cleanArgs = (args || "").trim();
      const parts = cleanArgs.split(/\s+/).filter(Boolean);
      const sub = parts[0] || "ls";

      try {
        if (sub === "ls" || sub === "list") {
          const list = listProviders({ agentDir: configRoot() });
          if (list.length === 0) {
            ctx.ui.notify("No providers configured in public or private stores.", "info");
            return;
          }
          const roles = getRoles(configRoot());
          const lines = list.map((p) => {
            const tier = p.isPrivate ? "PRIVATE (local-only)" : "PUBLIC (synced)";
            const boundRoles = Object.entries(roles)
              .filter(([_, ref]) => ref.startsWith(`${p.name}/`))
              .map(([r]) => r);
            const roleStr = boundRoles.length > 0 ? ` [roles: ${boundRoles.join(",")}]` : "";
            return `${p.name} (${tier}, ${p.models.length} models)${roleStr}`;
          });
          ctx.ui.notify(`Providers:\n${lines.join("\n")}`, "info");
          return;
        }

        if (sub === "rm" || sub === "remove") {
          const name = parts[1];
          if (!name) {
            ctx.ui.notify("Usage: /provider rm <name>", "error");
            return;
          }
          const removed = removeProvider({ name, agentDir: configRoot() });
          if (removed) {
            ctx.ui.notify(`Removed provider '${name}'`, "info");
          } else {
            ctx.ui.notify(`Provider '${name}' not found`, "warning");
          }
          return;
        }

        if (sub === "add" || sub === "wizard") {
          let name = parts[1];
          let url = parts[2];
          let key = parts[3] || "";
          let isPrivate = cleanArgs.includes("--private") || !cleanArgs.includes("--public");

          if ((!name || !url) && typeof ctx?.ui?.input === "function") {
            try {
              if (!name) {
                name = await ctx.ui.input({
                  title: "Provider Name",
                  prompt: "Enter unique provider name (e.g. my-private-llm):",
                  placeholder: "my-private-llm",
                });
              }
              if (!url) {
                url = await ctx.ui.input({
                  title: "Endpoint URL",
                  prompt: "Enter endpoint baseUrl (e.g. https://api.openai.com/v1):",
                  placeholder: "https://api.openai.com/v1",
                });
              }
              if (!key) {
                key = (await ctx.ui.input({
                  title: "API Key",
                  prompt: "Enter API Key (leave blank if none):",
                  placeholder: "sk-...",
                })) || "";
              }
            } catch {}
          }

          if (!name || !url) {
            ctx.ui.notify("Usage: /provider add <name> <url> [key] [--private|--public]", "error");
            return;
          }
          ctx.ui.notify(`Probing endpoint ${url}...`, "info");
          const probed = await probeProvider({
            baseUrl: url,
            apiKey: key,
            providerName: name,
          });

          if (!probed.ok) {
            ctx.ui.notify(`Probe failed: ${probed.error}`, "error");
            return;
          }

          saveProvider({
            name,
            providerConfig: {
              baseUrl: probed.normalizedBaseUrl,
              api: probed.api,
              apiKey: key,
              models: probed.models,
            },
            isPrivate,
            agentDir: configRoot(),
          });

          ctx.ui.notify(
            `Added ${isPrivate ? "private" : "public"} provider '${name}' with ${probed.models.length} model(s) at ${probed.normalizedBaseUrl}`,
            "info"
          );
          return;
        }

        ctx.ui.notify("Usage: /provider [ls | add <name> <url> [key] [--private] | rm <name>]", "info");
      } catch (err) {
        ctx.ui.notify(`Provider command error: ${err.message || err}`, "error");
      }
    },
  });

  pi.registerCommand("role", {
    description: "Manage model roles (/role ls | <role> <provider/model>)",
    getArgumentCompletions: (prefix) => {
      const parts = (prefix || "").split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (!prefix.includes(" ") || parts.length <= 1) {
        const roles = [
          { value: "default", description: "Primary chat & orchestration model" },
          { value: "smol", description: "Fast model for lightweight tasks & tools" },
          { value: "plan", description: "High-context architectural planning model" },
          { value: "slow", description: "Deep reasoning / hard debugging model" },
          { value: "web", description: "Web search provider model" },
          { value: "ls", description: "List current role mappings" },
        ];
        const p = parts[0]?.toLowerCase() || "";
        return roles.filter((r) => r.value.startsWith(p));
      }

      if (VALID_ROLES.includes(sub)) {
        if (parts.length === 2) {
          const providers = listProviders({ agentDir: configRoot() });
          const models = [];
          for (const p of providers) {
            for (const m of p.models) {
              const ref = `${p.name}/${m.id}`;
              const desc = [
                p.isPrivate ? "private" : "public",
                m.reasoning ? "reasoning" : null,
                m.input?.includes("image") ? "vision" : null,
              ]
                .filter(Boolean)
                .join(", ");
              models.push({ value: ref, description: `${m.name || m.id} [${desc}]` });
            }
          }
          const target = parts[1].toLowerCase();
          return models.filter((m) => m.value.toLowerCase().startsWith(target));
        }
      }

      return null;
    },
    handler: async (args, ctx) => {
      const cleanArgs = (args || "").trim();
      const parts = cleanArgs.split(/\s+/).filter(Boolean);

      try {
        if (!cleanArgs || parts[0] === "ls" || parts[0] === "list") {
          const roles = getRoles(configRoot());
          const str = Object.entries(roles)
            .map(([r, m]) => `${r}: ${m}`)
            .join(", ");
          ctx.ui.notify(`Model Roles: ${str || "none"}`, "info");
          return;
        }

        const role = parts[0];
        const modelRef = parts[1];
        if (!role || !modelRef) {
          ctx.ui.notify("Usage: /role <default|smol|plan|slow|web> <provider/model>", "error");
          return;
        }

        setRole(role, modelRef, { agentDir: configRoot() });
        ctx.ui.notify(`Set role '${role}' -> ${modelRef}`, "info");
      } catch (err) {
        ctx.ui.notify(`Role command error: ${err.message || err}`, "error");
      }
    },
  });

  // Register maintenance command (/maint or /gc)
  pi.registerCommand("maint", {
    description: "Run storage maintenance, WAL checkpoint, and garbage collection (/maint [--force])",
    handler: async (args, ctx) => {
      const force = (args || "").includes("--force");
      ctx.ui.notify("Running storage maintenance & garbage collection...", "info");
      try {
        const res = await runMaintenance({
          agentDir: configRoot(),
          force: true, // User manual trigger always forces execution
        });

        const parts = [];
        if (res.corruptCleaned?.length > 0) parts.push(`cleaned ${res.corruptCleaned.length} corrupt file(s)`);
        if (res.backupsPruned?.length > 0) parts.push(`pruned ${res.backupsPruned.length} backup snapshot(s)`);
        if (res.obsoletePurged?.length > 0) parts.push(`purged ${res.obsoletePurged.length} obsolete file(s)`);
        if (res.gc?.success) parts.push("WAL checkpointed & GC complete");

        const msg = parts.length > 0 ? `Maintenance complete: ${parts.join(", ")}.` : "Storage is already optimal. No cleanup needed.";
        ctx.ui.notify(msg, "info");
      } catch (err) {
        ctx.ui.notify(`Maintenance error: ${err.message || err}`, "error");
      }
    },
  });

  // Register in-session upgrade command (/upgrade [check|plugins])
  pi.registerCommand("upgrade", {
    description: "Check for and apply updates for OMP and plugins (/upgrade [check|plugins])",
    handler: async (args, ctx) => {
      const clean = (args || "").trim().toLowerCase();
      if (clean === "check") {
        ctx.ui.notify("Checking for OMP updates...", "info");
        try {
          const { exec } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(exec);
          const { stdout } = await execAsync("omp update --check");
          ctx.ui.notify(stdout.trim() || "Check complete.", "info");
        } catch (err) {
          ctx.ui.notify(`Check error: ${err.message}`, "error");
        }
        return;
      }

      const pluginsOnly = clean === "plugins";
      ctx.ui.notify(pluginsOnly ? "Upgrading all plugins..." : "Upgrading OMP core & plugins in background...", "info");
      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        const cmd = pluginsOnly ? "omp plugin upgrade" : "omp update -l";
        const { stdout, stderr } = await execAsync(cmd);
        const output = (stdout + "\n" + stderr).trim().split("\n").filter(Boolean).slice(-2).join("; ");
        ctx.ui.notify(`Update finished: ${output || "Success"}. Restart OMP to apply kernel changes.`, "info");
      } catch (err) {
        ctx.ui.notify(`Upgrade error: ${err.message}`, "error");
      }
    },
  });

  // Launch non-blocking background auto-maintenance (debounced every 24h)
  try {
    scheduleAutoMaintenance(configRoot(), 4000);
  } catch {}
}
