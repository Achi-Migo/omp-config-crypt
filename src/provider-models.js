import { probeProvider, filterChatModels, inferModelCapabilities } from "./prober.js";
import { listProviders } from "./provider-store.js";

const POPULAR = {
  "openai-completions": ["gpt-4.1-mini", "gpt-4o-mini", "gpt-5.4", "deepseek-v4-flash", "deepseek-v4-pro", "gemini-2.5-flash", "kimi-k2.5", "glm-5"],
  "openai-responses": ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-4.1-mini"],
  "anthropic-messages": ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
};
const unique = ids => [...new Set(ids.filter(id => typeof id === "string").map(id => id.trim()).filter(Boolean))];
const sorted = ids => unique(ids).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
function address(value, api) {
  try {
    if (typeof value !== "string") return;
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    let normalized = url.href.replace(/\/+$/, "");
    if (api === "anthropic-messages") normalized = normalized.replace(/\/v1$/i, "");
    return { normalized, hostname: url.hostname.toLowerCase() };
  } catch { return; }
}

/** Local hints only. Availability is established exclusively by target generation requests. */
export function recommendModelIds({ api, baseUrl, name = "", configuredProviders = [], catalog = [] }) {
  const target = address(baseUrl, api);
  const groups = [[], [], []];
  if (target) {
    for (const provider of configuredProviders) {
      if (provider?.api !== api || address(provider.baseUrl, api)?.normalized !== target.normalized) continue;
      groups[0].push(...filterChatModels(Array.isArray(provider.models) ? provider.models : []).map(m => typeof m === "string" ? m : m.id));
    }
    for (const model of catalog) {
      if (!model || model.api !== api || (model.kind && model.kind !== "chat") ||
          (model.input !== undefined && (!Array.isArray(model.input) || !model.input.includes("text")))) continue;
      const id = model.requestModelId || model.id;
      if (typeof id !== "string" || !filterChatModels([id]).length) continue;
      const url = address(model.baseUrl, api);
      if (!url) continue;
      if (url.hostname === target.hostname) groups[1].push(id);
      const provider = typeof model.provider === "string" ? model.provider.toLowerCase() : "";
      if (provider && (provider === name.toLowerCase() || target.hostname.split(".").includes(provider))) groups[2].push(id);
    }
  }
  return { intelligent: unique(groups.flatMap(sorted)).slice(0, 12), popular: [...(POPULAR[api] || [])] };
}

/** Two workers, stable output order, no retries, and no invented unstarted results. */
export async function testModelCandidates({ name, config, ids, signal, onResult }) {
  const candidates = unique(ids), results = new Array(candidates.length);
  let cursor = 0;
  const worker = async () => {
    while (!signal?.aborted && cursor < candidates.length) {
      const index = cursor++, id = candidates[index];
      const probe = await probeProvider({ ...config, providerName: name, testModelId: id, verify: true, timeout: 10000, signal });
      const result = { id, ok: probe.ok && probe.verified === true, latencyMs: probe.latencyMs ?? 0,
        ...(!probe.ok || probe.verified !== true ? { error: probe.error || "Generation not verified" } : {}) };
      results[index] = result;
      onResult?.(result);
    }
  };
  await Promise.all([worker(), worker()]);
  return { results: results.filter(Boolean), cancelled: Boolean(signal?.aborted) };
}

async function withProgress(ctx, { title, run, onProgress }) {
  const batch = new AbortController(), dialog = new AbortController();
  let completed = false, dialogError;
  ctx.ui.setWidget("provider-model-check", [title]);
  const selection = Promise.resolve().then(() => ctx.ui.select(title, ["取消测试"], {
    signal: dialog.signal, outline: true, helpText: "Esc 取消",
  })).then(() => { if (!completed) batch.abort(); }, error => {
    if (!completed) { dialogError = error; batch.abort(); }
  });
  try {
    const result = await run(batch.signal, lines => {
      ctx.ui.setWidget("provider-model-check", lines);
      onProgress?.(lines);
    });
    if (dialogError) throw dialogError;
    return result;
  } finally {
    completed = true;
    dialog.abort();
    await selection;
    ctx.ui.setWidget("provider-model-check", undefined);
  }
}

