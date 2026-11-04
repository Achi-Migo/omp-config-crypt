/**
 * Universal, Zero-Repair Cross-Platform OMP Sync & Portability Engine
 * Exports an encrypted AES-256-GCM blob (scrypt-derived key); import restores files,
 * remaps host paths adaptively, and maintains atomic backups for instant rollback.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
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
import { handleProviderCommand, providerCompletions } from "./src/provider-menu.js";
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

// New public/private sync infrastructure
import { configRoot, ompHome, resolveDestination } from "./src/sync-files.js";
export { configRoot, ompHome, resolveDestination };
import {
  POLICY_FILE,
  readSyncPolicy,
  setResourceScope,
  resolveResourceScope,
  resolveSyncNamespace,
  validateResourceId,
  checkSettingOverlap,
} from "./src/sync-policy.js";
import {
  inventoryResources,
  readResource,
  sanitizeResourceForExport,
  restoreResourceForImport,
  HOME_PLACEHOLDER,
} from "./src/sync-resources.js";
import {
  STATE_FILE,
  SENTINEL_DELETED,
  canonicalHash,
  readSyncState,
  writeSyncState,
  validateSnapshot,
  inspectArchivePayload,
  adaptLegacySnapshot,
  planSync,
} from "./src/sync-plan.js";
import {
  applySyncPlan,
  rollbackSync,
  commitFileTransaction,
} from "./src/sync-transaction.js";
import {
  createReadContext,
  withSyncLock,
} from "./src/sync-files.js";

export {
  POLICY_FILE,
  readSyncPolicy,
  setResourceScope,
  resolveResourceScope,
  validateResourceId,
  checkSettingOverlap,
  inventoryResources,
  readResource,
  sanitizeResourceForExport,
  restoreResourceForImport,
  STATE_FILE,
  SENTINEL_DELETED,
  canonicalHash,
  readSyncState,
  writeSyncState,
  validateSnapshot,
  inspectArchivePayload,
  adaptLegacySnapshot,
  planSync,
  applySyncPlan,
  rollbackSync,
  commitFileTransaction,
};

const MAGIC = Buffer.from("OMPCFG1\0", "latin1");

/**
 * Collect is now defined strictly as the read-only file projection of public resources.
 * Zero side-effects; never writes disk or .plugin-links.json.
 */
export function collect(root = configRoot()) {
  const policy = readSyncPolicy(root);
  const state = readSyncState(root);
  const inventory = inventoryResources(root);

  const out = [];
  const seen = new Set();

  function addItem(rel, abs) {
    const norm = rel.replace(/\\/g, "/");
    if (!seen.has(norm) && fs.existsSync(abs)) {
      seen.add(norm);
      out.push({ rel: norm, abs });
    }
  }

  for (const item of inventory) {
    const scopeInfo = resolveResourceScope(item.id, policy, state, item);
    if (scopeInfo.scope === "public") {
      if (item.category === "provider") {
        let y = path.join(root, "models.yml");
        if (!fs.existsSync(y) && fs.existsSync(path.join(root, "models.yaml"))) {
          y = path.join(root, "models.yaml");
        }
        addItem(path.basename(y), y);
      } else if (item.category === "mcp") {
        addItem("mcp.json", path.join(root, "mcp.json"));
      } else if (item.category === "setting") {
        let c = path.join(root, "config.yml");
        if (!fs.existsSync(c) && fs.existsSync(path.join(root, "config.yaml"))) {
          c = path.join(root, "config.yaml");
        }
        addItem(path.basename(c), c);
      } else if (item.category === "plugin") {
        const pdir = path.join(ompHome(root), "plugins");
        addItem("plugins/package.json", path.join(pdir, "package.json"));
        const lockPath = path.join(pdir, "omp-plugins.lock.json");
        if (fs.existsSync(lockPath)) {
          addItem("plugins/omp-plugins.lock.json", lockPath);
        }
      } else if (item.category === "asset") {
        const readRes = readResource(root, item.id);
        if (readRes && Array.isArray(readRes.value)) {
          for (const f of readRes.value) {
            addItem(f.path, resolveDestination(f.path, root));
          }
        }
      }
    }
  }

  return out;
}

