import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";

const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function configRoot() {
  return process.env.OMP_CFG_ROOT || path.join(os.homedir(), ".omp", "agent");
}

export function ompHome(root = configRoot()) {
  return process.env.OMP_HOME || path.dirname(root);
}

export function resolveDestination(rel, root = configRoot()) {
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("plugins/") || norm.startsWith("tools/") || norm.startsWith("hooks/")) {
    return path.join(ompHome(root), norm);
  }
  return path.join(root, norm);
}

export function validatePortablePath(relPath) {
  if (typeof relPath !== "string" || !relPath) {
    throw new Error("Invalid asset path: path must be a non-empty string");
  }
  if (relPath.includes("\\")) {
    throw new Error("Invalid asset path: backslashes are prohibited");
  }
  if (relPath.includes("\0") || path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    throw new Error("Invalid asset path: absolute paths and NUL bytes are prohibited");
  }
  const parts = relPath.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error("Invalid asset path: empty and dot segments are prohibited");
    }
    if (/[<>:"|?*\x00-\x1f]/.test(part)) {
      throw new Error("Invalid asset path: control characters, ADS, and reserved characters are prohibited");
    }
    if (/[. ]$/.test(part) || WINDOWS_DEVICE.test(part)) {
      throw new Error("Invalid asset path: Windows device names and trailing dots/spaces are prohibited");
    }
  }
  return parts;
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateAssetFiles(resourceRoot, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid asset '${resourceRoot}': value must be a non-empty file array`);
  }
  const paths = new Set();
  const caseFolded = new Map();
  for (const file of value) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`Invalid asset '${resourceRoot}': every file entry must be an object`);
    }
    const keys = Object.keys(file).sort();
    if (keys.join(",") !== "data,mode,path") {
      throw new Error(`Invalid asset '${resourceRoot}': file entries require exactly path, data, and mode`);
    }
    validatePortablePath(file.path);
    if (file.path !== resourceRoot && !file.path.startsWith(resourceRoot + "/")) {
      throw new Error(`Invalid asset '${resourceRoot}': file path escapes the declared resource root`);
    }
    if (paths.has(file.path)) {
      throw new Error(`Invalid asset '${resourceRoot}': duplicate file path`);
    }
    const folded = file.path.toLowerCase();
    if (caseFolded.has(folded)) {
      throw new Error(`Invalid asset '${resourceRoot}': case-folding path collision`);
    }
    paths.add(file.path);
    caseFolded.set(folded, file.path);
    if (typeof file.data !== "string" || !STRICT_BASE64.test(file.data)) {
      throw new Error(`Invalid asset '${resourceRoot}': file data must be strict base64`);
    }
    if (file.data.length > Math.ceil(MAX_FILE_SIZE / 3) * 4 + 4) {
      throw new Error(`Invalid asset '${resourceRoot}': file exceeds 10 MiB limit`);
    }
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length > MAX_FILE_SIZE || bytes.toString("base64") !== file.data) {
      throw new Error(`Invalid asset '${resourceRoot}': invalid base64 or file exceeds 10 MiB limit`);
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new Error(`Invalid asset '${resourceRoot}': mode must be an integer from 0 to 0777`);
    }
  }
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join("/"))) {
        throw new Error(`Invalid asset '${resourceRoot}': file/directory prefix collision`);
      }
    }
  }
  if (/^(?:skills|managed-skills)\//.test(resourceRoot) && !paths.has(`${resourceRoot}/SKILL.md`)) {
    throw new Error(`Invalid skill '${resourceRoot}': root SKILL.md is required`);
  }
  return value;
}

function lstatIfPresent(abs) {
  try {
    return fs.lstatSync(abs);
  } catch (err) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

function isInside(abs, root) {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

export function assertSafeTarget(root, relPath) {
  const parts = validatePortablePath(relPath);
  const norm = parts.join("/");
  const rootKind = /^(?:plugins|tools|hooks)\//.test(norm) ? "omp" : "agent";
  const allowedRoot = path.resolve(rootKind === "omp" ? ompHome(root) : root);
  const abs = path.resolve(allowedRoot, ...parts);
  if (!isInside(abs, allowedRoot)) {
    throw new Error("Security violation: target escapes its allowed configuration root");
  }

  const filesystemRoot = path.parse(abs).root;
  let current = filesystemRoot;
  for (const part of abs.slice(filesystemRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Security violation: symlink or junction ancestor is prohibited for '${norm}'`);
    }
    if (current !== abs && !stat.isDirectory()) {
      throw new Error(`Security violation: non-directory ancestor blocks '${norm}'`);
    }
  }

  let nearest = path.dirname(abs);
  let nearestStat = lstatIfPresent(nearest);
  while (!nearestStat) {
    const parent = path.dirname(nearest);
    if (parent === nearest) break;
    nearest = parent;
    nearestStat = lstatIfPresent(nearest);
  }
  const rootStat = lstatIfPresent(allowedRoot);
  if (rootStat && nearestStat) {
    const realRoot = fs.realpathSync(allowedRoot);
    const realNearest = fs.realpathSync(nearest);
    if (!isInside(realNearest, realRoot)) {
      throw new Error(`Security violation: target parent resolves outside its allowed root for '${norm}'`);
    }
  }
  return { abs, rel: norm, root: rootKind };
}