export async function runModelChecks(ctx, { name, config, ids }) {
  const candidates = unique(ids);
  ctx.ui.notify(`将测试 ${candidates.length} 个候选，最多同时 2 个短生成请求，可能产生费用；Esc 可取消`, "info");
  let completed = 0;
  return withProgress(ctx, { title: `测试模型 0/${candidates.length}`, run: (signal, update) =>
    testModelCandidates({ name, config, ids: candidates, signal, onResult: result => {
      completed++;
      update([`测试模型 ${completed}/${candidates.length}`, `${result.id} · ${result.ok ? "可用" : result.error} · ${result.latencyMs} ms`]);
    } }) });
}

const SOURCE_NAMES = ["接口", "智能", "主流", "手动"];
const dialogSelect = (ctx, title, options) => ctx.ui.select(title, options, { outline: true, helpText: "↑↓ 选择 · Enter 确认 · Esc 返回" });
const parseIds = value => unique(value.split(/[,\n\r]+/));

async function showFailures(ctx, cache) {
  const failed = [...cache.values()].filter(result => !result.ok);
  let page = 0;
  for (;;) {
    const rows = failed.slice(page * 10, page * 10 + 10).map(result =>
      `${result.id} · ${result.error} · ${result.latencyMs} ms`);
    const choice = await dialogSelect(ctx, `失败详情 · ${page + 1}/${Math.ceil(failed.length / 10)}`, [
      ...rows, ...(page ? ["上一页"] : []), ...((page + 1) * 10 < failed.length ? ["下一页"] : []), "返回",
    ]);
    if (!choice || choice === "返回") return;
    if (choice === "上一页") page--;
    if (choice === "下一页") page++;
  }
}