/**
 * Builds the encrypted archive v3 containing only classified public resources and tombstones.
 */
export function buildArchive(pass, root = configRoot()) {
  if (!pass) throw new Error("empty passphrase");
  const policy = readSyncPolicy(root);
  const state = readSyncState(root);
  const namespace = resolveSyncNamespace(policy, state);
  if (!namespace) {
    throw new Error("No sync namespace established; classify the first public resource before export/push");
  }
  const inventory = inventoryResources(root);

  const publicResources = [];
  const activePublicIds = new Set();

  for (const item of inventory) {
    const scopeInfo = resolveResourceScope(item.id, policy, state, item);
    if (scopeInfo.scope === "public") {
      activePublicIds.add(item.id);
      const readRes = readResource(root, item.id);
      if (!readRes || !Object.hasOwn(readRes, "value")) {
        throw new Error(`Public resource '${item.id}' is missing during export; fix the resource or mark it private`);
      }
      publicResources.push({
        id: item.id,
        value: sanitizeResourceForExport(item.id, readRes.value, root),
      });
    }
  }

  // Tombstones calculation:
  // Baseline-managed items that are now deleted or marked private
  const tombstonesSet = new Set(state.tombstones || []);
  if (state.resources) {
    for (const [id, rec] of Object.entries(state.resources)) {
      if (rec.hash && rec.hash !== SENTINEL_DELETED) {
        if (!activePublicIds.has(id)) {
          tombstonesSet.add(id);
        }
      }
    }
  }
  // Clear any ID that is currently active public
  for (const id of activePublicIds) {
    tombstonesSet.delete(id);
  }

  if (publicResources.length === 0 && tombstonesSet.size === 0) {
    throw new Error(
      "No public resources classified for sync. Use 'scope set <id> public' or '/config-scope set <id> public' before export/push."
    );
  }

  const payload = {
    v: 3,
    namespace,
    createdAt: new Date().toISOString(),
    resources: publicResources,
    tombstones: Array.from(tombstonesSet).sort(),
  };
  validateSnapshot(payload);

  const blob = encryptArchivePayload(payload, pass);
  return { blob, files: publicResources.length, payload };
}

/**
 * Decrypts an encrypted archive blob and returns the parsed JSON payload.
 */
