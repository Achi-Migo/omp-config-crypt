/**
 * Dual-Tier Provider Storage Manager
 *
 * Segregates public (synced) configurations in `models.yml` from
 * private/host-specific (unsynced, non-overwritten) configurations in `models.local.json`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseDocument } from "yaml";

export function getAgentDir(customRoot) {
  return customRoot || process.env.OMP_CFG_ROOT || path.join(os.homedir(), ".omp", "agent");
}

export function getOmpDir(customRoot) {
  return path.dirname(getAgentDir(customRoot));
}

const LOCAL_LOADER_SCRIPT = `import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_CONTEXT_WINDOW = 256000; // 默认 256K
const DEFAULT_MAX_TOKENS = 65536;

/**
 * 根据名称指纹与知名模型规范推断模型规格
 */
function inferModelSpec(modelId) {
  const id = (modelId || "").toLowerCase();

  // Gemini 系列
  if (/gemini.*pro/.test(id)) {
    return { contextWindow: 2000000, maxTokens: 65536, hasImage: true };
  }
  if (/gemini.*(flash|lite)/.test(id)) {
    return { contextWindow: 1000000, maxTokens: 65536, hasImage: true };
  }

  // DeepSeek 系列
  if (/deepseek.*(v4|pro|flash)/.test(id)) {
    return { contextWindow: 1048576, maxTokens: 65536, hasImage: /flash|vl/.test(id) };
  }
  if (/deepseek/.test(id)) {
    return { contextWindow: 1048576, maxTokens: 32000, hasImage: /vl/.test(id) };
  }

  // Kimi / Moonshot 系列
  if (/kimi|moonshot/.test(id)) {
    return { contextWindow: 512000, maxTokens: 32000, hasImage: false };
  }

  // Claude 系列
  if (/claude/.test(id)) {
    return { contextWindow: 200000, maxTokens: 64000, hasImage: true };
  }

  // GPT-6 / Codex 系列
  if (/(gpt-6|gpt-5\\.[0-9]).*(sol|terra)/.test(id)) {
    return { contextWindow: 256000, maxTokens: 384000, reasoning: true, hasImage: false };
  }
  if (/gpt-6|astra/.test(id)) {
    return { contextWindow: 256000, maxTokens: 32000, hasImage: false };
  }

  // Qwen 系列
  if (/qwen.*(max|plus|turbo|2\\.5)/.test(id)) {
    return { contextWindow: 131072, maxTokens: 32000, hasImage: /vl/.test(id) };
  }

  // 未知模型默认兜底为 256K
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, hasImage: false };
}

/**
 * 优化单一模型配置（拦截 128K 矮截断并赋最优值）
 */
