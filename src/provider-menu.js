import { listProviders, getProvider, saveProvider, removeProvider } from "./provider-store.js";
import { getRoles } from "./role-manager.js";
import { probeProvider, inferModelCapabilities } from "./prober.js";
import { acquireProviderModels, runModelChecks } from "./provider-models.js";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"];
const DIALOG = { outline: true, helpText: "↑↓ 选择 · Enter 确认 · Esc 返回" };
const select = (ctx, title, options) => ctx.ui.select(title, options, DIALOG);
const rolesFor = (name, agentDir) => Object.entries(getRoles(agentDir))
  .filter(([, ref]) => ref.startsWith(`${name}/`)).map(([role]) => role);

function validName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error("名称须以字母或数字开头，仅含字母、数字、_、-");
  return name;
}
function validUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("地址仅允许 http/https，不能包含用户名密码");
  }
  if (parsed.search || parsed.hash) throw new Error("Base URL 不能包含查询参数或片段");
  return parsed.href.replace(/\/+$/, "");
}
function summary(draft, agentDir) {
  return [draft.name, draft.config.api, draft.config.baseUrl,
    draft.isPrivate ? "PRIVATE · 本地私有" : "PUBLIC · 参与加密同步",
    `模型 (${draft.config.models.length}): ${draft.config.models.map(m => draft.requireVerifiedModels
      ? `${m.id} · ${draft.checks?.get(m.id)?.ok ? `可用 · ${draft.checks.get(m.id).latencyMs} ms` : "未通过验证"}` : m.id).join(", ") || "无"}`,
    `角色: ${rolesFor(draft.name, agentDir).join(", ") || "无"}`,
    `Key: ${draft.config.apiKey ? "已设置" : "未设置"}`,
    draft.requireVerifiedModels ? `已验证 ${draft.config.models.filter(m => draft.checks?.get(m.id)?.ok === true).length}/${draft.config.models.length}`
      : `验证: ${draft.verified ? "已通过生成验证（单模型）" : "未验证"}`].join("\n");
}
function fromProvider(provider) {
  const { name, isPrivate, ...config } = provider;
  return { name, isPrivate: Boolean(isPrivate || config.private), config: structuredClone(config), verified: false };
}
async function inputField(ctx, title, placeholder, validate) {
  for (;;) {
    const value = await ctx.ui.input(title, placeholder);
    if (value === undefined) return;
    try { return validate(value.trim()); }
    catch (error) { ctx.ui.notify(error.message, "error"); }
  }
}
async function chooseApi(ctx) {
  const family = await select(ctx, "PROVIDER // 协议家族", ["OpenAI", "Anthropic"]);
  if (!family) return;
  if (family === "Anthropic") return "anthropic-messages";
  return select(ctx, "OPENAI // 协议", [
    { label: "openai-completions", description: "POST /chat/completions" },
    { label: "openai-responses", description: "POST /responses · Codex 类网关" },
  ]);
}
async function chooseScope(ctx) {
  const scope = await select(ctx, "PROVIDER // 存储范围", [
    { label: "PRIVATE", description: "本地私有（默认）" },
    { label: "PUBLIC", description: "配置与 Key 将参与加密同步" },
  ]);
  return scope === undefined ? undefined : scope === "PRIVATE";
}
async function verifyDraft(ctx, draft) {
  const models = draft.config.models;
  if (!models.length) { ctx.ui.notify("请先配置实际模型 ID", "error"); return; }
  const id = models.length === 1 ? models[0].id : await select(ctx, "TEST // 选择模型", models.map(m => m.id));
  if (!id) return;
  ctx.ui.notify(`正在验证 ${draft.name} / ${id}；将产生一次短生成请求`, "info");
  const result = await probeProvider({ ...draft.config, providerName: draft.name, testModelId: id, verify: true });
  draft.verified = Boolean(result.ok && result.verified);
  ctx.ui.notify((draft.verified ? "连接验证成功（已完成文本生成，单模型）" : `连接验证失败: ${result.error || "未完成生成验证"}`) + ` · ${result.latencyMs ?? 0} ms`, draft.verified ? "info" : "error");
}
const checkIdentity = config => JSON.stringify([config.api, config.baseUrl, config.apiKey || ""]);
async function acquireDraftModels(ctx, draft, agentDir, seedIds = draft.config.models.map(model => model.id)) {
  const acquired = await acquireProviderModels(ctx, { name: draft.name, config: draft.config, agentDir, seedIds });
  if (!acquired) return false;
  draft.config.models = acquired.models;
  draft.config.baseUrl = acquired.baseUrl;
  draft.checks = acquired.checks;
  draft.checkIdentity = checkIdentity(draft.config);
  draft.requireVerifiedModels = true;
  return true;
}
async function recheckDraftModels(ctx, draft) {
  // Clear first: cancelled and unstarted IDs must never inherit earlier successes.
  draft.checks = new Map();
  const identity = checkIdentity(draft.config);
  const batch = await runModelChecks(ctx, { name: draft.name, config: draft.config, ids: draft.config.models.map(model => model.id) });
  if (identity !== checkIdentity(draft.config)) return;
  for (const result of batch.results) if (result.ok) draft.checks.set(result.id, { ok: true, latencyMs: result.latencyMs });
  draft.checkIdentity = identity;
}
async function saveSummary(ctx, draft, agentDir, isNew) {
  if (!draft.requireVerifiedModels && draft.config.api === "anthropic-messages") draft.config.baseUrl = draft.config.baseUrl.replace(/\/v1$/i, "");
  for (;;) {
    if (draft.requireVerifiedModels && draft.checkIdentity !== checkIdentity(draft.config)) draft.checks = new Map();
    const allVerified = draft.config.models.length > 0 && draft.config.models.every(model => draft.checks?.get(model.id)?.ok === true);
    const options = draft.requireVerifiedModels ? (allVerified
      ? ["重新测试已选模型", "保存配置", "取消"] : ["重新选择模型", "重新测试已选模型", "取消"])
      : ["验证后返回摘要", "保存配置", "取消"];
    const choice = await select(ctx, `SAVE // ${summary(draft, agentDir)}`, options);
    if (!choice || choice === "取消") return false;
    if (choice === "验证后返回摘要") { await verifyDraft(ctx, draft); continue; }
    if (choice === "重新测试已选模型") { await recheckDraftModels(ctx, draft); continue; }
    if (choice === "重新选择模型") { await acquireDraftModels(ctx, draft, agentDir); continue; }
    if (draft.requireVerifiedModels && (!allVerified || draft.checkIdentity !== checkIdentity(draft.config))) {
      ctx.ui.notify("所选模型未通过验证，请重新选择或重新测试", "error"); continue;
    }
    try {
      if (isNew && getProvider(draft.name, { agentDir })) throw new Error("名称已存在，请进入已有项编辑");
      if (!draft.config.models.length) throw new Error("请先配置实际模型 ID");
      saveProvider({ name: draft.name, providerConfig: draft.config, isPrivate: draft.isPrivate, agentDir });
      ctx.ui.notify("已保存，重启 OMP 后加载配置", "info");
      return true;
    } catch (error) { ctx.ui.notify(`保存失败，未完成保存: ${error.message}`, "error"); }
  }
}
async function addDraft(ctx, agentDir, seed = {}) {
  const name = await inputField(ctx, "Provider 名称", seed.name || "例如 my-provider", value => {
    validName(value);
    if (getProvider(value, { agentDir })) throw new Error("名称已存在，请进入已有项编辑");
    return value;
  });
  if (name === undefined) return;
  const api = await chooseApi(ctx);
  if (!api) return;
  const baseUrl = await inputField(ctx, "Base URL", seed.baseUrl || "https://api.example.com/v1", validUrl);
  if (!baseUrl) return;
  const apiKey = await ctx.ui.input("API Key", "留空表示无 Key", { secret: true });
  if (apiKey === undefined) return;
  const isPrivate = await chooseScope(ctx);
  if (isPrivate === undefined) return;
  const draft = { name, isPrivate, config: { baseUrl, api, apiKey, models: [] }, verified: false };
  if (!await acquireDraftModels(ctx, draft, agentDir, seed.model ? [seed.model] : [])) return;
  await saveSummary(ctx, draft, agentDir, true);
}
async function editDraft(ctx, name, agentDir, supplied) {
  const provider = getProvider(name, { agentDir });
  if (!provider) return ctx.ui.notify(`Provider '${name}' not found`, "warning");
  const draft = supplied || fromProvider(provider);
  for (;;) {
    const field = await select(ctx, `EDIT // ${name}`, ["协议", "地址", "Key", "存储范围", "模型", "保存", "放弃"]);
    if (!field || field === "放弃") return;
    if (field === "协议") {
      const api = await chooseApi(ctx);
      if (api && api !== draft.config.api) {
        draft.config.api = api;
        draft.verified = false;
        draft.checks = new Map();
      }
    } else if (field === "地址") {
      const value = await inputField(ctx, `Base URL // ${draft.config.baseUrl}`, "留空保留现值", value => value ? validUrl(value) : draft.config.baseUrl);
      if (value && value !== draft.config.baseUrl) {
        draft.config.baseUrl = value;
        draft.verified = false;
        draft.checks = new Map();
      }
    } else if (field === "Key") {
      const operation = await select(ctx, "KEY // 凭据", ["保留", "替换", "清除"]);
      if (operation === "替换") {
        const value = await ctx.ui.input("API Key", "留空表示无 Key", { secret: true });
        if (value !== undefined && value !== draft.config.apiKey) {
          draft.config.apiKey = value;
          draft.verified = false;
          draft.checks = new Map();
        }
      } else if (operation === "清除") {
        if (draft.config.apiKey !== "") {
          draft.config.apiKey = "";
          draft.verified = false;
          draft.checks = new Map();
        }
      }
    } else if (field === "存储范围") {
      const scope = await chooseScope(ctx);
      if (scope !== undefined) draft.isPrivate = scope;
    } else if (field === "模型") await acquireDraftModels(ctx, draft, agentDir);
    else if (field === "保存" && await saveSummary(ctx, draft, agentDir, false)) return;
  }
}
async function deleteProvider(ctx, name, agentDir) {
  const provider = getProvider(name, { agentDir });
  if (!provider) return ctx.ui.notify(`Provider '${name}' not found`, "warning");
  const roles = rolesFor(name, agentDir);
  if (roles.length) {
    ctx.ui.notify(`${name} 绑定角色: ${roles.join(", ")}；请先通过 /role 改绑`, "warning"); return;
  }
  if (await ctx.ui.confirm(`删除 ${name}`, `名称: ${name}\n绑定角色: 无\n确认从两处配置删除？`)) {
    removeProvider({ name, agentDir });
    ctx.ui.notify(`已删除 ${name}，重启 OMP 后加载配置`, "info");
  }
}

