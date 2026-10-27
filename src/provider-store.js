/**
 * Dual-Tier Provider Storage Manager
 *
 * Segregates public (synced) configurations in `models.yml` from
 * private/host-specific (unsynced, non-overwritten) configurations in `models.local.json`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function getAgentDir(customRoot) {
  return customRoot || process.env.OMP_CFG_ROOT || path.join(os.homedir(), ".omp", "agent");
}

export function getOmpDir(customRoot) {
  return path.dirname(getAgentDir(customRoot));
}

const LOCAL_LOADER_SCRIPT = `import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export default function (pi) {
  const agentDir = process.env.OMP_CFG_ROOT || path.join(os.homedir(), ".omp", "agent");
  const localPath = path.join(agentDir, "models.local.json");
  if (!fs.existsSync(localPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(localPath, "utf8"));
    for (const [name, cfg] of Object.entries(data.providers || {})) {
      pi.registerProvider(name, cfg);
    }
  } catch (err) {
    console.error("[local-models] Failed to load private providers:", err);
  }
}
`;

/**
 * Ensures ~/.omp/extensions/local-models.js exists so private models are ambiently registered.
 */
export function ensureLocalExtension(ompDir) {
  const extDir = path.join(ompDir, "extensions");
  if (!fs.existsSync(extDir)) {
    fs.mkdirSync(extDir, { recursive: true });
  }
  const extPath = path.join(extDir, "local-models.js");
  if (!fs.existsSync(extPath)) {
    fs.writeFileSync(extPath, LOCAL_LOADER_SCRIPT, "utf8");
  }
}

/**
 * Parse OMP models.yml providers mapping.
 */
export function parseYamlModels(str) {
  if (!str || typeof str !== "string") return {};
  const lines = str.split("\n");
  const providers = {};
  let curProvider = null;
  let curModel = null;
  let inModels = false;
  let inCompat = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.search(/\S/);

    if (trimmed === "providers:") {
      continue;
    }

    if (indent === 2 && trimmed.endsWith(":")) {
      const pName = trimmed.slice(0, -1).trim();
      curProvider = { models: [] };
      providers[pName] = curProvider;
      inModels = false;
      inCompat = false;
      continue;
    }

    if (curProvider && indent === 4) {
      inModels = false;
      inCompat = false;
      if (trimmed === "models:") {
        inModels = true;
        continue;
      }
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();
        if (val === "true") val = true;
        else if (val === "false") val = false;
        curProvider[key] = val;
      }
      continue;
    }

    if (curProvider && inModels) {
      if (trimmed.startsWith("- ")) {
        curModel = {};
        curProvider.models.push(curModel);
        inCompat = false;
        const rest = trimmed.slice(2).trim();
        if (rest) {
          const colonIdx = rest.indexOf(":");
          if (colonIdx > 0) {
            const k = rest.slice(0, colonIdx).trim();
            let v = rest.slice(colonIdx + 1).trim();
            if (v === "true") v = true;
            else if (v === "false") v = false;
            else if (/^\d+$/.test(v)) v = parseInt(v, 10);
            curModel[k] = v;
          }
        }
        continue;
      }

      if (curModel && indent >= 6) {
        if (trimmed === "compat:") {
          inCompat = true;
          curModel.compat = {};
          continue;
        }
        if (inCompat && indent >= 8) {
          const colonIdx = trimmed.indexOf(":");
          if (colonIdx > 0) {
            const k = trimmed.slice(0, colonIdx).trim();
            let v = trimmed.slice(colonIdx + 1).trim();
            if (v === "true") v = true;
            else if (v === "false") v = false;
            else if (/^\d+$/.test(v)) v = parseInt(v, 10);
            curModel.compat[k] = v;
          }
          continue;
        }

        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
          const k = trimmed.slice(0, colonIdx).trim();
          let v = trimmed.slice(colonIdx + 1).trim();
          if (v.startsWith("[") && v.endsWith("]")) {
            v = v
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
          } else if (v === "true") v = true;
          else if (v === "false") v = false;
          else if (/^\d+$/.test(v)) v = parseInt(v, 10);
          curModel[k] = v;
        }
      }
    }
  }

  return providers;
}

/**
 * Format providers object back to standard YAML.
 */
