/**
 * Post-pull model availability healer.
 *
 * Scans every model reference in the restored config.yml (top-level modelRoles and
 * modelPresets.*.modelRoles), probes each referenced model with one short verified
 * generation, and offers an interactive replacement dialog for every reference that
 * fails. Replacements are written back surgically with updateRoleInYaml, preserving
 * comments and unrelated structure.
 */

import fs from "node:fs";
import path from "node:path";
import { testModelCandidates } from "./provider-models.js";
import { listProviders } from "./provider-store.js";
import { updateRoleInYaml } from "./role-manager.js";

const ROLE_KEYS = ["advisor", "commit", "default", "judge", "memory", "plan", "slow", "smol", "task", "tiny", "vision"];
const PRESET_KEYS = ["fallback", "primary", "default", "fast", "deep"];

// web/* refs point at web-search tool backends (web/tavily), not chat models.
const WEB_ROLE = "web";

const THINKING_SUFFIX = /:(auto|minimal|low|medium|high|max)$/;

function parseModelRef(ref) {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed || !trimmed.includes("/")) return null;
  const slash = trimmed.indexOf("/");
  const provider = trimmed.slice(0, slash);
  if (!provider) return null;
  let model = trimmed.slice(slash + 1);
  if (!model) return null;
  let thinking = null;
  const suffix = model.match(THINKING_SUFFIX);
  if (suffix) {
    thinking = suffix[1];
    model = model.slice(0, -suffix[0].length);
  }
  return { provider, model, thinking };
}

/**
 * Collect model references from a parsed config.yml document.
 * Returns [{ pointer, provider, model, thinking, ref }]; pointer uses the same
 * dot-path shape as role-manager roles ("modelRoles" or "modelPresets.<k>.modelRoles").
 */
export function collectModelRefs(configDoc) {
  const refs = [];
  const scanRoles = (roles, pointer) => {
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) return;
    for (const [role, ref] of Object.entries(roles)) {
      if (typeof ref !== "string" || role === WEB_ROLE) continue;
      const parsed = parseModelRef(ref);
      if (parsed) refs.push({ pointer: `${pointer}/${role}`, role, ...parsed, ref: ref.trim() });
    }
  };
  const topRoles = configDoc?.modelRoles;
  if (topRoles && typeof topRoles === "object" && !Array.isArray(topRoles)) {
    for (const [role, ref] of Object.entries(topRoles)) {
      if (typeof ref !== "string" || role === WEB_ROLE) continue;
      const parsed = parseModelRef(ref);
      if (parsed) refs.push({ pointer: `modelRoles/${role}`, role, ...parsed, ref: ref.trim() });
    }
  }
  const presets = configDoc?.modelPresets;
  if (presets && typeof presets === "object" && !Array.isArray(presets)) {
    for (const presetKey of Object.keys(presets)) {
      const preset = presets[presetKey];
      if (!preset || typeof preset !== "object" || Array.isArray(preset)) continue;
      scanRoles(preset.modelRoles, `modelPresets/${presetKey}/modelRoles`);
    }
  }
  return refs;
}

/**
 * Deduplicate refs by provider/model, probe each once with a short verified
 * generation (reuses testModelCandidates' two-worker pool), then annotate.
 * Returns [{ ...ref, ok, error, latencyMs }].
 */
export async function checkModelRefs({ refs, providers, signal, onResult }) {
  const providerMap = new Map();
  for (const p of providers) providerMap.set(p.name, p);

  const groups = new Map();
  for (const ref of refs) {
    const key = `${ref.provider}/${ref.model}`;
    if (!groups.has(key)) {
      const p = providerMap.get(ref.provider);
      groups.set(key, {
        key,
        ref,
        config: p ? { baseUrl: p.baseUrl, api: p.api, apiKey: p.apiKey } : null,
        results: null,
      });
    }
  }

  for (const group of groups.values()) {
    if (signal?.aborted) break;
    if (!group.config) {
      group.results = [{ id: group.key, ok: false, error: `provider '${group.ref.provider}' not configured`, latencyMs: 0 }];
      continue;
    }
    const { results } = await testModelCandidates({
      name: group.ref.provider,
      config: group.config,
      ids: [group.ref.model],
      signal,
    });
    group.results = results.length > 0 ? results : [{ id: group.key, ok: false, error: "probe cancelled", latencyMs: 0 }];
  }

  const resultMap = new Map();
  for (const group of groups.values()) resultMap.set(group.key, group.results[0]);

  return refs.map((ref) => {
    const result = resultMap.get(`${ref.provider}/${ref.model}`);
    return { ...ref, ok: result.ok, error: result.error || undefined, latencyMs: result.latencyMs || 0 };
  });
}

