import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  configRoot,
  MAX_FILE_SIZE,
  ompHome,
  parseJsonStrict,
  parseYamlStrict,
  pointerToTokens,
  validateAssetFiles,
} from "./sync-files.js";

export { MAX_FILE_SIZE, parseYamlStrict, pointerToTokens };
import {
  isExactSemver,
  validateResourceId,
  validateAssetPath,
} from "./sync-policy.js";

export const HOME_PLACEHOLDER = "{{OMP_HOME}}";

export const BLACKLIST_PATTERNS = [
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
  /(^|\/)installation\//,
  /(^|\/)providers\//,
  /(^|\/)runtime\//,
  /(^|\/)smoke\//,
  /(^|\/)tools\/rea(\/|$)/,
  /\.(zip|jar|apk|exe|dll|so|dylib|whl|tar|gz|7z)$/i,
];

export function isBlacklisted(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  return BLACKLIST_PATTERNS.some((rx) => rx.test(norm));
}

/**
 * Whole-asset exclusions. BLACKLIST_PATTERNS guard individual FILES inside a bundle;
 * these patterns exclude an entire asset directory from being a sync resource at all
 * (inventory, menus, collect, archive). Keep the two lists separate: file-level patterns
 * like /local-/ legitimately match asset names (e.g. tools/local-demo).
 */
export const ASSET_EXCLUDE_PATTERNS = [
  /(^|\/)tools\/rea(\/|$)/,
];

export function isBlacklistedAssetPath(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  return ASSET_EXCLUDE_PATTERNS.some((rx) => rx.test(norm));
}

/**
 * Checks if a command exists in system PATH (lookpath / which equivalent).
 */
export function isCommandInPath(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  if (cmd.includes("/") || cmd.includes("\\")) {
    return fs.existsSync(cmd);
  }
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
      : [""];

  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return true;
        }
      } catch {}
    }
  }
  return false;
}

/**
 * Encodes segments into a JSON pointer.
 */