function optimizeModel(model, onlineSpecs = {}) {
  const id = model.id || "";
  const cleanId = id.toLowerCase().replace(/^(3rd|linuxdo|ark|agy)\\//, "");
  const online = onlineSpecs[cleanId] || onlineSpecs[id];

  const inferred = inferModelSpec(id);

  let cw = model.contextWindow;
  let mt = model.maxTokens;
  let input = Array.isArray(model.input) ? [...model.input] : ["text"];
  let reasoning = model.reasoning;

  // 当未设定或处于旧的 128K 兜底（<= 128000）时，自动触发提档
  if (!cw || cw <= 128000) {
    cw = online?.contextWindow || inferred.contextWindow || DEFAULT_CONTEXT_WINDOW;
  }

  // 保证 contextWindow 至少为 DEFAULT_CONTEXT_WINDOW
  if (cw < DEFAULT_CONTEXT_WINDOW) {
    cw = DEFAULT_CONTEXT_WINDOW;
  }

  if (!mt || mt === 32000) {
    mt = online?.maxTokens || inferred.maxTokens || DEFAULT_MAX_TOKENS;
  }

  if ((inferred.hasImage || online?.hasImage) && !input.includes("image")) {
    input.push("image");
  }

  if (inferred.reasoning && reasoning === undefined) {
    reasoning = true;
  }

  return {
    ...model,
    contextWindow: cw,
    maxTokens: mt,
    input,
    ...(reasoning !== undefined ? { reasoning } : {})
  };
}

export default async function (pi) {
  const agentDir = process.env.OMP_CFG_ROOT || path.join(os.homedir(), ".omp", "agent");
  const cacheDir = path.join(agentDir, "cache");
  const cachePath = path.join(cacheDir, "model-specs.json");
  const localPath = path.join(agentDir, "models.local.json");

  // 读取本地缓存的在线模型规格
  let onlineSpecs = {};
  if (fs.existsSync(cachePath)) {
    try {
      onlineSpecs = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {}
  }

  // 注册 Provider 并执行模型参数自适应优化
  if (fs.existsSync(localPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(localPath, "utf8"));
      for (const [name, cfg] of Object.entries(data.providers || {})) {
        const optimizedCfg = { ...cfg };
        if (Array.isArray(cfg.models)) {
          optimizedCfg.models = cfg.models.map(m => optimizeModel(m, onlineSpecs));
        }
        pi.registerProvider(name, optimizedCfg);
      }
    } catch (err) {
      console.error("[local-models] Failed to load private providers:", err);
    }
  }

  // 异步在后台静默刷新 OpenRouter 权威模型规格并落盘缓存
  (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const json = await res.json();
      const updatedSpecs = {};
      for (const m of json.data || []) {
        if (!m.id) continue;
        const shortName = m.id.split("/").pop().toLowerCase();
        const spec = {
          contextWindow: m.context_length || DEFAULT_CONTEXT_WINDOW,
          maxTokens: m.top_provider?.max_completion_tokens || DEFAULT_MAX_TOKENS,
          hasImage: m.architecture?.modality?.includes("image") || false
        };
        updatedSpecs[shortName] = spec;
        updatedSpecs[m.id.toLowerCase()] = spec;
      }
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      fs.writeFileSync(cachePath, JSON.stringify(updatedSpecs, null, 2), "utf8");
    } catch {}
  })();

  // 注册 /models-optimize 治理命令
  pi.registerCommand("models-optimize", {
    description: "一键洗牌优化 models.yml 与 models.local.json 中的模型上下文与输出参数（默认 256K 兜底）",
    handler: async (args, ctx) => {
      ctx.ui.notify("正在扫描并优化模型参数...", "info");
      // 动态清洗 models.local.json
      if (fs.existsSync(localPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(localPath, "utf8"));
          let updated = false;
          for (const p of Object.values(raw.providers || {})) {
            if (Array.isArray(p.models)) {
              p.models = p.models.map(m => {
                const opt = optimizeModel(m, onlineSpecs);
                if (opt.contextWindow !== m.contextWindow || opt.maxTokens !== m.maxTokens) {
                  updated = true;
                }
                return opt;
              });
            }
          }
          if (updated) {
            fs.writeFileSync(localPath, JSON.stringify(raw, null, 2), "utf8");
          }
        } catch (e) {
          ctx.ui.notify(\`优化 models.local.json 失败: \${e.message}\`, "error");
        }
      }
      ctx.ui.notify("模型规格优化完成，默认上下文已对齐至 ≥256K", "info");
    }
  });
}
`;

/**
 * Ensures ~/.omp/agent/extensions/local-models.js exists for native extension scanning.
 */
export function ensureLocalExtension(ompDir) {
  const extDir = path.join(ompDir, "agent", "extensions");
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
  // Prefer the yaml package: handles flow-style (braces) and block-list values
  // (e.g. `input:` followed by `- text` lines) the line parser cannot.
  const parsed = normalizeProviderInputs(parseFlowYamlModels(str));
  if (Object.keys(parsed).length) return parsed;
  return normalizeProviderInputs(parseBlockYamlModels(str));
}

function normalizeProviderInputs(providers) {
  for (const cfg of Object.values(providers || {})) {
    for (const model of cfg?.models || []) {
      if (typeof model.input === "string" && model.input) model.input = [model.input];
    }
  }
  return providers;
}

function parseFlowYamlModels(str) {
  let doc;
  try {
    doc = parseDocument(str, { indent: true });
    if (doc.errors.length) return {};
  } catch {
    return {};
  }
  const data = doc.toJS();
  const providers = data && typeof data === "object" && !Array.isArray(data) ? data.providers : null;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  return providers;
}

function parseBlockYamlModels(str) {
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
        if (inCompat && indent > 8) {
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
        inCompat = false;

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
  assertSupportedProviders(providers);
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
        if (m.reasoning !== undefined) out += `        reasoning: ${m.reasoning}\n`;
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
  assertPublicSource(agentDir);
  const content = formatYamlModels(providers);
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  const filePath = path.join(agentDir, "models.yml");
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
    if (!json || typeof json !== "object" || Array.isArray(json) ||
      (json.providers !== undefined && (!json.providers || typeof json.providers !== "object" || Array.isArray(json.providers)))) {
      throw new Error("Expected providers mapping");
    }
    return json.providers || {};
  } catch (error) {
    throw new Error(`models.local.json 无法读取，未写入: ${error.message}`);
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
    ...providerConfig,
    private: Boolean(isPrivate),
    baseUrl: providerConfig.baseUrl,
    api: providerConfig.api || "openai-completions",
    apiKey: providerConfig.apiKey || "",
    authHeader: providerConfig.authHeader !== undefined ? providerConfig.authHeader : true,
    models: Array.isArray(providerConfig.models) ? providerConfig.models : [],
  };

  // Validate both stores and all formatter limitations before the first write.
  const pub = readPublicProviders(agentDir);
  const priv = readPrivateProviders(agentDir);
  pub[name] = cleanConfig;
  assertPublicSource(agentDir);
  formatYamlModels(pub);
  if (isPrivate) priv[name] = cleanConfig;
  else delete priv[name];
  writePublicProviders(agentDir, pub);
  if (isPrivate || fs.existsSync(path.join(agentDir, "models.local.json"))) {
    writePrivateProviders(agentDir, priv);
  }
  if (isPrivate) ensureLocalExtension(getOmpDir(agentDir));

  return { name, isPrivate, providerConfig: cleanConfig };
}

/**
 * Remove a provider from both stores.
 */
export function removeProvider({ name, agentDir = getAgentDir() }) {
  const pub = readPublicProviders(agentDir);
  const priv = readPrivateProviders(agentDir);
  const removed = Boolean(pub[name] || priv[name]);
  if (!removed) return false;
  delete pub[name];
  delete priv[name];
  assertPublicSource(agentDir);
  formatYamlModels(pub);
  writePublicProviders(agentDir, pub);
  if (fs.existsSync(path.join(agentDir, "models.local.json"))) writePrivateProviders(agentDir, priv);

  return removed;
}

/**
 * List all providers across both tiers.
 */
export function listProviders({ agentDir = getAgentDir() } = {}) {
  const pub = readPublicProviders(agentDir);
  const priv = readPrivateProviders(agentDir);
  const merged = { ...pub, ...priv };

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
    return { name, isPrivate: Boolean(pub[name].private), ...pub[name] };
  }
  return null;
}

const PROVIDER_FIELDS = new Set(["private", "baseUrl", "api", "apiKey", "authHeader", "models"]);
const MODEL_FIELDS = new Set(["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "compat"]);
function unsupported(field) {
  throw new Error(`公开 YAML 格式不支持字段或结构 ${field}；未写入`);
}
function assertSupportedProviders(providers) {
  for (const [name, cfg] of Object.entries(providers || {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) unsupported(name);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) unsupported(name);
    for (const [key, value] of Object.entries(cfg)) {
      if (!PROVIDER_FIELDS.has(key)) unsupported(`${name}.${key}`);
      if (key !== "models" && value !== null && typeof value === "object") unsupported(`${name}.${key}`);
      if (typeof value === "string" && /[\r\n]/.test(value)) unsupported(`${name}.${key}`);
    }
    for (const model of cfg.models || []) {
      for (const [key, value] of Object.entries(model)) {
        if (!MODEL_FIELDS.has(key)) unsupported(`${name}.models.${key}`);
        if (key === "compat") {
          for (const [flag, setting] of Object.entries(value || {})) {
            if (setting !== null && typeof setting === "object") unsupported(`${name}.models.compat.${flag}`);
          }
        } else if (key === "input") {
          if (!Array.isArray(value) || value.some(item => typeof item !== "string")) unsupported(`${name}.models.input`);
        } else if (value !== null && typeof value === "object" || typeof value === "string" && /[\r\n]/.test(value)) {
          unsupported(`${name}.models.${key}`);
        }
      }
    }
  }
}
function assertPublicSource(agentDir) {
  const file = ["models.yml", "models.yaml"].map(name => path.join(agentDir, name)).find(name => fs.existsSync(name));
  if (!file) return;
  const text = fs.readFileSync(file, "utf8");
  // The fixed-field formatter cannot preserve arbitrary YAML. Reject unfamiliar structure,
  // unless the yaml package can parse it into the providers mapping (the next write
  // re-serializes everything in canonical block style anyway).
  try {
    scanBlockSource(text);
  } catch (blockError) {
    if (!parseFlowYamlModels(text) || !Object.keys(parseFlowYamlModels(text)).length) throw blockError;
    assertSupportedProviders(parseFlowYamlModels(text));
    return;
  }
  assertSupportedProviders(readPublicProviders(agentDir));
}
function scanBlockSource(text) {
  // The fixed-field formatter cannot preserve arbitrary YAML. Reject unfamiliar structure.
  let section = "", provider = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.search(/\S/);
    const field = trimmed.replace(/^-\s*/, "").split(":")[0];
    if (indent === 0 && trimmed === "providers:") { section = "providers"; continue; }
    if (indent === 2 && /^[A-Za-z0-9][A-Za-z0-9_-]*:$/.test(trimmed)) { provider = field; section = "provider"; continue; }
    if (provider && indent === 4 && PROVIDER_FIELDS.has(field)) {
      section = field === "models" && trimmed === "models:" ? "models" : "provider";
      if (section === "provider" && field !== "apiKey" && !trimmed.slice(trimmed.indexOf(":") + 1).trim()) unsupported(`${provider}.${field}`);
      continue;
    }
    if (section === "models" || section === "model" || section === "compat") {
      if (indent === 6 && trimmed.startsWith("- ") && field === "id") { section = "model"; continue; }
      if (indent === 8 && MODEL_FIELDS.has(field)) { section = field === "compat" ? "compat" : "model"; continue; }
      if (section === "model" && indent === 10 && trimmed.startsWith("- ")) continue;
      if (indent === 10 && section === "compat" && /^[A-Za-z0-9_-]+:\s*\S/.test(trimmed)) continue;
    }
    unsupported(`${provider || "root"}.${field}`);
  }
}

