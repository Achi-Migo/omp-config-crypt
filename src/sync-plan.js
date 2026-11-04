import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  assertSafeTarget,
  configRoot,
  createReadContext,
  ompHome,
  parseJsonStrict,
  parseYamlStrict,
  renderResourceChanges,
  resolveDestination,
  STRICT_BASE64,
  validateAssetFiles,
} from "./sync-files.js";
import {
  checkSettingOverlap,
  isExactSemver,
  readSyncPolicy,
  resolveResourceScope,
  resolveSyncNamespace,
  validateResourceId,
} from "./sync-policy.js";
import {
  canonicalResourceValue,
  inventoryResources,
  readResource,
  restoreResourceForImport,
  tokensToPointer,
} from "./sync-resources.js";

export const STATE_FILE = "sync-state.local.json";
export const SENTINEL_DELETED = "__OMP_SENTINEL_DELETED__";
const planTransactions = new WeakMap();

export function getSyncPlanTransaction(plan, root = configRoot()) {
  const transaction = planTransactions.get(plan);
  if (!transaction || transaction.root !== path.resolve(root) || transaction.consumed) {
    throw new Error("Invalid or already-consumed sync plan; rebuild the plan for this root");
  }
  try {
    transaction.readContext?.verify?.();
  } catch (error) {
    if (/Concurrent modification detected/i.test(String(error?.message || error))) {
      throw error;
    }
    throw new Error("Invalid or already-consumed sync plan; rebuild the plan for this root");
  }
  transaction.consumed = true;
  return transaction;
}

/**
 * Computes canonical SHA-256 hash of a JSON/object or asset array.
 * Keys are recursively sorted, arrays preserved in order.
 */