export function tokensToPointer(tokens) {
  return (
    "/" +
    tokens
      .map((t) => String(t).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

/**
 * Reads an asset directory/file ensuring no symlinks, blacklisted files, or oversized files.
 * Returns sorted array of { path: archiveRel, data: base64, mode: number }.
 */
export function readAssetBundle(baseDir, archivePrefix) {
  const files = [];

  function scan(currentDir, currentRel) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      const relPath = currentRel ? `${currentRel}/${ent.name}` : ent.name;
      const fullPath = path.join(currentDir, ent.name);
      const lstat = fs.lstatSync(fullPath);

      if (lstat.isSymbolicLink()) {
        throw new Error(
          `Asset '${archivePrefix}' cannot be bundled completely: contains symbolic link '${relPath}'`
        );
      }
      if (isBlacklisted(relPath)) {
        throw new Error(
          `Asset '${archivePrefix}' cannot be bundled completely: contains blacklisted file '${relPath}'`
        );
      }

      if (ent.isDirectory()) {
        scan(fullPath, relPath);
      } else if (ent.isFile()) {
        if (lstat.size > MAX_FILE_SIZE) {
          throw new Error(
            `Asset '${archivePrefix}' cannot be bundled completely: file '${relPath}' (${lstat.size} B) exceeds 10 MiB limit`
          );
        }
        const data = fs.readFileSync(fullPath).toString("base64");
        const mode = lstat.mode & 0o777;
        const archiveRel = `${archivePrefix}/${relPath}`.replace(/\\/g, "/");
        files.push({ path: archiveRel, data, mode });
      }
    }
  }

  const stat = fs.lstatSync(baseDir);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Asset '${archivePrefix}' cannot be bundled: root is a symbolic link`
    );
  }
  if (stat.isDirectory()) {
    scan(baseDir, "");
  } else if (stat.isFile()) {
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `Asset '${archivePrefix}' exceeds 10 MiB limit`
      );
    }
    const data = fs.readFileSync(baseDir).toString("base64");
    const mode = stat.mode & 0o777;
    files.push({ path: archivePrefix, data, mode });
  }

  // Sort files strictly by path
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * Inventories all local resources and their classifications.
 * Returns array of:
 * {
 *   id: string,
 *   category: "provider" | "mcp" | "setting" | "plugin" | "asset",
 *   name: string,
 *   sourceRel: string,
 *   isPrivate?: boolean,
 *   value?: any
 * }
 */
export function inventoryResources(root = configRoot()) {
  const resources = [];
  const agentDir = root;
  const ompDir = ompHome(root);

  // 1. Providers
  // Read models.yml / models.yaml
  let yamlFile = "models.yml";
  let yamlPath = path.join(agentDir, "models.yml");
  if (!fs.existsSync(yamlPath)) {
    const yamlAlt = path.join(agentDir, "models.yaml");
    if (fs.existsSync(yamlAlt)) {
      yamlFile = "models.yaml";
      yamlPath = yamlAlt;
    }
  }

  let yamlProviders = {};
  if (fs.existsSync(yamlPath)) {
    try {
      const doc = parseYamlStrict(fs.readFileSync(yamlPath, "utf8"), yamlFile);
      const provs = doc.get("providers");
      if (provs && typeof provs.toJSON === "function") {
        yamlProviders = provs.toJSON() || {};
      } else if (provs && typeof provs === "object") {
        yamlProviders = provs;
      }
    } catch (err) {
      throw new Error(`Failed to parse ${yamlFile}: ${err.message}`);
    }
  }

  // Read models.local.json
  const localJsonPath = path.join(agentDir, "models.local.json");
  let localJsonProviders = {};
  if (fs.existsSync(localJsonPath)) {
    const parsed = parseJsonStrict(fs.readFileSync(localJsonPath, "utf8"), "models.local.json");
    if (parsed?.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)) {
      localJsonProviders = parsed.providers;
    }
  }

  const allProviderNames = new Set([
    ...Object.keys(yamlProviders),
    ...Object.keys(localJsonProviders),
  ]);

  for (const name of Array.from(allProviderNames).sort()) {
    const yamlCfg = Object.hasOwn(yamlProviders, name) ? yamlProviders[name] : null;
    const localCfg = Object.hasOwn(localJsonProviders, name) ? localJsonProviders[name] : null;
    const inLocal = localCfg !== null;
    const inYaml = yamlCfg !== null;
    const yamlPrivate = yamlCfg?.private === true;

    const isPrivate = inLocal || yamlPrivate;
    const effectiveCfg = (isPrivate && localCfg !== null) ? localCfg : (yamlCfg !== null ? yamlCfg : localCfg);

    resources.push({
      id: `provider:${name}`,
      category: "provider",
      name,
      sourceRel: inLocal ? "models.local.json" : yamlFile,
      isPrivate,
      value: effectiveCfg,
    });
  }

  // 2. MCP Servers
  const mcpPath = path.join(agentDir, "mcp.json");
  if (fs.existsSync(mcpPath)) {
    const mcpData = parseJsonStrict(fs.readFileSync(mcpPath, "utf8"), "mcp.json");
    if (mcpData?.mcpServers && typeof mcpData.mcpServers === "object" && !Array.isArray(mcpData.mcpServers)) {
      for (const name of Object.keys(mcpData.mcpServers)) {
        const cfg = mcpData.mcpServers[name];
        if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
          throw new Error(`Invalid MCP server '${name}': value must be an object`);
        }
        resources.push({
          id: `mcp:${name}`,
          category: "mcp",
          name,
          sourceRel: "mcp.json",
          isPrivate: false,
          value: cfg,
        });
      }
    }
  }

  // 3. Settings in config.yml / config.yaml
  let configFileName = "config.yml";
  let configFilePath = path.join(agentDir, "config.yml");
  if (!fs.existsSync(configFilePath)) {
    const configAlt = path.join(agentDir, "config.yaml");
    if (fs.existsSync(configAlt)) {
      configFileName = "config.yaml";
      configFilePath = configAlt;
    }
  }

  if (fs.existsSync(configFilePath)) {
    try {
      const doc = parseYamlStrict(
        fs.readFileSync(configFilePath, "utf8"),
        configFileName
      );
      const json = doc.toJSON() || {};

      function collectLeaves(obj, tokens = []) {
        if (
          obj === null ||
          typeof obj !== "object" ||
          Array.isArray(obj)
        ) {
          const ptr = tokensToPointer(tokens);
          resources.push({
            id: `setting:${ptr}`,
            category: "setting",
            name: ptr,
            sourceRel: configFileName,
            isPrivate: false,
            value: obj,
          });
          return;
        }
        for (const [k, v] of Object.entries(obj)) {
          collectLeaves(v, [...tokens, k]);
        }
      }

      collectLeaves(json);
    } catch (err) {
      throw new Error(`Failed to parse ${configFileName}: ${err.message}`);
    }
  }

  // 4. Skills (agent/skills and managed-skills)
  const skillsBase = path.join(agentDir, "skills");
  if (fs.existsSync(skillsBase)) {
    const entries = fs.readdirSync(skillsBase, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const skillMd = path.join(skillsBase, ent.name, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          resources.push({
            id: `asset:skills/${ent.name}`,
            category: "asset",
            name: `skills/${ent.name}`,
            sourceRel: `skills/${ent.name}`,
            isPrivate: false,
          });
        }
      }
    }
  }

  const managedSkillsBase = path.join(agentDir, "managed-skills");
  if (fs.existsSync(managedSkillsBase)) {
    const entries = fs.readdirSync(managedSkillsBase, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const skillMd = path.join(managedSkillsBase, ent.name, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          resources.push({
            id: `asset:managed-skills/${ent.name}`,
            category: "asset",
            name: `managed-skills/${ent.name}`,
            sourceRel: `managed-skills/${ent.name}`,
            isPrivate: false,
          });
        }
      }
    }
  }

  // 5. Extensions, Tools, Hooks, Top-level Files
  // Extensions in agent/extensions
  const agentExtDir = path.join(agentDir, "extensions");
  if (fs.existsSync(agentExtDir)) {
    for (const ent of fs.readdirSync(agentExtDir, { withFileTypes: true })) {
      resources.push({
        id: `asset:extensions/${ent.name}`,
        category: "asset",
        name: `extensions/${ent.name}`,
        sourceRel: `extensions/${ent.name}`,
        isPrivate: false,
      });
    }
  }

  // Tools in ompHome/tools
  const toolsDir = path.join(ompDir, "tools");
  if (fs.existsSync(toolsDir)) {
    for (const ent of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      resources.push({
        id: `asset:tools/${ent.name}`,
        category: "asset",
        name: `tools/${ent.name}`,
        sourceRel: `tools/${ent.name}`,
        isPrivate: false,
      });
    }
  }

  // Hooks in ompHome/hooks
  const hooksDir = path.join(ompDir, "hooks");
  if (fs.existsSync(hooksDir)) {
    for (const ent of fs.readdirSync(hooksDir, { withFileTypes: true })) {
      resources.push({
        id: `asset:hooks/${ent.name}`,
        category: "asset",
        name: `hooks/${ent.name}`,
        sourceRel: `hooks/${ent.name}`,
        isPrivate: false,
      });
    }
  }

  // Top level instruction files
  for (const docFile of ["AGENTS.md", "STYLE.md", "RULES.md"]) {
    const p = path.join(agentDir, docFile);
    if (fs.existsSync(p)) {
      resources.push({
        id: `asset:${docFile}`,
        category: "asset",
        name: docFile,
        sourceRel: docFile,
        isPrivate: false,
      });
    }
  }

  // 6. Plugins
  const pluginsDir = path.join(ompDir, "plugins");
  const pluginPkgPath = path.join(pluginsDir, "package.json");
  if (fs.existsSync(pluginPkgPath)) {
    const pkg = parseJsonStrict(fs.readFileSync(pluginPkgPath, "utf8"), "plugins/package.json");
    const lockPath = path.join(pluginsDir, "omp-plugins.lock.json");
    let lockData = {};
    if (fs.existsSync(lockPath)) {
      lockData = parseJsonStrict(fs.readFileSync(lockPath, "utf8"), "omp-plugins.lock.json") || {};
    }
    const dependencies = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
    for (const pkgName of Object.keys(dependencies)) {
      const versionSpec = dependencies[pkgName];
      if (pkgName === "omp-config-crypt") continue;
      const lockEntry = lockData.plugins && Object.hasOwn(lockData.plugins, pkgName) ? lockData.plugins[pkgName] : undefined;
      resources.push({
        id: `plugin:${pkgName}`,
        category: "plugin",
        name: pkgName,
        sourceRel: "plugins/package.json",
        isPrivate: false,
        value: {
          name: pkgName,
          versionSpec,
          lockVersion: lockEntry?.version,
          enabled: lockEntry?.enabled !== false,
        },
      });
    }
  }

  // Whole-asset exclusions (e.g. tools/rea) are not sync resources at all: they can
  // never bundle (blacklisted internals), so offering them breaks collect/archive/push.
  // The per-file blacklist still guards files INSIDE every other asset.
  return resources.filter((item) => item.category !== "asset" || !isBlacklistedAssetPath(item.name));
}

/**
 * Reads a single resource value by ID from the filesystem.
 */
export function readResource(root = configRoot(), id) {
  const { prefix, name } = validateResourceId(id);
  const agentDir = root;
  const ompDir = ompHome(root);

  if (prefix === "provider") {
    const localJsonPath = path.join(agentDir, "models.local.json");
    let localCfg = null;
    if (fs.existsSync(localJsonPath)) {
      const json = parseJsonStrict(fs.readFileSync(localJsonPath, "utf8"), "models.local.json");
      localCfg = json?.providers && Object.hasOwn(json.providers, name) ? json.providers[name] : null;
    }

    let yamlCfg = null;
    const yamlFile = fs.existsSync(path.join(agentDir, "models.yml")) ? "models.yml" : "models.yaml";
    const yamlPath = path.join(agentDir, yamlFile);
    if (fs.existsSync(yamlPath)) {
      const doc = parseYamlStrict(fs.readFileSync(yamlPath, "utf8"), yamlFile);
      const provs = doc.get("providers");
      if (provs && typeof provs.get === "function") {
        const node = provs.get(name);
        if (node !== undefined) yamlCfg = typeof node?.toJSON === "function" ? node.toJSON() : node;
      }
    }

    for (const [label, value] of [["models.local.json", localCfg], [yamlFile, yamlCfg]]) {
      if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`Invalid provider '${name}' in ${label}: value must be an object`);
      }
    }
    const isPrivate = localCfg !== null || yamlCfg?.private === true;
    const value = isPrivate && localCfg !== null ? localCfg : (yamlCfg !== null ? yamlCfg : localCfg);
    if (value === null) return null;
    return { id, isPrivate, value };
  }

  if (prefix === "mcp") {
    const mcpPath = path.join(agentDir, "mcp.json");
    if (!fs.existsSync(mcpPath)) return null;
    const data = parseJsonStrict(fs.readFileSync(mcpPath, "utf8"), "mcp.json");
    const server = data?.mcpServers && Object.hasOwn(data.mcpServers, name) ? data.mcpServers[name] : null;
    if (server === null) return null;
    if (typeof server !== "object" || Array.isArray(server)) {
      throw new Error(`Invalid MCP server '${name}': value must be an object`);
    }
    return { id, isPrivate: false, value: server };
  }

  if (prefix === "setting") {
    const configFile = fs.existsSync(path.join(agentDir, "config.yml")) ? "config.yml" : "config.yaml";
    const configFilePath = path.join(agentDir, configFile);
    if (!fs.existsSync(configFilePath)) return null;
    const doc = parseYamlStrict(fs.readFileSync(configFilePath, "utf8"), configFile);
    const tokens = pointerToTokens(name);
    const valNode = doc.getIn(tokens);
    if (valNode === undefined) return null;
    const value = typeof valNode?.toJSON === "function" ? valNode.toJSON() : valNode;
    return { id, isPrivate: false, value };
  }

  if (prefix === "plugin") {
    const pluginsDir = path.join(ompDir, "plugins");
    const pkgPath = path.join(pluginsDir, "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = parseJsonStrict(fs.readFileSync(pkgPath, "utf8"), "plugins/package.json");
    const versionSpec = pkg?.dependencies && Object.hasOwn(pkg.dependencies, name) ? pkg.dependencies[name] : undefined;
    if (versionSpec === undefined) return null;

    const installedPkgPath = path.join(pluginsDir, "node_modules", ...name.split("/"), "package.json");
    let installedVersion = null;
    if (fs.existsSync(installedPkgPath)) {
      const installed = parseJsonStrict(fs.readFileSync(installedPkgPath, "utf8"), `${name} package.json`);
      installedVersion = installed.version;
    }

    const lockPath = path.join(pluginsDir, "omp-plugins.lock.json");
    let lockData = {};
    if (fs.existsSync(lockPath)) {
      lockData = parseJsonStrict(fs.readFileSync(lockPath, "utf8"), "omp-plugins.lock.json") || {};
    }
    const lockEntry = lockData.plugins && Object.hasOwn(lockData.plugins, name) ? lockData.plugins[name] : undefined;

    return {
      id,
      isPrivate: false,
      value: {
        name,
        versionSpec,
        installedVersion,
        lockVersion: lockEntry?.version,
        enabled: lockEntry?.enabled !== false,
      },
    };
  }

  if (prefix === "asset") {
    const archiveRel = name;
    const diskPath = archiveRel.startsWith("tools/") || archiveRel.startsWith("hooks/")
      ? path.join(ompDir, archiveRel)
      : path.join(agentDir, archiveRel);
    if (!fs.existsSync(diskPath)) return null;
    return { id, isPrivate: false, value: readAssetBundle(diskPath, archiveRel) };
  }

  return null;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: cloneJson(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

function normalizedSlashes(value) {
  return value.replace(/\\/g, "/");
}

function samePortablePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isAbsoluteHostPath(value) {
  return typeof value === "string" &&
    (path.isAbsolute(value) || /^[a-zA-Z]:[/\\]/.test(value) || value.startsWith("/") || value.startsWith("\\\\"));
}

function mapHomePath(id, value, field) {
  if (!isAbsoluteHostPath(value)) return value;
  const home = normalizedSlashes(os.homedir()).replace(/\/+$/, "");
  const candidate = normalizedSlashes(value);
  if (samePortablePath(candidate, home)) return HOME_PLACEHOLDER;
  if (candidate.length > home.length && samePortablePath(candidate.slice(0, home.length), home) &&
      candidate[home.length] === "/") {
    return HOME_PLACEHOLDER + candidate.slice(home.length);
  }
  throw new Error(`Resource '${id}' field '${field}' contains an absolute path outside HOME; it must be self-contained before publishing`);
}

function containsAbsolutePath(value) {
  if (typeof value === "string") return isAbsoluteHostPath(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === "object") return Object.values(value).some(containsAbsolutePath);
  return false;
}

/**
 * Returns the sole canonical representation used for export, comparison, and baselines.
 */
export function canonicalResourceValue(id, value, root = configRoot()) {
  const { prefix, name } = validateResourceId(id);

  if (prefix === "plugin") {
    let version;
    if (Object.hasOwn(value, "versionSpec")) {
      // npm-style registry ranges (e.g. ^1.0.0) can never equal an installed version,
      // so the portable truth is the exact installed version. Non-registry sources
      // (file:, link:, git, aliases) must not be published as registry versions.
      const spec = value.versionSpec;
      const registryBased =
        typeof spec === "string" &&
        !spec.includes(":") &&
        !spec.startsWith("/") &&
        !spec.startsWith("./") &&
        !spec.startsWith("../") &&
        !/^[0-9a-f]{40}$/i.test(spec);
      const exact = isExactSemver(spec) ? spec : registryBased ? value.installedVersion : undefined;
      if (!isExactSemver(exact)) {
        throw new Error(`Plugin '${name}' declaration is not an exact semver registry version`);
      }
      if (!isExactSemver(value.installedVersion) || value.installedVersion !== exact) {
        throw new Error(`Plugin '${name}' must be installed at exactly its declared version`);
      }
      if (value.lockVersion !== undefined && value.lockVersion !== null && value.lockVersion !== exact) {
        throw new Error(`Plugin '${name}' lock version conflicts with its declared version`);
      }
      version = exact;
    } else {
      if (!isExactSemver(value.version)) {
        throw new Error(`Plugin '${name}' version is not exact SemVer`);
      }
      if (value.installedVersion !== undefined && value.installedVersion !== null &&
          (!isExactSemver(value.installedVersion) || value.installedVersion !== value.version)) {
        throw new Error(`Plugin '${name}' installed version conflicts with its declared version`);
      }
      version = value.version;
    }
    if (typeof value.enabled !== "boolean") {
      throw new Error(`Plugin '${name}' enabled flag must be boolean`);
    }
    return { name, version, enabled: value.enabled };
  }

  if (prefix === "mcp") {
    const copy = cloneJson(value);
    if (Object.hasOwn(copy, "cwd")) copy.cwd = mapHomePath(id, copy.cwd, "cwd");
    if (Object.hasOwn(copy, "command")) copy.command = mapHomePath(id, copy.command, "command");
    if (Array.isArray(copy.args)) {
      copy.args = copy.args.map((arg, index) => mapHomePath(id, arg, `args[${index}]`));
    }
    return copy;
  }

  if (prefix === "setting") {
    if (name === "/shellPath") return mapHomePath(id, value, "value");
    if (name.startsWith("/extensions") && containsAbsolutePath(value)) {
      throw new Error(`Resource '${id}' contains an absolute path; extensions must use the native scanner`);
    }
    return cloneJson(value);
  }

  if (prefix === "provider") {
    const copy = cloneJson(value);
    delete copy.private;
    return copy;
  }

  if (prefix === "asset") {
    validateAssetFiles(name, value);
    return value
      .map((file) => ({ path: file.path, data: file.data, mode: file.mode }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  return cloneJson(value);
}

/**
 * Sanitizes a resource value for public export.
 */
export function sanitizeResourceForExport(id, value, root = configRoot()) {
  return canonicalResourceValue(id, value, root);
}

/**
 * Restores a resource value for target environment import.
 * - Replaces {{OMP_HOME}} with target os.homedir().
 * - Checks PATH command prerequisites for MCP.
 */
export function restoreResourceForImport(id, value, root = configRoot()) {
  const { prefix, name } = validateResourceId(id);
  const home = os.homedir();
  const prerequisites = [];

  function restoreHomeBoundary(str) {
    if (typeof str !== "string" || !str.startsWith(HOME_PLACEHOLDER)) return str;
    const suffix = str.slice(HOME_PLACEHOLDER.length);
    if (suffix && suffix[0] !== "/" && suffix[0] !== "\\") return str;
    if (!suffix) return home;
    const parts = suffix.split(/[\\/]/).filter(Boolean);
    return path.join(home, ...parts);
  }

  if (prefix === "mcp") {
    const copy = cloneJson(value);
    if (Object.hasOwn(copy, "cwd")) copy.cwd = restoreHomeBoundary(copy.cwd);
    if (Object.hasOwn(copy, "command")) {
      copy.command = restoreHomeBoundary(copy.command);
      if (!copy.command.includes("/") && !copy.command.includes("\\")) {
        if (!isCommandInPath(copy.command)) {
          prerequisites.push(
            `MCP server '${id}': command '${copy.command}' is not found in local system PATH`
          );
        }
      }
    }
    if (Array.isArray(copy.args)) copy.args = copy.args.map(restoreHomeBoundary);
    return { value: copy, prerequisites };
  }

  if (prefix === "setting" && name === "/shellPath") {
    return { value: restoreHomeBoundary(value), prerequisites };
  }

  return { value: cloneJson(value), prerequisites };
}