export function pointerToTokens(pointer) {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error("Invalid JSON pointer: must start with '/'");
  }
  return pointer.slice(1).split("/").map((segment) => {
    if (/~(?:[^01]|$)/.test(segment)) {
      throw new Error("Invalid JSON pointer: only ~0 and ~1 escapes are allowed");
    }
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function errorLocation(error) {
  const pos = error?.linePos?.[0];
  if (pos && Number.isInteger(pos.line) && Number.isInteger(pos.col)) {
    return ` at line ${pos.line}, column ${pos.col}`;
  }
  const match = /line (\d+) column (\d+)/i.exec(String(error?.message || ""));
  return match ? ` at line ${match[1]}, column ${match[2]}` : "";
}

export function parseYamlStrict(str, filename = "YAML") {
  const doc = parseDocument(str, { uniqueKeys: true, customTags: [] });
  const customTag = (doc.warnings || []).find((warning) => warning.code === "TAG_RESOLVE_FAILED");
  if ((doc.errors && doc.errors.length > 0) || customTag) {
    const error = doc.errors?.[0] || customTag;
    const code = error?.code || "PARSE_ERROR";
    throw new Error(`Invalid YAML in ${filename}: ${code}${errorLocation(error)}`);
  }
  return doc;
}

export function parseJsonStrict(str, filename = "JSON") {
  try {
    return JSON.parse(str);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filename}: ${errorLocation(error)}`.trimEnd());
  }
}

function bufferHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function createReadContext(root) {
  const base = path.resolve(root);
  const observations = new Map();

  function relative(abs) {
    const rel = path.relative(base, abs);
    return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path.basename(abs);
  }

  function observe(abs) {
    const target = path.resolve(abs);
    if (observations.has(target)) return observations.get(target);
    const stat = lstatIfPresent(target);
    if (!stat) {
      const observation = { type: "missing", mode: null, hash: null, entries: null };
      observations.set(target, observation);
      return observation;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Security violation: read path '${relative(target)}' is a symlink or junction`);
    }
    if (stat.isFile()) {
      const bytes = fs.readFileSync(target);
      const observation = { type: "file", mode: stat.mode & 0o777, hash: bufferHash(bytes), bytes, entries: null };
      observations.set(target, observation);
      return observation;
    }
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const observation = { type: "dir", mode: stat.mode & 0o777, hash: null, bytes: null, entries };
      observations.set(target, observation);
      return observation;
    }
    throw new Error(`Unsupported file type at '${relative(target)}'`);
  }

  return {
    root: base,
    observe,
    readFile(abs) {
      const observation = observe(abs);
      if (observation.type === "missing") return undefined;
      if (observation.type !== "file") throw new Error(`Expected a file at '${relative(abs)}'`);
      return observation.bytes;
    },
    fileMode(abs) {
      const observation = observe(abs);
      return observation.type === "file" ? observation.mode : null;
    },
    listDirectory(abs) {
      const observation = observe(abs);
      if (observation.type === "missing") return undefined;
      if (observation.type !== "dir") throw new Error(`Expected a directory at '${relative(abs)}'`);
      return observation.entries.map((entry) => ({ ...entry }));
    },
    verify() {
      for (const [target, observed] of observations) {
        const stat = lstatIfPresent(target);
        const rel = relative(target);
        if (!stat) {
          if (observed.type !== "missing") {
            throw new Error(`Concurrent modification detected: '${rel}' was removed`);
          }
          continue;
        }
        if (observed.type === "missing") {
          throw new Error(`Concurrent modification detected: '${rel}' was created`);
        }
        if (stat.isSymbolicLink() || (observed.type === "file" && !stat.isFile()) ||
            (observed.type === "dir" && !stat.isDirectory())) {
          throw new Error(`Concurrent modification detected: '${rel}' changed type`);
        }
        if (observed.type === "file") {
          const current = fs.readFileSync(target);
          if ((stat.mode & 0o777) !== observed.mode || bufferHash(current) !== observed.hash) {
            throw new Error(`Concurrent modification detected: '${rel}' changed`);
          }
        } else if (observed.type === "dir") {
          const current = fs.readdirSync(target, { withFileTypes: true })
            .map((entry) => ({
              name: entry.name,
              type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          if (JSON.stringify(current) !== JSON.stringify(observed.entries)) {
            throw new Error(`Concurrent modification detected: directory '${rel}' changed`);
          }
        }
      }
    },
    paths() {
      return Array.from(observations.keys());
    },
  };
}

export function renderResourceChanges(root, changes, readContext) {
  const writes = new Map();
  const folded = new Map();

  function register(rel, abs, operation, content = null, mode = 0o600) {
    const safe = assertSafeTarget(root, rel);
    const foldedRel = safe.rel.toLowerCase();
    if (folded.has(foldedRel) && folded.get(foldedRel) !== safe.rel) {
      throw new Error(`Case-folding conflict detected for '${safe.rel}'`);
    }
    folded.set(foldedRel, safe.rel);
    const existing = readContext.readFile(abs);
    const existingMode = existing === undefined ? null : readContext.fileMode(abs);
    if (operation === "write") {
      if (existing !== undefined && existing.equals(content) && existingMode === mode) return;
    } else if (existing === undefined) {
      return;
    }
    writes.set(safe.rel, { rel: safe.rel, abs: safe.abs, operation, content, mode });
  }

  const byPrefix = (prefix) => changes.filter((change) => change.id.startsWith(prefix) &&
    (change.action === "add" || change.action === "update" || change.action === "delete"));

  function chooseYaml(primary, alternate) {
    if (readContext.readFile(path.join(root, primary)) !== undefined) return primary;
    if (readContext.readFile(path.join(root, alternate)) !== undefined) return alternate;
    return primary;
  }

  const providerChanges = byPrefix("provider:");
  if (providerChanges.length > 0) {
    const rel = chooseYaml("models.yml", "models.yaml");
    const abs = path.join(root, rel);
    const existing = readContext.readFile(abs);
    const doc = existing === undefined ? parseYamlStrict("providers: {}\n", rel) : parseYamlStrict(existing.toString("utf8"), rel);
    if (!doc.has("providers") || !doc.get("providers")) doc.set("providers", {});
    for (const change of providerChanges) {
      const name = change.id.slice("provider:".length);
      if (change.action === "delete") doc.deleteIn(["providers", name]);
      else doc.setIn(["providers", name], change.value);
    }
    register(rel, abs, "write", Buffer.from(doc.toString(), "utf8"), readContext.fileMode(abs) ?? 0o600);
  }

  const mcpChanges = byPrefix("mcp:");
  if (mcpChanges.length > 0) {
    const rel = "mcp.json";
    const abs = path.join(root, rel);
    const existing = readContext.readFile(abs);
    const data = existing === undefined ? { mcpServers: {} } : parseJsonStrict(existing.toString("utf8"), rel);
    if (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) data.mcpServers = {};
    for (const change of mcpChanges) {
      const name = change.id.slice("mcp:".length);
      if (change.action === "delete") delete data.mcpServers[name];
      else Object.defineProperty(data.mcpServers, name, { value: change.value, enumerable: true, configurable: true, writable: true });
    }
    register(rel, abs, "write", Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8"), readContext.fileMode(abs) ?? 0o600);
  }

  const settingChanges = byPrefix("setting:");
  if (settingChanges.length > 0) {
    const rel = chooseYaml("config.yml", "config.yaml");
    const abs = path.join(root, rel);
    const existing = readContext.readFile(abs);
    const doc = existing === undefined ? parseYamlStrict("", rel) : parseYamlStrict(existing.toString("utf8"), rel);
    for (const change of settingChanges) {
      const tokens = pointerToTokens(change.id.slice("setting:".length));
      if (change.action === "delete") doc.deleteIn(tokens);
      else doc.setIn(tokens, change.value);
    }
    register(rel, abs, "write", Buffer.from(doc.toString(), "utf8"), readContext.fileMode(abs) ?? 0o600);
  }

  const pluginChanges = byPrefix("plugin:");
  if (pluginChanges.length > 0) {
    const pluginsDir = path.join(ompHome(root), "plugins");
    const pkgRel = "plugins/package.json";
    const lockRel = "plugins/omp-plugins.lock.json";
    const pkgAbs = path.join(pluginsDir, "package.json");
    const lockAbs = path.join(pluginsDir, "omp-plugins.lock.json");
    const pkgExisting = readContext.readFile(pkgAbs);
    const pkg = pkgExisting === undefined
      ? { name: "omp-plugins", private: true, dependencies: {} }
      : parseJsonStrict(pkgExisting.toString("utf8"), "plugins/package.json");
    if (!pkg.dependencies || typeof pkg.dependencies !== "object" || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
    const lockExisting = readContext.readFile(lockAbs);
    const lock = lockExisting === undefined ? { plugins: {} } : parseJsonStrict(lockExisting.toString("utf8"), "omp-plugins.lock.json");
    if (!lock.plugins || typeof lock.plugins !== "object" || Array.isArray(lock.plugins)) lock.plugins = {};
    for (const change of pluginChanges) {
      const name = change.id.slice("plugin:".length);
      if (change.action === "delete") {
        delete pkg.dependencies[name];
        delete lock.plugins[name];
      } else {
        Object.defineProperty(pkg.dependencies, name, { value: change.value.version, enumerable: true, configurable: true, writable: true });
        Object.defineProperty(lock.plugins, name, {
          value: { ...(lock.plugins[name] || {}), version: change.value.version, enabled: change.value.enabled !== false },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    register(pkgRel, pkgAbs, "write", Buffer.from(JSON.stringify(pkg, null, 2) + "\n", "utf8"), readContext.fileMode(pkgAbs) ?? 0o600);
    register(lockRel, lockAbs, "write", Buffer.from(JSON.stringify(lock, null, 2) + "\n", "utf8"), readContext.fileMode(lockAbs) ?? 0o600);
  }

  for (const change of byPrefix("asset:")) {
    const archiveRel = change.id.slice("asset:".length);
    const destination = resolveDestination(archiveRel, root);
    if (change.action === "delete") {
      const observation = readContext.observe(destination);
      if (observation.type === "file") {
        register(archiveRel, destination, "delete");
      } else if (observation.type === "dir") {
        const walk = (abs, rel) => {
          for (const entry of readContext.listDirectory(abs)) {
            const childRel = `${rel}/${entry.name}`;
            const childAbs = path.join(abs, entry.name);
            if (entry.type === "dir") walk(childAbs, childRel);
            else if (entry.type === "file") register(childRel, childAbs, "delete");
            else throw new Error(`Asset '${archiveRel}' contains an unsupported link or file type`);
          }
        };
        walk(destination, archiveRel);
      }
    } else {
      const incoming = new Set();
      for (const file of change.value) {
        incoming.add(file.path);
        register(file.path, resolveDestination(file.path, root), "write", Buffer.from(file.data, "base64"), file.mode);
      }
      const observation = readContext.observe(destination);
      if (observation.type === "dir") {
        const walk = (abs, rel) => {
          for (const entry of readContext.listDirectory(abs)) {
            const childRel = `${rel}/${entry.name}`;
            const childAbs = path.join(abs, entry.name);
            if (entry.type === "dir") walk(childAbs, childRel);
            else if (entry.type === "file") {
              if (!incoming.has(childRel)) register(childRel, childAbs, "delete");
            } else {
              throw new Error(`Asset '${archiveRel}' contains an unsupported link or file type`);
            }
          }
        };
        walk(destination, archiveRel);
      }
    }
  }

  return new Map(Array.from(writes.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export const LOCK_FILE = ".sync.local.lock";
export const RECOVERY_LOCK_FILE = ".sync-recovery.local.lock";

function writeLockContent(lockPath, content) {
  fs.writeFileSync(lockPath, `${JSON.stringify(content)}\n`, "utf8");
}

export function readLockFile(root) {
  const lockPath = path.join(root, LOCK_FILE);
  if (!fs.existsSync(lockPath)) return null;
  const raw = fs.readFileSync(lockPath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid root");
    }
    if (parsed.version !== 1 || typeof parsed.transactionId !== "string" || !parsed.transactionId) {
      throw new Error("invalid version/transactionId");
    }
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      throw new Error("invalid pid");
    }
    if (typeof parsed.createdAt !== "string" || !parsed.createdAt) {
      throw new Error("invalid createdAt");
    }
    if (!(parsed.backupDir === null || typeof parsed.backupDir === "string")) {
      throw new Error("invalid backupDir");
    }
    return { path: lockPath, content: parsed, raw };
  } catch (error) {
    const err = new Error(`Sync lock at ${lockPath} is corrupt or unknown; manual recovery required`);
    err.cause = error;
    throw err;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    return false;
  }
}

export function withSyncLock(root, operation, options = {}) {
  const agentDir = path.resolve(root);
  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
  const lockPath = path.join(agentDir, LOCK_FILE);
  const recoveryPath = path.join(agentDir, RECOVERY_LOCK_FILE);
  if (fs.existsSync(recoveryPath) && !options.allowDuringRecovery) {
    throw new Error(`Sync recovery lock active at ${recoveryPath}; manual recovery required`);
  }

  const transactionId = options.transactionId || randomUUID();
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw new Error(
        `Sync lock could not be created at ${lockPath}: permission denied (${error.code}). Check directory ACL/permissions; manual recovery may be required.`
      );
    }
    throw new Error(
      `Sync lock active at ${lockPath}. Another sync may be running, or a previous sync failed. Run rollback or remove lock if stale.`
    );
  }

  const content = {
    version: 1,
    transactionId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    backupDir: null,
  };
  try {
    fs.writeSync(fd, `${JSON.stringify(content)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (fs.existsSync(recoveryPath) && !options.allowDuringRecovery) {
    try { fs.unlinkSync(lockPath); } catch {}
    throw new Error(`Sync recovery lock active at ${recoveryPath}; manual recovery required`);
  }

  const handle = {
    transactionId,
    path: lockPath,
    _preserve: false,
    preserveForRecovery() {
      this._preserve = true;
    },
    setBackupDir(rel) {
      if (typeof rel !== "string" || !rel || rel.includes("/") || rel.includes("\\") || rel.includes("..")) {
        throw new Error("Invalid lock backupDir");
      }
      content.backupDir = rel;
      writeLockContent(lockPath, content);
    },
  };

  const release = () => {
    if (handle._preserve) return;
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current.transactionId === transactionId) fs.unlinkSync(lockPath);
    } catch {}
  };

  try {
    const result = operation(handle);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          release();
          return value;
        },
        (error) => {
          release();
          throw error;
        }
      );
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

export function atomicWriteFile(absPath, content, mode = 0o600) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const tmp = path.join(dir, `.${base}.tmp-${randomUUID()}`);
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  fs.writeFileSync(tmp, data, { mode });
  try {
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
  try {
    fs.renameSync(tmp, absPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  try { fs.chmodSync(absPath, mode); } catch {}
  return tmp;
}