/**
 * Candidate replacements: all distinct provider/model pairs from the configured
 * provider stores, excluding the failed ref itself. Sorted with same-provider
 * candidates first.
 */
export function replacementCandidates({ failedRef, providers }) {
  const seen = new Set();
  const candidates = [];
  for (const p of providers) {
    for (const m of p.models || []) {
      if (!m?.id) continue;
      const key = `${p.name}/${m.id}`;
      if (key === `${failedRef.provider}/${failedRef.model}` || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        key,
        provider: p.name,
        model: m.id,
        baseUrl: p.baseUrl,
        api: p.api,
        apiKey: p.apiKey,
        sameProvider: p.name === failedRef.provider,
        isPrivate: Boolean(p.isPrivate),
        capabilities: m,
      });
    }
  }
  return candidates.sort((a, b) =>
    a.sameProvider === b.sameProvider ? a.key.localeCompare(b.key, "en", { numeric: true }) : a.sameProvider ? -1 : 1,
  );
}

/**
 * Probe the candidates until one verified generation succeeds (sequential, cheap first).
 * Returns the winning "provider/model" key or null when every candidate fails.
 */
export async function findWorkingReplacement({ candidates, signal }) {
  for (const candidate of candidates) {
    if (signal?.aborted) return null;
    const { results } = await testModelCandidates({
      name: candidate.provider,
      config: { baseUrl: candidate.baseUrl, api: candidate.api, apiKey: candidate.apiKey },
      ids: [candidate.model],
      signal,
    });
    if (results.some((r) => r.ok)) return candidate.key;
  }
  return null;
}

/**
 * Unified interactive repair flow over the checked refs. Groups failures by
 * provider/model: ONE dialog per distinct unavailable model, and the chosen
 * replacement is applied to EVERY reference of that model in one pass
 * (identical thinking suffixes share the decision).
 * Returns applied rewrites [{ pointer, role, from, to }] and skipped refs;
 * never throws on user abort.
 */
export async function healModelRefs({ ctx, checked, providers, configPath }) {
  const applied = [];
  const skipped = [];
  const failures = checked.filter((r) => !r.ok);
  if (failures.length === 0) return { applied, skipped };

  // Group by distinct unavailable provider/model (thinking suffix is preserved
  // per-ref at rewrite time, so grouping key is bare provider/model).
  const groups = new Map();
  for (const failed of failures) {
    const key = `${failed.provider}/${failed.model}`;
    if (!groups.has(key)) groups.set(key, { key, failed, refs: [] });
    groups.get(key).refs.push(failed);
  }

  ctx.ui.notify(
    `[pull] 发现 ${groups.size} 个不可用模型（${failures.length} 处引用），每个模型统一选择一次替代（每个候选 1 次短生成请求，可能产生费用；Esc 可跳过）`,
    "info",
  );

  const text = fs.readFileSync(configPath, "utf8");
  let updated = text;

  for (const { key, failed, refs } of groups.values()) {
    const candidates = replacementCandidates({ failedRef: failed, providers });
    if (candidates.length === 0) {
      for (const ref of refs) skipped.push({ ...ref, reason: "no replacement candidates configured" });
      continue;
    }

    const locations = [...new Set(refs.map((r) => r.pointer))].join(", ");
    const choice = await ctx.ui.select(
      `模型不可用: ${key} (${failed.error}) · ${refs.length} 处引用 [${locations}]`,
      ["保留不改", ...candidates.map((c) => c.key)],
      { outline: true, helpText: "↑↓ 选择 · Enter 确认 · Esc 保留原值 · 所选替代应用到全部引用" },
    );

    if (!choice || choice === "保留不改") {
      for (const ref of refs) skipped.push({ ...ref, reason: "user kept original" });
      continue;
    }

    const chosen = candidates.find((c) => c.key === choice);
    if (!chosen) {
      for (const ref of refs) skipped.push({ ...ref, reason: `unknown selection: ${choice}` });
      continue;
    }

    // Verify the chosen candidate once before rewriting (1 short generation).
    const { results } = await testModelCandidates({
      name: chosen.provider,
      config: { baseUrl: chosen.baseUrl, api: chosen.api, apiKey: chosen.apiKey },
      ids: [chosen.model],
    });
    if (!results.some((r) => r.ok)) {
      const detail = `selected ${chosen.key} failed verification: ${results[0]?.error || "unknown"}`;
      for (const ref of refs) skipped.push({ ...ref, reason: detail });
      continue;
    }

    // Apply to every reference of this model; group applied by target for summary.
    for (const ref of refs) {
      const nextRef = chosen.key + (ref.thinking ? `:${ref.thinking}` : "");
      updated = applyPointerRef(updated, ref.pointer, nextRef);
      applied.push({ pointer: ref.pointer, role: ref.role, from: ref.ref, to: nextRef });
    }
  }

  if (applied.length > 0) {
    fs.writeFileSync(configPath, updated, "utf8");
  }
  return { applied, skipped };
}