/** Acquire a verified subset without mutating config, the registry, or either store. */
export async function acquireProviderModels(ctx, { name, config, agentDir, seedIds = [] }) {
  if (typeof ctx.ui.askDialog !== "function") {
    ctx.ui.notify("当前宿主不支持空格多选，请升级 OMP", "error");
    return;
  }
  const working = { ...config }, existing = new Map((config.models || []).map(model => [model.id, model]));
  if (working.api === "anthropic-messages") working.baseUrl = working.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  let configuredProviders;
  try { configuredProviders = listProviders({ agentDir }); }
  catch (error) { ctx.ui.notify(`模型配置读取失败: ${error.message}`, "error"); return; }
  let catalog = [];
  try {
    if (typeof ctx.modelRegistry?.getAll !== "function") throw new Error("Registry unavailable");
    catalog = ctx.modelRegistry.getAll("chat");
    if (!Array.isArray(catalog)) throw new Error("Invalid registry");
  } catch { catalog = []; ctx.ui.notify("本机模型目录不可用", "warning"); }
  const cache = new Map(), sources = new Map(), stageIds = [[], [], [], []];
  let stage = 0, mode = "stage", retry = false;
  const available = () => [...sources.keys()].filter(id => cache.get(id)?.ok);
  const check = async (ids, source) => {
    ids = unique(ids);
    for (const id of ids) if (!sources.has(id)) sources.set(id, SOURCE_NAMES[source]);
    const pending = ids.filter(id => !cache.has(id));
    if (pending.length) {
      const batch = await runModelChecks(ctx, { name, config: working, ids: pending });
      for (const result of batch.results) cache.set(result.id, result);
      if (batch.cancelled) return false;
    }
    return true;
  };
  const manual = async () => {
    for (;;) {
      const value = await ctx.ui.input("模型 ID（逗号或换行分隔）", "输入实际模型 ID");
      if (value === undefined) return;
      const ids = parseIds(value);
      if (ids.length) return ids;
      ctx.ui.notify("至少输入一个实际模型 ID", "error");
    }
  };
  for (;;) {
    if (mode === "stage") {
      const before = new Set(available());
      let ids;
      if (stage === 0) {
        const result = await withProgress(ctx, { title: "查询模型接口", run: signal =>
          probeProvider({ ...working, providerName: name, verify: false, signal }) });
        if (result.cancelled) return;
        if (result.ok) working.baseUrl = result.normalizedBaseUrl;
        else ctx.ui.notify(`模型接口不可用: ${result.error}`, "warning");
        ids = unique([...seedIds, ...(result.ok ? result.models.map(model => model.id) : []), ...(retry ? stageIds[0] : [])]);
      } else if (stage < 3) {
        ids = retry ? stageIds[stage].filter(id => !cache.get(id)?.ok) :
          recommendModelIds({ ...working, name, configuredProviders, catalog })[stage === 1 ? "intelligent" : "popular"];
      } else {
        ids = await manual();
        if (!ids) { mode = "menu"; continue; }
      }
      stageIds[stage] = unique([...stageIds[stage], ...ids]);
      if (retry) for (const id of ids) if (!cache.get(id)?.ok) cache.delete(id);
      retry = false;
      if (!await check(ids, stage)) return;
      if (ids.some(id => cache.get(id)?.ok && !before.has(id))) { mode = "select"; continue; }
      ctx.ui.notify(stage === 3 ? "没有可用模型，不能保存" : `${SOURCE_NAMES[stage]}候选没有可用模型`, "warning");
      if (stage < 3) { stage++; continue; }
      mode = "menu";
    }
    if (mode === "select") {
      const labels = new Map(available().map(id => [id, id]));
      const result = await ctx.ui.askDialog([{
        id: "provider-models", header: "MODELS", question: "选择已验证模型 · 空格勾选 · Enter 确认 · Esc 返回", multi: true,
        options: [...labels.keys()].map(id => ({ label: id,
          description: `可用 · ${cache.get(id).latencyMs} ms · 来源: ${sources.get(id)}` })),
      }]);
      if (!result || result.kind !== "submit") { mode = "menu"; continue; }
      const answer = result.results?.find(item => item.id === "provider-models");
      if (typeof answer?.customInput === "string" && answer.customInput.trim()) {
        const ids = parseIds(answer.customInput);
        stageIds[3] = unique([...stageIds[3], ...ids]);
        if (!await check(ids, 3)) return;
        ctx.ui.notify("新增候选已测试，请重新勾选需保存的模型", "info");
        continue;
      }
      const selected = answer?.selectedOptions;
      if (!Array.isArray(selected) || selected.some(label => !labels.has(label))) {
        ctx.ui.notify("所选模型未通过验证", "error"); continue;
      }
      if (!selected.length) { ctx.ui.notify("至少选择一个已验证模型", "error"); continue; }
      const ids = unique(selected.map(label => labels.get(label)));
      return { models: ids.map(id => existing.get(id) || inferModelCapabilities(id, name)), baseUrl: working.baseUrl,
        checks: new Map(ids.map(id => [id, { ok: true, latencyMs: cache.get(id).latencyMs }])) };
    }
    if (mode === "menu") {
      const choice = await dialogSelect(ctx, `MODELS // ${SOURCE_NAMES[stage]}`, [
        ...(available().length ? ["多选可用模型"] : []), ...(stage < 3 ? ["继续下一来源"] : []),
        "手动输入模型 ID", ...([...cache.values()].some(result => !result.ok) ? ["查看失败详情"] : []), "重试本阶段", "返回",
      ]);
      if (!choice || choice === "返回") return;
      if (choice === "多选可用模型") mode = "select";
      else if (choice === "查看失败详情") await showFailures(ctx, cache);
      else if (choice === "继续下一来源") { stage++; mode = "stage"; }
      else if (choice === "手动输入模型 ID") { stage = 3; mode = "stage"; }
      else if (choice === "重试本阶段") { retry = true; mode = "stage"; }
    }
  }
}