export function canonicalHash(val) {
  if (val === undefined) {
    return SENTINEL_DELETED;
  }

  function canonicalize(v) {
    if (v === null || typeof v !== "object") {
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(canonicalize);
    }
    const sorted = Object.create(null);
    for (const key of Object.keys(v).sort()) {
      Object.defineProperty(sorted, key, {
        value: canonicalize(v[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return sorted;
  }

  const jsonStr = JSON.stringify(canonicalize(val));
  return createHash("sha256").update(jsonStr, "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cloneOwn(value) {
  if (Array.isArray(value)) return value.map(cloneOwn);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: cloneOwn(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

export function validateSyncState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${STATE_FILE}: root must be an object`);
  }
  if (parsed.version !== 1) {
    throw new Error(`Invalid ${STATE_FILE}: unsupported version ${parsed.version}; expected 1`);
  }
  if (parsed.namespace !== undefined && (typeof parsed.namespace !== "string" || !parsed.namespace.trim())) {
    throw new Error(`Invalid ${STATE_FILE}: namespace must be a non-empty string`);
  }
  if (!parsed.resources || typeof parsed.resources !== "object" || Array.isArray(parsed.resources)) {
    throw new Error(`Invalid ${STATE_FILE}: resources must be an object`);
  }
  if (!Array.isArray(parsed.tombstones)) {
    throw new Error(`Invalid ${STATE_FILE}: tombstones must be an array`);
  }

  const resources = {};
  for (const id of Object.keys(parsed.resources)) {
    validateResourceId(id);
    const record = parsed.resources[id];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Invalid ${STATE_FILE}: record for '${id}' must be an object`);
    }
    if (typeof record.hash !== "string" ||
        (record.hash !== SENTINEL_DELETED && !/^[a-f0-9]{64}$/i.test(record.hash))) {
      throw new Error(`Invalid ${STATE_FILE}: record for '${id}' has an invalid hash`);
    }
    if (record.hashFormat !== undefined && record.hashFormat !== "portable-v1") {
      throw new Error(`Invalid ${STATE_FILE}: record for '${id}' has an unsupported hash format`);
    }
    Object.defineProperty(resources, id, {
      value: cloneOwn(record),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  const tombstones = [];
  const seen = new Set();
  for (const id of parsed.tombstones) {
    validateResourceId(id);
    if (seen.has(id)) throw new Error(`Invalid ${STATE_FILE}: duplicate tombstone '${id}'`);
    seen.add(id);
    if (resources[id] && resources[id].hash !== SENTINEL_DELETED) {
      throw new Error(`Invalid ${STATE_FILE}: '${id}' is both active and tombstoned`);
    }
    tombstones.push(id);
  }

  return {
    ...cloneOwn(parsed),
    version: 1,
    namespace: parsed.namespace?.trim(),
    resources,
    tombstones,
  };
}

export function readSyncState(root = configRoot()) {
  const filePath = path.join(root, STATE_FILE);
  if (!fs.existsSync(filePath)) {
    return { version: 1, resources: {}, tombstones: [] };
  }
  const parsed = parseJsonStrict(fs.readFileSync(filePath, "utf8"), STATE_FILE);
  return validateSyncState(parsed);
}

/**
 * Writes sync-state.local.json atomically.
 */
export function writeSyncState(root = configRoot(), state) {
  const validState = validateSyncState(state);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, STATE_FILE);
  const tmp = path.join(root, `.${STATE_FILE}.tmp-${randomUUID()}`);
  const data = JSON.stringify(validState, null, 2) + "\n";
  try {
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Validates remote snapshot structure before planning.
 */
export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Invalid archive snapshot: payload is not an object");
  }
  if (snapshot.v === 1 || snapshot.v === 2) {
    throw new Error("legacy archive: re-export as v3");
  }
  if (snapshot.v !== 3) {
    throw new Error(`unsupported archive payload: version ${snapshot.v}; expected v3`);
  }
  if (typeof snapshot.namespace !== "string" || !snapshot.namespace.trim()) {
    throw new Error("Invalid archive snapshot: namespace must be a non-empty string");
  }
  if (typeof snapshot.createdAt !== "string" || !Number.isFinite(Date.parse(snapshot.createdAt))) {
    throw new Error("Invalid archive snapshot: createdAt must be a parseable timestamp");
  }
  if (!Array.isArray(snapshot.resources) || !Array.isArray(snapshot.tombstones)) {
    throw new Error("Invalid archive snapshot: resources and tombstones must be arrays");
  }

  const seenIds = new Set();
  const settingIds = [];
  const assetRoots = [];
  for (const resource of snapshot.resources) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource) ||
        typeof resource.id !== "string" || !Object.hasOwn(resource, "value")) {
      throw new Error("Invalid archive snapshot: every resource requires an id and own value");
    }
    const { prefix, name } = validateResourceId(resource.id);
    if (seenIds.has(resource.id)) {
      throw new Error(`Duplicate resource ID in snapshot: '${resource.id}'`);
    }
    seenIds.add(resource.id);
    const value = resource.value;
    if (prefix === "provider" || prefix === "mcp") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid '${resource.id}': value must be a JSON object`);
      }
    } else if (prefix === "setting") {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        throw new Error(`Invalid '${resource.id}': settings must be null, scalar, or an array`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`Invalid '${resource.id}': setting number must be finite`);
      }
      settingIds.push(resource.id);
    } else if (prefix === "plugin") {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "enabled,name,version") {
        throw new Error(`Invalid '${resource.id}': plugin requires exactly name, version, and enabled`);
      }
      if (value.name !== name || !isExactSemver(value.version) || typeof value.enabled !== "boolean") {
        throw new Error(`Invalid '${resource.id}': plugin name, exact SemVer, or enabled flag is invalid`);
      }
    } else if (prefix === "asset") {
      validateAssetFiles(name, value);
      assetRoots.push(name);
    }
  }
  checkSettingOverlap(settingIds);

  const seenTombstones = new Set();
  for (const tombstone of snapshot.tombstones) {
    validateResourceId(tombstone);
    if (seenTombstones.has(tombstone)) {
      throw new Error(`Duplicate tombstone in snapshot: '${tombstone}'`);
    }
    if (seenIds.has(tombstone)) {
      throw new Error(`Resource ID '${tombstone}' appears in both resources and tombstones`);
    }
    seenTombstones.add(tombstone);
  }
  for (let i = 0; i < assetRoots.length; i++) {
    for (let j = i + 1; j < assetRoots.length; j++) {
      if (assetRoots[i].startsWith(assetRoots[j] + "/") || assetRoots[j].startsWith(assetRoots[i] + "/")) {
        throw new Error("Invalid archive snapshot: asset resource roots overlap");
      }
    }
  }
  return {
    namespace: snapshot.namespace.trim(),
    resources: snapshot.resources,
    tombstones: snapshot.tombstones,
  };
}

/**
 * Inspects archive payload for version compatibility and adaptability.
 */
export function inspectArchivePayload(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      compatible: false,
      version: null,
      adaptable: false,
      reason: "Invalid archive snapshot: payload is not an object",
    };
  }
  if (snapshot.v === 3) {
    try {
      validateSnapshot(snapshot);
      return { compatible: true, version: 3 };
    } catch (err) {
      return {
        compatible: false,
        version: 3,
        adaptable: false,
        reason: err.message,
      };
    }
  }
  if (snapshot.v === 1 && Array.isArray(snapshot.files)) {
    return { compatible: false, version: 1, adaptable: true };
  }
  if (
    snapshot.v === 2 &&
    (Array.isArray(snapshot.resources) || Array.isArray(snapshot.files))
  ) {
    return { compatible: false, version: 2, adaptable: true };
  }
  return {
    compatible: false,
    version: typeof snapshot.v === "number" ? snapshot.v : null,
    adaptable: false,
    reason: `unsupported archive payload: version ${snapshot.v}; expected v3`,
  };
}

/**
 * Adapts a legacy v1 or v2 snapshot into a valid v3 snapshot.
 */
export function adaptLegacySnapshot(snapshot) {
  const inspection = inspectArchivePayload(snapshot);
  if (!inspection.adaptable) {
    throw new Error(inspection.reason || "unsupported archive payload");
  }

  if (snapshot.v === 2 && Array.isArray(snapshot.resources)) {
    if (snapshot.resources.length === 0) {
      throw new Error("legacy archive could not be adapted: empty snapshot");
    }
    const namespace =
      typeof snapshot.namespace === "string" && snapshot.namespace.trim()
        ? snapshot.namespace.trim()
        : "00000000-0000-4000-8000-0000000000v2";
    const createdAt =
      typeof snapshot.createdAt === "string" &&
      Number.isFinite(Date.parse(snapshot.createdAt))
        ? snapshot.createdAt
        : new Date().toISOString();
    const tombstones = Array.isArray(snapshot.tombstones)
      ? snapshot.tombstones
      : [];

    const adapted = {
      v: 3,
      namespace,
      createdAt,
      resources: snapshot.resources,
      tombstones,
      legacy: { from: 2, unmapped: [] },
    };

    try {
      validateSnapshot(adapted);
    } catch (err) {
      const match = err.message.match(/['"]([^'"]+)['"]/);
      const reason = match ? match[1] : err.message;
      throw new Error(`legacy archive could not be adapted: ${reason}`);
    }

    return adapted;
  }

  // snapshot with files (v1 or v2 files)
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    throw new Error("legacy archive could not be adapted: empty snapshot");
  }

  const defaultNs = snapshot.v === 2
    ? "00000000-0000-4000-8000-0000000000v2"
    : "00000000-0000-4000-8000-0000000000v1";
  const namespace =
    typeof snapshot.namespace === "string" && snapshot.namespace.trim()
      ? snapshot.namespace.trim()
      : defaultNs;
  const fromVersion = snapshot.v === 2 ? 2 : 1;

  const createdAt =
    typeof snapshot.createdAt === "string" &&
    Number.isFinite(Date.parse(snapshot.createdAt))
      ? snapshot.createdAt
      : new Date().toISOString();

  const ymlProviders = new Map();
  const localProviders = new Map();
  const mcpServers = new Map();
  const settings = new Map();
  const assetFiles = new Map();
  const unmapped = [];
  let pkgFile = null;
  let lockFile = null;

  for (const file of snapshot.files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      !file.path.trim()
    ) {
      throw new Error(`legacy archive could not be adapted: ${file?.path || "invalid"}`);
    }
    if (typeof file.data !== "string" || !STRICT_BASE64.test(file.data)) {
      throw new Error(`legacy archive could not be adapted: ${file.path}`);
    }
    const buf = Buffer.from(file.data, "base64");
    if (buf.toString("base64") !== file.data) {
      throw new Error(`legacy archive could not be adapted: ${file.path}`);
    }

    const norm = file.path.replace(/\\/g, "/");
    if (
      norm.startsWith("/") ||
      path.posix.isAbsolute(norm) ||
      path.win32.isAbsolute(norm) ||
      /^[a-zA-Z]:/.test(norm)
    ) {
      throw new Error(`legacy archive could not be adapted: ${file.path}`);
    }
    const parts = norm.split("/");
    if (parts.some((p) => !p || p === "." || p === "..")) {
      throw new Error(`legacy archive could not be adapted: ${file.path}`);
    }

    // Skip without error
    if (norm.endsWith(".db") || norm.endsWith(".db-wal") || norm.endsWith(".db-shm")) {
      continue;
    }
    if (/(?:^|\/)cache\//.test(norm) || /(?:^|\/)session\//.test(norm)) {
      continue;
    }

    // models.local.json
    if (norm === "models.local.json" || norm === "agent/models.local.json") {
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        if (parsed?.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)) {
          for (const [pName, pVal] of Object.entries(parsed.providers)) {
            localProviders.set(pName, { value: pVal, file: file.path });
          }
        }
      } catch {
        // skip without error
      }
      continue;
    }

    // models.yml / models.yaml
    if (
      norm === "models.yml" ||
      norm === "models.yaml" ||
      norm === "agent/models.yml" ||
      norm === "agent/models.yaml"
    ) {
      let doc;
      try {
        doc = parseYamlStrict(buf.toString("utf8"), norm);
      } catch {
        throw new Error(`legacy archive could not be adapted: ${file.path}`);
      }
      const provs = doc.get("providers");
      let yamlMap = {};
      if (provs && typeof provs.toJSON === "function") {
        yamlMap = provs.toJSON() || {};
      } else if (provs && typeof provs === "object") {
        yamlMap = provs;
      } else {
        const top = typeof doc.toJSON === "function" ? doc.toJSON() : null;
        if (top && typeof top === "object" && !Array.isArray(top)) {
          yamlMap = top;
        }
      }
      for (const [pName, pVal] of Object.entries(yamlMap)) {
        if (!ymlProviders.has(pName)) {
          ymlProviders.set(pName, { value: pVal, file: file.path });
        }
      }
      continue;
    }

    // mcp.json
    if (norm === "mcp.json" || norm === "agent/mcp.json") {
      let data;
      try {
        data = JSON.parse(buf.toString("utf8"));
      } catch {
        throw new Error(`legacy archive could not be adapted: ${file.path}`);
      }
      if (data?.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)) {
        for (const [sName, sCfg] of Object.entries(data.mcpServers)) {
          mcpServers.set(sName, { value: sCfg, file: file.path });
        }
      }
      continue;
    }

    // config.yml / config.yaml
    if (
      norm === "config.yml" ||
      norm === "config.yaml" ||
      norm === "agent/config.yml" ||
      norm === "agent/config.yaml"
    ) {
      let doc;
      try {
        doc = parseYamlStrict(buf.toString("utf8"), norm);
      } catch {
        throw new Error(`legacy archive could not be adapted: ${file.path}`);
      }
      const json = typeof doc.toJSON === "function" ? doc.toJSON() : {};
      function collectLeaves(obj, tokens = []) {
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
          const ptr = tokensToPointer(tokens);
          settings.set(ptr, { value: obj, file: file.path });
          return;
        }
        for (const [k, v] of Object.entries(obj)) {
          collectLeaves(v, [...tokens, k]);
        }
      }
      collectLeaves(json);
      continue;
    }

    // plugins/package.json
    if (norm === "plugins/package.json") {
      pkgFile = file;
      continue;
    }
    if (norm === "plugins/omp-plugins.lock.json" || norm === "plugins/lock.json") {
      lockFile = file;
      continue;
    }

    // Top level instruction files
    const topDocMatch = norm.match(/^(?:agent\/)?(AGENTS\.md|STYLE\.md|RULES\.md)$/);
    if (topDocMatch) {
      const docName = topDocMatch[1];
      assetFiles.set(docName, [{ path: docName, data: file.data, mode: 0o644 }]);
      continue;
    }

    // Asset directories: agent/skills, agent/managed-skills, agent/extensions, tools, hooks
    const stripped = norm.startsWith("agent/") ? norm.slice(6) : norm;
    const assetDirMatch = stripped.match(
      /^(skills|managed-skills|extensions|tools|hooks)\/([^/]+)(?:\/(.*))?$/
    );
    if (assetDirMatch) {
      const category = assetDirMatch[1];
      const entryName = assetDirMatch[2];
      const rootName = `${category}/${entryName}`;
      if (!assetFiles.has(rootName)) {
        assetFiles.set(rootName, []);
      }
      assetFiles.get(rootName).push({
        path: stripped,
        data: file.data,
        mode: 0o644,
      });
      continue;
    }

    // Unmapped
    unmapped.push(file.path);
  }

  const resources = [];

  // 1. Providers: yml wins over local
  const allProviders = new Set([...ymlProviders.keys(), ...localProviders.keys()]);
  for (const pName of Array.from(allProviders).sort()) {
    const entry = ymlProviders.has(pName) ? ymlProviders.get(pName) : localProviders.get(pName);
    if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value)) {
      throw new Error(`legacy archive could not be adapted: provider:${pName}`);
    }
    resources.push({
      id: `provider:${pName}`,
      value: entry.value,
    });
  }

  // 2. MCP
  for (const [sName, entry] of mcpServers.entries()) {
    if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value)) {
      throw new Error(`legacy archive could not be adapted: mcp:${sName}`);
    }
    resources.push({
      id: `mcp:${sName}`,
      value: entry.value,
    });
  }

  // 3. Settings
  for (const [ptr, entry] of settings.entries()) {
    resources.push({
      id: `setting:${ptr}`,
      value: entry.value,
    });
  }

  // 4. Plugins
  if (pkgFile) {
    let pkgJson;
    try {
      pkgJson = JSON.parse(Buffer.from(pkgFile.data, "base64").toString("utf8"));
    } catch {
      throw new Error(`legacy archive could not be adapted: ${pkgFile.path}`);
    }
    let lockJson = {};
    if (lockFile) {
      try {
        lockJson = JSON.parse(Buffer.from(lockFile.data, "base64").toString("utf8"));
      } catch {}
    }
    const deps =
      pkgJson?.dependencies && typeof pkgJson.dependencies === "object"
        ? pkgJson.dependencies
        : {};
    for (const [pkgName, versionSpec] of Object.entries(deps)) {
      const lockEntry = lockJson?.plugins?.[pkgName];
      let resolvedVersion = null;
      if (isExactSemver(lockEntry?.version)) {
        resolvedVersion = lockEntry.version;
      } else if (isExactSemver(versionSpec)) {
        resolvedVersion = versionSpec;
      }
      if (resolvedVersion) {
        resources.push({
          id: `plugin:${pkgName}`,
          value: {
            name: pkgName,
            version: resolvedVersion,
            enabled: lockEntry?.enabled !== false,
          },
        });
      } else {
        unmapped.push(pkgName);
      }
    }
  }

  // 5. Assets
  for (const [rootName, files] of assetFiles.entries()) {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    resources.push({
      id: `asset:${rootName}`,
      value: files,
    });
  }

  resources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unmapped.sort();

  const adapted = {
    v: 3,
    namespace,
    createdAt,
    resources,
    tombstones: [],
    legacy: {
      from: fromVersion,
      unmapped,
    },
  };

  try {
    validateSnapshot(adapted);
  } catch (err) {
    const match = err.message.match(/['"]([^'"]+)['"]/);
    const reason = match ? match[1] : err.message;
    throw new Error(`legacy archive could not be adapted: ${reason}`);
  }

  return adapted;
}

/**
 * Plans the 3-way synchronization between local environment, local baseline, and remote snapshot.
 * Returns { namespace, actions, conflicts, blocked, prerequisites, writes }
 */
export function planSync(snapshot, root = configRoot()) {
  const validSnapshot = validateSnapshot(snapshot);
  const policy = readSyncPolicy(root);
  const state = readSyncState(root);
  const readContext = createReadContext(root);
  const inventory = inventoryResources(root);
  // Observe configuration surfaces that can invalidate a rendered plan.
  readContext.observe(path.join(root, STATE_FILE));
  readContext.observe(path.join(root, "sync-policy.local.json"));
  readContext.observe(path.join(root, "models.yml"));
  readContext.observe(path.join(root, "models.yaml"));
  readContext.observe(path.join(root, "models.local.json"));
  readContext.observe(path.join(root, "mcp.json"));
  readContext.observe(path.join(root, "config.yml"));
  readContext.observe(path.join(root, "config.yaml"));
  const pluginsRoot = path.join(ompHome(root), "plugins");
  readContext.observe(path.join(pluginsRoot, "package.json"));
  readContext.observe(path.join(pluginsRoot, "package-lock.json"));
  for (const item of inventory) {
    if (item.id.startsWith("plugin:")) {
      const name = item.id.slice("plugin:".length);
      readContext.observe(path.join(pluginsRoot, "node_modules", ...name.split("/"), "package.json"));
      continue;
    }
    if (!item.id.startsWith("asset:")) continue;
    const scope = resolveResourceScope(item.id, policy, state, item);
    if (scope.scope === "private") continue;
    const archiveRel = item.id.slice("asset:".length);
    const destination = resolveDestination(archiveRel, root);
    const observation = readContext.observe(destination);
    if (observation.type !== "dir") continue;
    const walk = (abs) => {
      for (const entry of readContext.listDirectory(abs)) {
        const childAbs = path.join(abs, entry.name);
        if (entry.type === "dir") walk(childAbs);
        else if (entry.type === "file") readContext.observe(childAbs);
        else throw new Error(`Security violation: read path '${path.relative(root, childAbs).replace(/\\/g, "/")}' is a symlink or junction`);
      }
    };
    walk(destination);
  }



  const conflicts = [];
  const blocked = [];
  const prerequisites = [];
  const actions = [];

  let localNamespace;
  try {
    localNamespace = resolveSyncNamespace(policy, state);
  } catch (error) {
    blocked.push({ id: "namespace", reason: error.message });
    return { namespace: validSnapshot.namespace, actions: [], conflicts: [], blocked, prerequisites: [], writes: {} };
  }
  if (localNamespace && localNamespace !== validSnapshot.namespace) {
    blocked.push({
      id: "namespace",
      reason: `Namespace mismatch: remote is '${validSnapshot.namespace}', local is '${localNamespace}'. Cannot take over different configuration set.`,
    });
    return { namespace: validSnapshot.namespace, actions: [], conflicts: [], blocked, prerequisites: [], writes: {} };
  }

  // Build remote map
  const remoteMap = new Map();
  for (const r of validSnapshot.resources) {
    remoteMap.set(r.id, { kind: "resource", value: r.value });
  }
  for (const t of validSnapshot.tombstones) {
    remoteMap.set(t, { kind: "tombstone" });
  }

  // Build local inventory map
  const inventoryMap = new Map();
  for (const item of inventory) {
    inventoryMap.set(item.id, item);
  }

  // Collect all unique IDs: local inventory + baseline state + remote resources/tombstones
  const allIds = new Set([
    ...Array.from(inventoryMap.keys()),
    ...Object.keys(state.resources || {}),
    ...Array.from(remoteMap.keys()),
  ]);

  const agentDir = root;
  const ompDir = ompHome(root);
  const pluginsDir = path.join(ompDir, "plugins");
  const acceptedTransitions = new Map();

  for (const id of Array.from(allIds).sort()) {
    const invItem = inventoryMap.get(id);
    const scopeInfo = resolveResourceScope(id, policy, state, invItem);
    const remoteEntry = remoteMap.get(id);

    let targetPath = id;
    if (id.startsWith("provider:")) {
      targetPath = fs.existsSync(path.join(agentDir, "models.yml")) ? "models.yml" : "models.yaml";
    } else if (id.startsWith("mcp:")) {
      targetPath = "mcp.json";
    } else if (id.startsWith("setting:")) {
      targetPath = fs.existsSync(path.join(agentDir, "config.yml")) ? "config.yml" : "config.yaml";
    } else if (id.startsWith("plugin:")) {
      targetPath = "plugins/package.json";
    } else if (id.startsWith("asset:")) {
      targetPath = id.slice("asset:".length);
    }

    if (scopeInfo.scope === "private") {
      actions.push({ id, action: "keep", reason: "local-private-protected", targetPath, remapped: false });
      continue;
    }

    let localPresent = false;
    let rawLocalVal = null;
    let localVal = null;
    if (invItem) {
      const readRes = readResource(root, id);
      if (readRes) {
        rawLocalVal = readRes.value;
        localVal = canonicalResourceValue(id, rawLocalVal, root);
        localPresent = true;
      }
    }
    const localHash = localPresent ? canonicalHash(localVal) : SENTINEL_DELETED;

    const isRemoteTombstone = remoteEntry?.kind === "tombstone";
    const isRemoteResource = remoteEntry?.kind === "resource";
    const remoteVal = isRemoteResource ? canonicalResourceValue(id, remoteEntry.value, root) : null;
    const remoteHash = isRemoteResource ? canonicalHash(remoteVal) : (isRemoteTombstone ? SENTINEL_DELETED : null);

    const baselineRecord = Object.hasOwn(state.resources || {}, id) ? state.resources[id] : null;
    let baselineHash = baselineRecord?.hash !== undefined ? baselineRecord.hash : null;
    let legacyBaselineUnverifiable = false;
    if (baselineRecord && baselineRecord.hashFormat !== "portable-v1") {
      const rawLocalHash = localPresent ? canonicalHash(rawLocalVal) : SENTINEL_DELETED;
      if (baselineRecord.hash === rawLocalHash || baselineRecord.hash === localHash) {
        baselineHash = localHash;
      } else if (isRemoteResource && baselineRecord.hash === remoteHash) {
        baselineHash = remoteHash;
      } else if (baselineRecord.hash === SENTINEL_DELETED) {
        baselineHash = SENTINEL_DELETED;
      } else if (isRemoteTombstone || isRemoteResource) {
        legacyBaselineUnverifiable = true;
      }
    }

    let plannedAction = null;
    let reason = null;
    let effectiveValue = null;
    let remapped = false;

    if (baselineHash === null) {
      if (isRemoteTombstone) {
        plannedAction = "keep";
        reason = "no-baseline-tombstone-ignored";
      } else if (!localPresent) {
        if (isRemoteResource) {
          plannedAction = "add";
          reason = "remote-new";
          effectiveValue = remoteVal;
        }
      } else if (isRemoteResource) {
        if (localHash === remoteHash) {
          plannedAction = "keep";
          reason = "initial-adopt-identical";
          effectiveValue = localVal;
        } else {
          plannedAction = "conflict";
          reason = "initial-conflict-both-exist-different";
        }
      } else {
        plannedAction = "keep";
        reason = "local-unmanaged";
      }
    } else if (isRemoteTombstone) {
      if (!localPresent) {
        plannedAction = "keep";
        reason = "already-absent";
      } else if (localHash === baselineHash) {
        plannedAction = "delete";
        reason = "remote-deleted";
      } else {
        plannedAction = "conflict";
        reason = "conflict-local-modified-remote-deleted";
      }
    } else if (isRemoteResource) {
      if (localHash === remoteHash) {
        plannedAction = "keep";
        reason = "identical-to-remote";
      } else if (localHash === baselineHash) {
        plannedAction = "update";
        reason = "remote-updated";
        effectiveValue = remoteVal;
      } else if (remoteHash === baselineHash) {
        plannedAction = "keep";
        reason = "local-modified-remote-unchanged";
      } else {
        plannedAction = "conflict";
        reason = "conflict-concurrent-modifications";
      }
    } else {
      plannedAction = "keep";
      reason = "not-in-remote-snapshot";
    }

    if (legacyBaselineUnverifiable) {
      plannedAction = "conflict";
      reason = "legacy-baseline-unverifiable";
      effectiveValue = null;
    } else if (plannedAction === "add" || plannedAction === "update") {
      acceptedTransitions.set(id, { hash: remoteHash, tombstone: false });
    } else if (reason === "initial-adopt-identical") {
      acceptedTransitions.set(id, { hash: localHash, tombstone: false });
    } else if (reason === "identical-to-remote") {
      acceptedTransitions.set(id, { hash: remoteHash, tombstone: false });
    } else if (reason === "local-modified-remote-unchanged") {
      acceptedTransitions.set(id, { hash: baselineHash, tombstone: false });
    } else if (reason === "remote-deleted" || reason === "already-absent") {
      acceptedTransitions.set(id, { hash: SENTINEL_DELETED, tombstone: true });
    }

    // Check for plugin prerequisite if plannedAction is add or update
    if ((plannedAction === "add" || plannedAction === "update") && id.startsWith("plugin:")) {
      const pluginName = id.slice("plugin:".length);
      const reqVersion = effectiveValue?.version;
      const installedPkgPath = path.join(
        pluginsDir,
        "node_modules",
        ...pluginName.split("/"),
        "package.json"
      );

      let installedVer = null;
      if (fs.existsSync(installedPkgPath)) {
        installedVer = parseJsonStrict(
          fs.readFileSync(installedPkgPath, "utf8"),
          `${pluginName} package.json`
        ).version;
      }

      if (!installedVer) {
        plannedAction = "blocked";
        reason = "plugin-not-installed";
        prerequisites.push(
          `Plugin '${pluginName}' is not installed. Run: omp plugin install ${pluginName}@${reqVersion}`
        );
      } else if (installedVer !== reqVersion) {
        plannedAction = "blocked";
        reason = "plugin-version-mismatch";
        prerequisites.push(
          `Plugin '${pluginName}' installed version (${installedVer}) does not match required version (${reqVersion}). Run: omp plugin install ${pluginName}@${reqVersion}`
        );
      }
    }
    if (plannedAction === "blocked") acceptedTransitions.delete(id);

    // Path restoration on incoming values for add or update
    if ((plannedAction === "add" || plannedAction === "update") && effectiveValue !== null) {
      const { value: restoredVal, prerequisites: prereqs } = restoreResourceForImport(
        id,
        effectiveValue,
        root
      );
      effectiveValue = restoredVal;
      if (prereqs.length > 0) {
        prerequisites.push(...prereqs);
      }
      remapped = true;
    }

    if (plannedAction === "add" || plannedAction === "update" || plannedAction === "delete") {
      try {
        const rootTarget = assertSafeTarget(root, targetPath);
        if (id.startsWith("asset:") && plannedAction !== "delete") {
          const archiveRel = id.slice("asset:".length);
          const incomingDirectory = effectiveValue.some((file) => file.path !== archiveRel);
          let currentStat;
          try {
            currentStat = fs.lstatSync(rootTarget.abs);
          } catch (err) {
            if (err?.code !== "ENOENT") throw err;
          }
          if (currentStat && ((currentStat.isDirectory() && !incomingDirectory) ||
              (currentStat.isFile() && incomingDirectory) ||
              (!currentStat.isDirectory() && !currentStat.isFile()))) {
            throw new Error(`Asset type conversion is blocked for '${archiveRel}'`);
          }
          for (const file of effectiveValue) {
            assertSafeTarget(root, file.path);
          }
        }
      } catch (err) {
        plannedAction = "blocked";
        reason = err.message;
        acceptedTransitions.delete(id);
      }
    }

    if (plannedAction === "conflict") {
      conflicts.push({
        id,
        reason,
        targetPath,
      });
    }

    if (plannedAction === "blocked") {
      blocked.push({
        id,
        reason,
        targetPath,
      });
    }

    actions.push({
      id,
      action: plannedAction,
      reason,
      targetPath,
      remapped,
      value: effectiveValue,
      localHash,
      remoteHash,
      baselineHash,
    });
  }

  const nextResources = cloneOwn(state.resources || {});
  const nextTombstones = new Set(state.tombstones || []);
  for (const [id, transition] of acceptedTransitions) {
    Object.defineProperty(nextResources, id, {
      value: { hash: transition.hash, hashFormat: "portable-v1" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (transition.tombstone) nextTombstones.add(id);
    else nextTombstones.delete(id);
  }
  const nextState = validateSyncState({
    ...cloneOwn(state),
    version: 1,
    namespace: validSnapshot.namespace,
    resources: nextResources,
    tombstones: Array.from(nextTombstones).sort(),
  });

  const rendered = renderResourceChanges(root, actions, readContext);
  const publicActions = actions.map(({ id, action, reason, targetPath, remapped }) => ({
    id, action, reason, targetPath, remapped,
  }));
  const publicWrites = Array.from(rendered.values())
    .map(({ rel, operation }) => ({ path: rel, operation }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const report = deepFreeze({
    namespace: validSnapshot.namespace,
    actions: publicActions,
    conflicts,
    blocked,
    prerequisites,
    writes: publicWrites,
  });
  planTransactions.set(report, {
    root: path.resolve(root),
    nextState,
    actions,
    entries: rendered,
    readContext,
    namespace: validSnapshot.namespace,
    needsCommit: rendered.size > 0 || JSON.stringify(state) !== JSON.stringify(nextState),
    consumed: false,
  });
  return report;
}