/**
 * Rewrite one model reference at `pointer` ("modelRoles/<role>" or
 * "modelPresets/<k>/modelRoles/<role>") in raw config.yml text.
 * Top-level roles reuse updateRoleInYaml; preset roles are rewritten with a
 * targeted line scan that preserves the rest of the document.
 */
export function applyPointerRef(yamlStr, pointer, modelRef) {
  const tokens = pointer.split("/").filter(Boolean);
  if (tokens[0] === "modelRoles" && tokens.length === 2) {
    return updateRoleInYaml(yamlStr, tokens[1], modelRef);
  }
  if (tokens[0] === "modelPresets" && tokens.length === 4 && tokens[2] === "modelRoles") {
    const [/*presets*/, presetKey, /*roles*/, role] = tokens;
    const lines = yamlStr.split("\n");
    let inPresets = false, inPreset = false, inRoles = false, depthRoles = -1, found = false;
    const out = lines.map((line) => {
      if (found) return line;
      const indent = line.search(/\S/);
      const trimmed = indent === -1 ? "" : line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      if (indent === 0) {
        inPresets = trimmed === "modelPresets:";
        inPreset = false; inRoles = false;
        return line;
      }
      if (inPresets && indent === 2) {
        inPreset = trimmed === `${presetKey}:`;
        inRoles = false;
        return line;
      }
      if (inPreset && indent === 4 && trimmed === "modelRoles:") {
        inRoles = true; depthRoles = indent;
        return line;
      }
      if (inRoles && indent > depthRoles) {
        const match = line.match(/^(\s*)([A-Za-z0-9_-]+):(.*)$/);
        if (match && match[2] === role) {
          found = true;
          return `${match[1]}${role}: ${modelRef}`;
        }
      } else if (inRoles && indent <= depthRoles) {
        inRoles = false;
      }
      return line;
    });
    if (!found) throw new Error(`pointer not found in config.yml: ${pointer}`);
    return out.join("\n");
  }
  throw new Error(`unsupported model role pointer: ${pointer}`);
}

/**
 * Entry point used by /config-pull after a successful (non-dry-run) restore.
 * Returns null when the host has no interactive UI or nothing failed.
 */
export async function runPullModelHeal(ctx, { root, notify } = {}) {
  if (typeof ctx?.ui?.select !== "function") return null;

  const configPath = fs.existsSync(path.join(root, "config.yml"))
    ? path.join(root, "config.yml")
    : path.join(root, "config.yaml");
  if (!fs.existsSync(configPath)) return null;

  let doc;
  try {
    const { parseYamlStrict } = await import("./sync-resources.js");
    doc = parseYamlStrict(fs.readFileSync(configPath, "utf8"), path.basename(configPath)).toJS();
  } catch {
    return null;
  }

  const refs = collectModelRefs(doc);
  if (refs.length === 0) return null;

  const providers = listProviders({ agentDir: root });
  const checked = await checkModelRefs({ refs, providers });
  const failureCount = checked.filter((r) => !r.ok).length;
  notify?.(
    failureCount === 0
      ? `[pull] 模型体检: ${refs.length} 个引用全部可用`
      : `[pull] 模型体检: ${checked.length - failureCount}/${checked.length} 可用, ${failureCount} 不可用`,
    "info",
  );
  if (failureCount === 0) return { applied: [], skipped: [], checked };

  const heal = await healModelRefs({ ctx, checked, providers, configPath });
  return { ...heal, checked };
}