export async function runProviderMenu(pi, ctx, { agentDir, action, name, draft } = {}) {
  if (!ctx.hasUI) return;
  if (action === "add" || action === "wizard") return addDraft(ctx, agentDir, draft);
  if (action === "edit") return editDraft(ctx, name, agentDir, draft);
  if (action === "test") {
    const provider = getProvider(name, { agentDir });
    return provider ? verifyDraft(ctx, fromProvider(provider)) : ctx.ui.notify(`Provider '${name}' not found`, "warning");
  }
  if (action === "rm" || action === "remove") return deleteProvider(ctx, name, agentDir);
  for (;;) {
    const providers = listProviders({ agentDir });
    const choice = await select(ctx, "PROVIDER // CONTROL", [
      { label: "+ 添加 Provider", description: "协议 / 地址 / Key / 模型" },
      { label: "≡ 管理已有 Provider", description: `${providers.length} 个 Provider` }, "× 退出",
    ]);
    if (!choice || choice === "× 退出") return;
    if (choice === "+ 添加 Provider") { await addDraft(ctx, agentDir); continue; }
    for (;;) {
      const current = listProviders({ agentDir });
      if (!current.length) { ctx.ui.notify("尚未配置 Provider", "info"); break; }
      const chosen = await select(ctx, "PROVIDER // LIST", current.map(p => ({ label: p.name,
        description: `${p.api} · ${p.isPrivate ? "PRIVATE" : "PUBLIC"} · ${p.models.length} models` })));
      if (!chosen) break;
      for (;;) {
        const provider = getProvider(chosen, { agentDir });
        if (!provider) break;
        const operation = await select(ctx, `PROVIDER // ${chosen}`, ["查看详情", "编辑配置", "验证连接", "删除", "返回"]);
        if (!operation || operation === "返回") break;
        if (operation === "查看详情") ctx.ui.notify(summary(fromProvider(provider), agentDir), "info");
        if (operation === "编辑配置") await editDraft(ctx, chosen, agentDir);
        if (operation === "验证连接") await verifyDraft(ctx, fromProvider(provider));
        if (operation === "删除") { await deleteProvider(ctx, chosen, agentDir); if (!getProvider(chosen, { agentDir })) break; }
      }
    }
  }
}