export function formatYamlModels(providers) {
  let out = "providers:\n";
  for (const [name, cfg] of Object.entries(providers || {})) {
    out += `  ${name}:\n`;
    if (cfg.private) out += `    private: true\n`;
    if (cfg.baseUrl) out += `    baseUrl: ${cfg.baseUrl}\n`;
    if (cfg.api) out += `    api: ${cfg.api}\n`;
    if (cfg.apiKey) out += `    apiKey: ${cfg.apiKey}\n`;
    if (cfg.authHeader !== undefined) out += `    authHeader: ${cfg.authHeader}\n`;
    if (Array.isArray(cfg.models) && cfg.models.length > 0) {
      out += `    models:\n`;
      for (const m of cfg.models) {
        out += `      - id: ${m.id}\n`;
        if (m.name) out += `        name: ${m.name}\n`;
        if (m.reasoning) out += `        reasoning: true\n`;
        if (m.input) {
          const inp = Array.isArray(m.input) ? `[${m.input.join(",")}]` : m.input;
          out += `        input: ${inp}\n`;
        }
        if (m.contextWindow) out += `        contextWindow: ${m.contextWindow}\n`;
        if (m.maxTokens) out += `        maxTokens: ${m.maxTokens}\n`;
        if (m.compat && typeof m.compat === "object") {
          out += `        compat:\n`;
          for (const [k, v] of Object.entries(m.compat)) {
            out += `          ${k}: ${v}\n`;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Read public providers from models.yml.
 */
export function readPublicProviders(agentDir) {
  const filePath = path.join(agentDir, "models.yml");
  if (!fs.existsSync(filePath)) {
    const yamlAlt = path.join(agentDir, "models.yaml");
    if (!fs.existsSync(yamlAlt)) return {};
    return parseYamlModels(fs.readFileSync(yamlAlt, "utf8"));
  }
  return parseYamlModels(fs.readFileSync(filePath, "utf8"));
}

/**
 * Write public providers to models.yml.
 */
export function writePublicProviders(agentDir, providers) {
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  const filePath = path.join(agentDir, "models.yml");
  const content = formatYamlModels(providers);
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Read private providers from models.local.json.
 */
export function readPrivateProviders(agentDir) {
  const filePath = path.join(agentDir, "models.local.json");
  if (!fs.existsSync(filePath)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return json.providers || {};
  } catch {
    return {};
  }
}

/**
 * Write private providers to models.local.json.
 */
export function writePrivateProviders(agentDir, providers) {
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  const filePath = path.join(agentDir, "models.local.json");
  fs.writeFileSync(filePath, JSON.stringify({ providers }, null, 2), "utf8");
}

/**
 * Save a provider into either public or private store.
 */
export function saveProvider({
  name,
  providerConfig,
  isPrivate = false,
  agentDir = getAgentDir(),
}) {
  if (!name || typeof name !== "string") {
    throw new Error("Provider name is required");
  }

  const cleanConfig = {
    private: Boolean(isPrivate),
    baseUrl: providerConfig.baseUrl,
    api: providerConfig.api || "openai-completions",
    apiKey: providerConfig.apiKey || "",
    authHeader: providerConfig.authHeader !== undefined ? providerConfig.authHeader : true,
    models: Array.isArray(providerConfig.models) ? providerConfig.models : [],
  };

  // Always save to models.yml so OMP /model natively sees and uses it
  const pub = readPublicProviders(agentDir);
  pub[name] = cleanConfig;
  writePublicProviders(agentDir, pub);

  // Also record in models.local.json for redundancy
  if (isPrivate) {
    const priv = readPrivateProviders(agentDir);
    priv[name] = cleanConfig;
    writePrivateProviders(agentDir, priv);
    ensureLocalExtension(getOmpDir(agentDir));
  } else {
    const priv = readPrivateProviders(agentDir);
    if (priv[name]) {
      delete priv[name];
      writePrivateProviders(agentDir, priv);
    }
  }

  return { name, isPrivate, providerConfig: cleanConfig };
}

/**
 * Remove a provider from both stores.
 */
export function removeProvider({ name, agentDir = getAgentDir() }) {
  let removed = false;

  const pub = readPublicProviders(agentDir);
  if (pub[name]) {
    delete pub[name];
    writePublicProviders(agentDir, pub);
    removed = true;
  }

  const priv = readPrivateProviders(agentDir);
  if (priv[name]) {
    delete priv[name];
    writePrivateProviders(agentDir, priv);
    removed = true;
  }

  return removed;
}

/**
 * List all providers across both tiers.
 */
export function listProviders({ agentDir = getAgentDir() } = {}) {
  const pub = readPublicProviders(agentDir);
  const priv = readPrivateProviders(agentDir);
  const merged = { ...priv, ...pub };

  const list = [];
  for (const [name, cfg] of Object.entries(merged)) {
    list.push({
      name,
      isPrivate: Boolean(cfg.private || priv[name]),
      baseUrl: cfg.baseUrl,
      api: cfg.api,
      apiKey: cfg.apiKey,
      models: cfg.models || [],
    });
  }

  return list;
}

/**
 * Get details for a single provider.
 */
export function getProvider(name, { agentDir = getAgentDir() } = {}) {
  const priv = readPrivateProviders(agentDir);
  if (priv[name]) {
    return { name, isPrivate: true, ...priv[name] };
  }
  const pub = readPublicProviders(agentDir);
  if (pub[name]) {
    return { name, isPrivate: false, ...pub[name] };
  }
  return null;
}
