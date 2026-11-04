/**
 * Provider & Model Auto-Probing and Capability Discovery Engine
 */

const NON_CHAT_PATTERNS = [
  /embed/i,
  /rerank/i,
  /tts/i,
  /whisper/i,
  /audio/i,
  /voice/i,
  /moderation/i,
  /dall-e/i,
  /flux/i,
  /midjourney/i,
  /stable-diffusion/i,
  /upscale/i,
  /realtime/i,
  /sdxl/i,
  /imagen/i,
  /ideogram/i,
  /kolors/i,
  /sora/i,
  /kling/i,
  /cogvideo/i,
  /runway/i,
  /luma/i,
  /pika/i,
  /vidu/i,
  /wanx/i,
  /(?:^|[-_./])(?:image|video|t2i|t2v|i2v)(?:[-_./]|$)/i,
];

/**
 * Filter out non-conversational models from raw provider catalog.
 */
export function filterChatModels(rawModels) {
  if (!Array.isArray(rawModels)) return [];
  return rawModels.filter((m) => {
    const id = typeof m === "string" ? m : m?.id;
    if (!id || typeof id !== "string") return false;
    return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(id));
  });
}

/**
 * Infer model capabilities, context window, max tokens, modalities and reasoning flags.
 */
export function inferModelCapabilities(modelId, providerHint = "") {
  const id = modelId.toLowerCase();

  // Reasoning detection
  const isReasoning =
    /(thinking|reasoner|reasoning|deepseek-r1|\br1\b|\bo1\b|\bo3\b|-high\b|-thought\b|sol|terra)/i.test(id);

  // Vision / Multimodal detection
  const isVision =
    /(vision|\bvl\b|omni|\b4o\b|flash|gemini|claude|sonnet|opus|qwen-vl|glm-4v)/i.test(id);

  // Context window heuristics (默认 256K 兜底)
  let contextWindow = 256000;
  if (/gemini.*pro/i.test(id)) {
    contextWindow = 2000000;
  } else if (/gemini/i.test(id)) {
    contextWindow = 1000000;
  } else if (/deepseek/i.test(id)) {
    contextWindow = 1048576;
  } else if (/kimi|moonshot/i.test(id)) {
    contextWindow = 512000;
  } else if (/claude/i.test(id)) {
    contextWindow = 200000;
  } else if (/(gpt-6|gpt-5\.[0-9]).*(sol|terra|astra)/i.test(id)) {
    contextWindow = 256000;
  } else if (/qwen/i.test(id)) {
    contextWindow = /32b|72b|128k/i.test(id) ? 131072 : 65536;
  } else if (/glm-5/i.test(id)) {
    contextWindow = 1048576;
  }

  // Max output tokens heuristics
  let maxTokens = 65536;
  if (/(sol|terra)/i.test(id)) {
    maxTokens = 384000;
  } else if (/claude/i.test(id)) {
    maxTokens = 64000;
  } else if (/deepseek/i.test(id)) {
    maxTokens = 65536;
  } else if (/kimi|moonshot/i.test(id)) {
    maxTokens = 32000;
  }

  // Formatting display name
  const name = `${modelId}${providerHint ? ` (${providerHint})` : ""}`;

  const spec = {
    id: modelId,
    name,
    input: isVision ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
  };

  if (isReasoning) {
    spec.reasoning = true;
  }

  // Compat flags for quirky providers
  if (/kimi|moonshot/i.test(id) || /kimi/i.test(providerHint)) {
    spec.compat = {
      supportsForcedToolChoice: false,
    };
  }

  return spec;
}

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"];