const ADD_USAGE = "Usage: /provider add <name> <url> [key] [--api <openai-completions|openai-responses|anthropic-messages>] [--model <id>] [--private|--public]";
function parseAdd(tokens) {
  const positional = []; const options = { isPrivate: true, api: "openai-completions" };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--private" || token === "--public") options.isPrivate = token === "--private";
    else if (token === "--api" || token === "--model") {
      const value = tokens[++i];
      if (!value || value.startsWith("--")) throw new Error(ADD_USAGE);
      options[token.slice(2)] = value;
    } else if (token.startsWith("--")) throw new Error(ADD_USAGE);
    else positional.push(token);
  }
  if (positional.length > 3) throw new Error(ADD_USAGE);
  return { ...options, name: positional[0], baseUrl: positional[1], apiKey: positional[2] || "" };
}
export function providerCompletions(prefix = "", agentDir) {
  const parts = prefix.split(/\s+/); const sub = parts[0].toLowerCase();
  if (parts.length === 1) return ["add", "wizard", "ls", "list", "edit", "test", "rm", "remove"]
    .filter(value => value.startsWith(sub)).map(value => ({ value, description: "Provider configuration" }));
  if (["edit", "test", "rm", "remove"].includes(sub) && parts.length === 2) {
    try { return listProviders({ agentDir }).filter(p => p.name.toLowerCase().startsWith(parts[1].toLowerCase()))
      .map(p => ({ value: prefix.slice(0, prefix.length - parts[1].length) + p.name, label: p.name, description: `${p.api} · ${p.isPrivate ? "PRIVATE" : "PUBLIC"}` })); }
    catch { return null; }
  }
  if (["add", "wizard"].includes(sub)) {
    const last = parts.at(-1);
    const values = parts.at(-2) === "--api" ? APIS : ["--api", "--model", "--private", "--public"];
    return values.filter(value => value.startsWith(last)).map(value => ({ value: prefix.slice(0, prefix.length - last.length) + value, label: value, description: "Provider option" }));
  }
  return null;
}
export async function handleProviderCommand(pi, ctx, args, agentDir) {
  try {
    const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length && ctx.hasUI) return await runProviderMenu(pi, ctx, { agentDir });
    const [sub = "ls", name] = tokens;
    if (sub === "ls" || sub === "list") {
      const providers = listProviders({ agentDir });
      ctx.ui.notify(providers.length ? `Providers:\n${providers.map(p => `${p.name} · ${p.api} · ${p.isPrivate ? "PRIVATE" : "PUBLIC"} · ${p.models.length} models [roles: ${rolesFor(p.name, agentDir).join(", ") || "none"}]`).join("\n")}` : "No providers configured in public or private stores.", "info");
      return;
    }
    if (["edit", "test", "rm", "remove"].includes(sub)) {
      if (!name || tokens.length !== 2) throw new Error(`Usage: /provider ${sub} <name>`);
      if (ctx.hasUI) return await runProviderMenu(pi, ctx, { agentDir, action: sub, name });
      if (sub === "edit" || sub === "test") throw new Error(`Usage: /provider ${sub} <name> (requires interactive UI)`);
      const roles = rolesFor(name, agentDir);
      if (roles.length) {
        ctx.ui.notify(`Provider '${name}' 绑定角色: ${roles.join(", ")}；请先通过 /role 改绑`, "warning");
        return;
      }
      ctx.ui.notify(removeProvider({ name, agentDir }) ? `Removed provider '${name}'` : `Provider '${name}' not found`, "info"); return;
    }
    if (sub === "add" || sub === "wizard") {
      const options = parseAdd(tokens.slice(1));
      if (ctx.hasUI && (!options.name || !options.baseUrl)) return await runProviderMenu(pi, ctx, { agentDir, action: "add", draft: options });
      if (!options.name || !options.baseUrl) throw new Error(ADD_USAGE);
      validName(options.name); options.baseUrl = validUrl(options.baseUrl);
      if (!APIS.includes(options.api)) throw new Error("Unknown API: " + options.api);
      if (options.api === "anthropic-messages") options.baseUrl = options.baseUrl.replace(/\/v1$/i, "");
      if (getProvider(options.name, { agentDir })) throw new Error("名称已存在，请进入已有项编辑");
      if (ctx.hasUI) {
        const draft = { name: options.name, isPrivate: options.isPrivate, verified: false,
          config: { api: options.api, baseUrl: options.baseUrl, apiKey: options.apiKey, models: [] } };
        if (!await acquireDraftModels(ctx, draft, agentDir, options.model ? [options.model] : [])) return;
        await saveSummary(ctx, draft, agentDir, true);
        return;
      }
      const result = await probeProvider({ ...options, testModelId: options.model, providerName: options.name });
      if (!result.ok && !options.model) throw new Error(result.error);
      const models = result.ok ? result.models : [inferModelCapabilities(options.model, options.name)];
      if (options.model && !models.some(model => model.id === options.model)) models.push(inferModelCapabilities(options.model, options.name));
      saveProvider({ name: options.name, providerConfig: { baseUrl: result.ok ? result.normalizedBaseUrl : options.baseUrl,
        api: options.api, apiKey: options.apiKey, models }, isPrivate: options.isPrivate, agentDir });
      ctx.ui.notify("已保存（未验证），重启 OMP 后加载配置", "info"); return;
    }
    throw new Error("Usage: /provider [ls|add|edit <name>|test <name>|rm <name>]");
  } catch (error) { ctx.ui.notify(`Provider command error: ${error.message}`, "error"); }
}