export function decryptArchiveBlob(blob, pass) {
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

  let decrypted;
  try {
    decrypted = gunzipSync(Buffer.concat([decipher.update(ct), decipher.final()]));
  } catch (err) {
    throw new Error(`Archive decryption failed: ${err.message}`);
  }

  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Encrypts a JSON-serializable snapshot payload into an archive buffer.
 */
export function encryptArchivePayload(payload, pass) {
  if (!pass) throw new Error("empty passphrase");
  const plain = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

/**
 * Adapts a legacy v1 or v2 archive to v3 specification with same passphrase.
 */
export function adaptArchive(blob, pass) {
  const payload = decryptArchiveBlob(blob, pass);
  const inspection = inspectArchivePayload(payload);
  if (inspection.compatible) {
    throw new Error("archive already v3; no adaptation needed");
  }
  if (!inspection.adaptable) {
    throw new Error(inspection.reason);
  }
  const adapted = adaptLegacySnapshot(payload);
  const outBlob = encryptArchivePayload(adapted, pass);
  return {
    blob: outBlob,
    payload: adapted,
    legacy: adapted.legacy,
  };
}

/**
 * Restores an encrypted archive buffer into the config tree with 3-way merge planning and journaled transaction.
 */
export function restoreArchive(blob, pass, root = configRoot(), options = {}) {
  const payload = decryptArchiveBlob(blob, pass);
  const inspection = inspectArchivePayload(payload);
  let effectivePayload = payload;
  let legacyInfo = null;

  if (inspection.compatible) {
    // Already compatible v3
  } else if (inspection.adaptable) {
    effectivePayload = adaptLegacySnapshot(payload);
    legacyInfo = {
      from: effectivePayload.legacy.from,
      unmapped: effectivePayload.legacy.unmapped,
      adapted: true,
    };
  } else {
    throw new Error(inspection.reason);
  }

  const dryRun = Boolean(options.dryRun);
  const plan = planSync(effectivePayload, root);

  if (dryRun) {
    return {
      files: plan.writes.length,
      dryRun: true,
      actions: plan.actions,
      conflicts: plan.conflicts,
      blocked: plan.blocked,
      prerequisites: plan.prerequisites,
      writes: plan.writes,
      ...(legacyInfo ? { legacy: legacyInfo } : {}),
    };
  }

  // Apply plan atomically
  const result = applySyncPlan(plan, root);
  return {
    files: result.filesWritten,
    dryRun: false,
    actions: plan.actions,
    backupDir: result.backupDir,
    conflicts: plan.conflicts,
    blocked: plan.blocked,
    prerequisites: plan.prerequisites,
    ...(legacyInfo ? { legacy: legacyInfo } : {}),
  };
}

/**
 * Reverts the most recent config restore using transaction journal.
 */
export function rollback(root = configRoot()) {
  return rollbackSync(root);
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
  const abs = path.resolve(srcFile);
  const blob = fs.readFileSync(abs);
  const payload = decryptArchiveBlob(blob, pass);
  const inspection = inspectArchivePayload(payload);

  if (!inspection.compatible && inspection.adaptable) {
    const adaptedOut = `${abs}.v3.enc`;
    if (fs.existsSync(adaptedOut) && !options.force) {
      throw new Error(`adapted archive already exists: ${adaptedOut}`);
    }
    const adapted = adaptLegacySnapshot(payload);
    const adaptedBlob = encryptArchivePayload(adapted, pass);
    fs.writeFileSync(adaptedOut, adaptedBlob, { mode: 0o600 });
    const res = restoreArchive(adaptedBlob, pass, root, options);
    return {
      ...res,
      adaptedFile: adaptedOut,
      legacy: {
        from: inspection.version,
        unmapped: adapted.legacy.unmapped,
        adapted: true,
      },
    };
  }

  return restoreArchive(blob, pass, root, options);
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

const TRANSIENT_FETCH_CODE =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|UND_ERR|SOCKET_HANG_UP|OTHER_SIDE_CLOSED/i;

function isTransientFetchError(err) {
  const code = err?.cause?.code || err?.code;
  return typeof code === "string" && TRANSIENT_FETCH_CODE.test(code);
}

/**
 * fetch with bounded retry for transient network failures (flaky routes, mid-transfer RSTs).
 * Retries transport errors carrying a transient code and 429/5xx responses with backoff;
 * client errors (4xx) and caller timeouts fail immediately.
 */
async function fetchWithRetry(url, init = {}, attempts = 3) {
  let lastError;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(750 * 2 ** (attempt - 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (!isTransientFetchError(err) || attempt === attempts) throw err;
      await sleep(750 * 2 ** (attempt - 1));
    }
  }
  const code = lastError?.cause?.code || lastError?.code || "network failure";
  throw new Error(
    `${code} after ${attempts} attempts: ${lastError.message} — retry later, or set HTTPS_PROXY + NODE_USE_ENV_PROXY=1 to route via a local proxy`
  );
}

async function gh(token, pathname, init = {}) {
  const res = await fetchWithRetry(`https://api.github.com${pathname}`, {
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
function commitPushBaseline(root, payload) {
  const readContext = createReadContext(root);
  readContext.observe(path.join(root, STATE_FILE));
  const current = readSyncState(root);
  const resources = {};
  for (const key of Object.keys(current.resources || {})) {
    Object.defineProperty(resources, key, {
      value: { ...current.resources[key] },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const resource of payload.resources || []) {
    Object.defineProperty(resources, resource.id, {
      value: { hash: canonicalHash(resource.value), hashFormat: "portable-v1" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const tombstones = Array.from(new Set(payload.tombstones || [])).sort();
  for (const id of tombstones) {
    Object.defineProperty(resources, id, {
      value: { hash: SENTINEL_DELETED, hashFormat: "portable-v1" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const nextState = {
    version: 1,
    namespace: payload.namespace || current.namespace,
    resources,
    tombstones,
  };
  return withSyncLock(root, (lock) =>
    commitFileTransaction(
      root,
      {
        readContext,
        entries: new Map(),
        nextState,
        needsCommit: true,
        stateGuard: (() => {
          const stateAbs = path.join(root, STATE_FILE);
          const bytes = readContext.readFile(stateAbs);
          if (bytes === undefined) {
            return { existed: false, hash: SENTINEL_DELETED, mode: null };
          }
          return {
            existed: true,
            hash: createHash("sha256").update(bytes).digest("hex"),
            mode: readContext.fileMode(stateAbs),
          };
        })(),
      },
      lock
    )
  );
}

export async function pushGist(id, pass, root = configRoot(), token = envToken()) {
  if (!token) throw new Error("GitHub token required: set OMP_CFG_CLOUD_TOKEN or GITHUB_TOKEN");
  const { blob, files, payload } = buildArchive(pass, root);
  const content = blob.toString("base64");
  const body = { files: { [GIST_FILE]: { content } } };
  const data =
    id && id !== "new"
      ? await gh(token, `/gists/${id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await gh(token, `/gists`, {
          method: "POST",
          body: JSON.stringify({ description: "omp config (encrypted)", public: false, ...body }),
        });

  try {
    commitPushBaseline(root, payload);
  } catch (error) {
    throw new Error(`Upload succeeded; local baseline commit failed: ${error.message}`);
  }


  return { id: data.id, url: data.html_url, files, bytes: blob.length };
}

function restoreRemoteArchive(blob, pass, root = configRoot(), options = {}) {
  const payload = decryptArchiveBlob(blob, pass);
  const inspection = inspectArchivePayload(payload);

  if (inspection.compatible) {
    return restoreArchive(blob, pass, root, options);
  }

  if (!inspection.adaptable) {
    throw new Error(inspection.reason);
  }

  const adapted = adaptLegacySnapshot(payload);
  const adaptedBlob = encryptArchivePayload(adapted, pass);

  if (options.dryRun) {
    const res = restoreArchive(adaptedBlob, pass, root, options);
    return {
      ...res,
      legacy: {
        from: inspection.version,
        unmapped: adapted.legacy.unmapped,
        adapted: true,
      },
    };
  }

  const adaptedFile = path.join(os.tmpdir(), `omp-archive-v3-${Date.now()}.enc`);
  fs.writeFileSync(adaptedFile, adaptedBlob, { mode: 0o600 });
  const res = restoreArchive(adaptedBlob, pass, root, options);
  return {
    ...res,
    adaptedFile,
    legacy: {
      from: inspection.version,
      unmapped: adapted.legacy.unmapped,
      adapted: true,
    },
  };
}

/** Pull the archive from a secret gist. */
export async function pullGist(id, pass, root = configRoot(), token = envToken(), options = {}) {
  if (!token) throw new Error("GitHub token required: set OMP_CFG_CLOUD_TOKEN or GITHUB_TOKEN");
  const data = await gh(token, `/gists/${id}`);
  const content = data?.files?.[GIST_FILE]?.content;
  if (!content) throw new Error(`gist ${id} has no ${GIST_FILE}`);
  const blob = Buffer.from(content, "base64");
  return restoreRemoteArchive(blob, pass, root, options);
}

/** Push to any endpoint accepting PUT (presigned S3, WebDAV, custom). */
export async function pushHttp(url, pass, root = configRoot(), token = envToken()) {
  const { blob, files, payload } = buildArchive(pass, root);
  const headers = { "content-type": "application/octet-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchWithRetry(url, {
    method: "PUT",
    body: blob,
    signal: AbortSignal.timeout(30_000),
    headers,
  });
  if (!res.ok) throw new Error(`PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);

  try {
    commitPushBaseline(root, payload);
  } catch (error) {
    throw new Error(`Upload succeeded; local baseline commit failed: ${error.message}`);
  }


  return { url, files, bytes: blob.length };
}

/** Pull from any endpoint serving the archive. */
export async function pullHttp(url, pass, root = configRoot(), token = envToken(), options = {}) {
  const res = await fetchWithRetry(url, {
    signal: AbortSignal.timeout(30_000),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const blob = Buffer.from(await res.arrayBuffer());
  return restoreRemoteArchive(blob, pass, root, options);
}

export function parseSpec(spec) {
  const s = spec.trim();
  if (s.startsWith("gist:")) return { kind: "gist", id: s.slice(5) || "new" };
  if (/^https?:\/\//.test(s)) return { kind: "http", url: s };
  throw new Error("expected gist:<id|new> or an https URL");
}

export function extractDryRun(str) {
  const raw = String(str || "").trim();
  if (!raw) return { dryRun: false, clean: "" };
  const tokens = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(raw))) {
    tokens.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  let dryRun = false;
  const kept = [];
  for (const token of tokens) {
    if (token === "--dry-run" || token === "-d") {
      dryRun = true;
      continue;
    }
    kept.push(token);
  }
  return { dryRun, clean: kept.join(" ") };
}

export function formatSyncReport(result = {}) {
  const lines = [];
  for (const action of result.actions || []) {
    lines.push(`[${action.action}] ${action.id} (${action.reason}) -> ${action.targetPath || ""}`);
  }
  for (const write of result.writes || []) {
    lines.push(`[write:${write.operation}] ${write.path}`);
  }
  for (const conflict of result.conflicts || []) {
    lines.push(`! conflict ${conflict.id}: ${conflict.reason}${conflict.targetPath ? ` (${conflict.targetPath})` : ""}`);
  }
  for (const blocked of result.blocked || []) {
    lines.push(`X blocked ${blocked.id || ""}: ${blocked.reason}${blocked.targetPath ? ` (${blocked.targetPath})` : ""}`.replace("  ", " "));
  }
  for (const prerequisite of result.prerequisites || []) {
    lines.push(`* prerequisite ${prerequisite}`);
  }
  if (!lines.length) {
    lines.push("(no planned actions)");
  }
  return lines.join("\n");
}

/**
 * Prompts interactive host user with multi-select askDialog to confirm exclusion of
 * machine-binding resources. All non-private candidates default to public sync; only
 * checked (excluded) items stay out of the public bundle.
 */
export async function selectPublicResources(ctx, root = configRoot()) {
  // Returns "private" / "machine-binding" / null (generic, safe to sync by default).
  function syncExclusionReason(item) {
    if (item?.isPrivate === true) {
      return "private";
    }
    let text;
    try {
      text = item?.value === undefined ? undefined : JSON.stringify(item.value);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      text = String(item?.value ?? "");
    }
    const machineBindingPatterns = [
      /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/,                           // Windows drive path (not URL scheme)
      /\\\\[^\\/]/,                                              // UNC share path
      /(?:^|[\s"'=])\/(?:Users|home|opt|data|usr|var)\//,        // POSIX absolute path
      /~\/|(?<![A-Za-z0-9_])(?:%USERPROFILE%|\$HOME|\$\{HOME\})/, // home dir tokens
      /\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])\b/i,      // loopback address
      /!(?:bash|cat|type)\b/i,                                   // local shell/file reads
    ];
    return machineBindingPatterns.some((re) => re.test(text)) ? "machine-binding" : null;
  }

  const inventory = inventoryResources(root);
  if (!inventory || inventory.length === 0) {
    ctx?.ui?.notify?.("No configuration resources found.", "info");
    return null;
  }

  if (typeof ctx?.ui?.askDialog !== "function") {
    ctx?.ui?.notify?.("当前宿主不支持空格多选，请升级 OMP", "error");
    return null;
  }

  const policy = readSyncPolicy(root);
  const state = readSyncState(root);

  const sorted = [...inventory].sort((a, b) => a.id.localeCompare(b.id));
  const candidates = sorted.filter(
    (item) => resolveResourceScope(item.id, policy, state, item).scope !== "private"
  );

  const reasons = new Map();
  const options = [];
  for (const item of candidates) {
    if (syncExclusionReason(item) === "machine-binding") {
      reasons.set(item.id, "machine-binding");
      options.push({
        label: item.id,
        description: `可能不适合同步 · ${item.id} · ${item.sourceRel}`,
      });
    }
  }

  const checkedSet = new Set();

  if (options.length === 0) {
    ctx?.ui?.notify?.(`未发现不适合同步项，默认同步 ${candidates.length} 项`, "info");
  } else {
    const dialogResult = await ctx.ui.askDialog([
      {
        id: "sync-exclude",
        header: "SYNC",
        question: "默认全部同步；空格勾选不适合同步的项 · Enter 确认 · Esc 取消",
        multi: true,
        options,
      },
    ]);

    if (!dialogResult || dialogResult.kind !== "submit") {
      ctx?.ui?.notify?.("已取消，未修改公开范围", "info");
      return null;
    }

    const answer = dialogResult.results?.find((item) => item.id === "sync-exclude");
    const selectedOptions = dialogResult.selectedOptions ?? answer?.selectedOptions;

    if (!Array.isArray(selectedOptions)) {
      ctx?.ui?.notify?.("已取消，未修改公开范围", "info");
      return null;
    }

    for (const label of selectedOptions) {
      if (!reasons.has(label)) {
        ctx?.ui?.notify?.(`未知选项: ${label}`, "error");
        return null;
      }
      checkedSet.add(label);
    }
  }

  for (const item of candidates) {
    const id = item.id;
    const isExplicitPublic = policy.resources?.[id] === "public";
    if (checkedSet.has(id)) {
      if (isExplicitPublic) {
        try {
          await setResourceScope(root, id, "private");
        } catch (err) {
          ctx?.ui?.notify?.(`公开范围未完成: ${id}: ${err.message || err}`, "error");
          return null;
        }
      }
    } else if (!isExplicitPublic && !reasons.has(id)) {
      // Generic (non machine-binding) candidates are public by default; unchecked
      // machine-binding items keep their unclassified default (not synced).
      try {
        await setResourceScope(root, id, "public");
      } catch (err) {
        ctx?.ui?.notify?.(`公开范围未完成: ${id}: ${err.message || err}`, "error");
        return null;
      }
    }
  }

  const selected = candidates
    .filter((item) => !checkedSet.has(item.id))
    .filter((item) => !(reasons.has(item.id) && policy.resources?.[item.id] !== "public"))
    .map((item) => item.id)
    .sort();
  const excluded = [...checkedSet].sort();

  const updatedPolicy = readSyncPolicy(root);
  const updatedState = readSyncState(root);
  let publicCount = 0;
  for (const item of inventory) {
    const s = resolveResourceScope(item.id, updatedPolicy, updatedState, item);
    if (s.scope === "public") publicCount++;
  }

  return {
    selected,
    excluded,
    publicCount,
  };
}

/** Plugin entry: local and cloud config portability. */
export default function (pi) {
  pi.registerCommand("config-scope", {
    description: "Manage public/private synchronization scope (/config-scope list | set <id> public|private)",
    handler: async (args, ctx) => {
      const cleanArgs = (args || "").trim();
      const parts = cleanArgs.split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "list").toLowerCase();
      const root = configRoot();

      try {
        if (sub === "list" || sub === "ls") {
          const policy = readSyncPolicy(root);
          const state = readSyncState(root);
          const inventory = inventoryResources(root);
          if (inventory.length === 0) {
            ctx.ui.notify("No configuration resources found.", "info");
            return;
          }
          const lines = inventory.map((item) => {
            const scopeInfo = resolveResourceScope(item.id, policy, state, item);
            return `[${scopeInfo.scope.toUpperCase()}] ${item.id} (source: ${item.sourceRel}, reason: ${scopeInfo.reason})`;
          });
          ctx.ui.notify(`Config Scope Inventory:\n${lines.join("\n")}`, "info");
          return;
        }

        if (sub === "set") {
          const id = parts[1];
          const scope = parts[2]?.toLowerCase();
          if (!id || !scope || (scope !== "public" && scope !== "private")) {
            ctx.ui.notify("Usage: /config-scope set <id> <public|private>", "error");
            return;
          }
          const res = await setResourceScope(root, id, scope);
          let msg = `Scope for '${res.id}' set to '${res.scope}'.`;
          if (res.warning) {
            msg += `\n${res.warning}`;
          }
          ctx.ui.notify(msg, "info");
          return;
        }

        ctx.ui.notify(`Unknown subcommand: ${sub}. Use /config-scope list or /config-scope set <id> <public|private>`, "error");
      } catch (err) {
        ctx.ui.notify(`config-scope error: ${err.message || err}`, "error");
      }
    },
  });

  pi.registerCommand("config-export", {
    description: "Encrypt public omp config resources to an archive",
    handler: async (args, ctx) => {
      const out = (args || "").trim() || path.join(os.homedir(), `omp-config-${Date.now()}.enc`);
      try {
        const pass = await askPass(ctx, "Export passphrase");
        const r = exportEncrypted(out, pass);
        ctx.ui.notify(`exported ${r.files} public resources (${r.bytes} B) → ${r.outFile}`, "info");
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
        if (r.adaptedFile) {
          ctx.ui.notify(`[import] incompatible v${r.legacy?.from}; adapted -> ${r.adaptedFile}`, "info");
        }
        if (dryRun) {
          ctx.ui.notify(`[dry-run]\n${formatSyncReport(r)}`, "info");
        } else {
          ctx.ui.notify(`restored ${r.files} files${r.backupDir ? ` (backup: ${r.backupDir})` : ""}; restart omp`, "info");
        }
      } catch (error) {
        const report = error?.plan ? `\n${formatSyncReport(error.plan)}` : "";
        ctx.ui.notify(`config-import failed: ${error?.message ?? error}${report}`, "error");
      }
    },
  });

  pi.registerCommand("config-push", {
    description: "Encrypt and upload public configs to gist:<id|new> or an https URL",
    handler: async (args, ctx) => {
      const root = configRoot();
      if (typeof ctx?.ui?.askDialog === "function") {
        const sel = await selectPublicResources(ctx, root);
        if (sel === null) return;
      }
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
        ctx.ui.notify(`pushed ${r.files} public resources (${r.bytes} B) → ${where}`, "info");
      } catch (error) {
        ctx.ui.notify(`config-push failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("config-pull", {
    description: "Download and decrypt config from gist:<id> or an https URL (--dry-run to preview)",
    handler: async (args, ctx) => {
      const root = configRoot();
      if (typeof ctx?.ui?.askDialog === "function") {
        const sel = await selectPublicResources(ctx, root);
        if (sel === null) return;
      }
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
        if (r.adaptedFile) {
          ctx.ui.notify(`[pull] incompatible v${r.legacy?.from}; adapted -> ${r.adaptedFile}`, "info");
        }
        if (dryRun) {
          ctx.ui.notify(`[dry-run]\n${formatSyncReport(r)}`, "info");
        } else {
          ctx.ui.notify(`restored ${r.files} files${r.backupDir ? ` (backup: ${r.backupDir})` : ""}; restart omp`, "info");
        }
      } catch (error) {
        const report = error?.plan ? `\n${formatSyncReport(error.plan)}` : "";
        ctx.ui.notify(`config-pull failed: ${error?.message ?? error}${report}`, "error");
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
    description: "Provider control menu · ls | add | edit <name> | test <name> | rm <name>",
    getArgumentCompletions: prefix => providerCompletions(prefix, configRoot()),
    handler: (args, ctx) => handleProviderCommand(pi, ctx, args, configRoot()),
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
          return models.filter((m) => m.value.toLowerCase().startsWith(target))
            .map((m) => ({ ...m, label: m.value, value: prefix.slice(0, prefix.length - parts[1].length) + m.value }));
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