function safeError(value, apiKey) {
  let text = String(value || "Invalid upstream response");
  if (apiKey) text = text.split(apiKey).join("[redacted]");
  return text.replace(/Bearer\s+[^\s"',}]+/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 400);
}

function jsonText(json, api) {
  if (api === "openai-completions") {
    return json?.choices?.some(choice => choice.finish_reason != null &&
      typeof choice.message?.content === "string" && choice.message.content.trim());
  }
  if (api === "openai-responses") {
    return json?.status === "completed" && (typeof json.output_text === "string" && json.output_text.trim() ||
      json.output?.some(item => item.content?.some(part => part.type === "output_text" && typeof part.text === "string" && part.text.trim())));
  }
  return json?.type === "message" && json.stop_reason != null &&
    json.content?.some(part => part.type === "text" && typeof part.text === "string" && part.text.trim());
}

async function readGeneration(response, api) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const json = await response.json();
    if (json?.error || !jsonText(json, api)) throw new Error("Generation did not complete with text output");
    return;
  }
  if (!response.body) throw new Error("Empty response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "", finished = false, complete = false;
  const consume = frame => {
    const lines = frame.split(/\r?\n/);
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      if (api === "openai-completions" && finished) complete = true;
      return;
    }
    const json = JSON.parse(data);
    const type = json.type || event;
    if (json.error || ["error", "response.failed", "response.incomplete"].includes(type)) {
      throw new Error(JSON.stringify(json.error || json));
    }
    if (api === "openai-completions") {
      // Validate the primary choice, never combine output and termination from different choices.
      const choice = json.choices?.find(item => item.index === undefined || item.index === 0);
      if (typeof choice?.delta?.content === "string") text += choice.delta.content;
      if (choice?.finish_reason != null) finished = true;
    } else if (api === "openai-responses") {
      if (type === "response.output_text.delta" && typeof json.delta === "string") text += json.delta;
      if (type === "response.completed") {
        if (json.response?.status && json.response.status !== "completed") throw new Error("Response not completed");
        if (json.response?.error) throw new Error(JSON.stringify(json.response.error));
        if (jsonText(json.response, api)) text += json.response.output_text || json.response.output
          ?.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join("") || "";
        complete = true;
      }
    } else {
      if (type === "content_block_start" && json.content_block?.type === "text") text += json.content_block.text || "";
      if (type === "content_block_delta" && json.delta?.type === "text_delta") text += json.delta.text || "";
      if (type === "message_stop") complete = true;
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (complete) {
        if (!text.trim()) throw new Error("Generation completed without text output");
        return;
      }
      if (chunk.done) throw new Error("Empty or truncated generation stream");
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

/** Discover model catalogs, or verify exactly one explicitly selected generation protocol. */
export async function probeProvider({
  baseUrl, apiKey, api = "openai-completions", testModelId,
  providerName = "", timeout = 10000, verify = false, signal,
}) {
  const early = error => ({ ok: false, error, ...(verify ? { latencyMs: 0 } : {}) });
  if (signal?.aborted) return { ...early("Probe cancelled"), cancelled: true, latencyMs: 0 };
  if (!APIS.includes(api)) return early("Unknown API: " + safeError(api, apiKey));
  if (verify && !testModelId?.trim()) return early("Generation verification requires testModelId");
  const cleanUrl = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!cleanUrl) return early("Missing baseUrl");
  const anthropic = api === "anthropic-messages";
  const normalized = anthropic ? cleanUrl.replace(/\/v1$/i, "") : cleanUrl;
  const controller = new AbortController();
  let externallyCancelled = false, started;
  const cancel = () => { externallyCancelled = true; controller.abort(); };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  const timing = () => verify ? { latencyMs: started === undefined ? 0 : Math.max(1, Math.round(performance.now() - started)) } : {};
  let response;
  const headers = { Accept: "application/json" };
  if (anthropic) {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    if (verify) {
      const endpoint = anthropic ? `${normalized}/v1/messages` : `${normalized}/${api === "openai-responses" ? "responses" : "chat/completions"}`;
      const body = api === "openai-responses"
        ? { model: testModelId, input: "Reply OK", max_output_tokens: 64, store: false, stream: true }
        : { model: testModelId, messages: [{ role: "user", content: "Reply OK" }],
            ...(anthropic ? { max_tokens: 64 } : { max_completion_tokens: 64 }), stream: true };
      if (signal?.aborted) cancel();
      if (controller.signal.aborted) throw new Error("Probe cancelled");
      started = performance.now();
      response = await fetch(endpoint, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await readErrorBody(response)}`);
      await readGeneration(response, api);
      return { ok: true, normalizedBaseUrl: normalized, api,
        models: [inferModelCapabilities(testModelId, providerName)], probedVia: api, verified: true, ...timing() };
    }
    const candidates = anthropic ? [normalized] : /\/v1$/i.test(cleanUrl)
      ? [cleanUrl, cleanUrl.replace(/\/v1$/i, "")] : [cleanUrl, `${cleanUrl}/v1`];
    let lastError = "No conversational models in catalog";
    for (const candidate of [...new Set(candidates)]) {
      try {
        response = await fetch(`${candidate}${anthropic ? "/v1" : ""}/models`, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await readErrorBody(response)}`);
        const json = await response.json();
        const models = filterChatModels(Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []);
        if (!models.length) throw new Error("No conversational models in catalog");
        return { ok: true, normalizedBaseUrl: candidate, api,
          models: models.map(m => inferModelCapabilities(m.id || m, providerName)), probedVia: "models_endpoint", verified: false };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = safeError(error.message, apiKey);
      } finally {
        try { await response?.body?.cancel(); } catch {}
        response = undefined;
      }
    }
    return { ok: false, error: lastError };
  } catch (error) {
    return { ok: false, error: externallyCancelled ? "Probe cancelled" : controller.signal.aborted ? "Probe timed out" : safeError(error.message, apiKey),
      ...(externallyCancelled ? { cancelled: true } : {}), ...timing() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    try { await response?.body?.cancel(); } catch {}
  }
}

async function readErrorBody(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 2048) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text.slice(0, 2048);
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}
