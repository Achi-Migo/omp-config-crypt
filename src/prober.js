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
    /(thinking|reasoner|reasoning|deepseek-r1|\br1\b|\bo1\b|\bo3\b|-high\b|-thought\b)/i.test(id);

  // Vision / Multimodal detection
  const isVision =
    /(vision|\bvl\b|omni|\b4o\b|flash|gemini|claude|sonnet|opus|qwen-vl|glm-4v)/i.test(id);

  // Context window heuristics
  let contextWindow = 128000;
  if (/gemini-1\.5|gemini-2\.0|gemini-3\.0|gemini-3\.5|gemini-3\.8/i.test(id)) {
    contextWindow = /pro/i.test(id) ? 1000000 : 256000;
  } else if (/claude-3/i.test(id)) {
    contextWindow = 200000;
  } else if (/kimi|moonshot/i.test(id)) {
    contextWindow = 256000;
  } else if (/deepseek/i.test(id)) {
    contextWindow = 128000;
  } else if (/qwen/i.test(id)) {
    contextWindow = /32b|72b|128k/i.test(id) ? 131072 : 65536;
  } else if (/glm-4/i.test(id)) {
    contextWindow = 128000;
  }

  // Max output tokens heuristics
  let maxTokens = 32000;
  if (/claude-3-5|claude-3-7/i.test(id)) {
    maxTokens = 8192;
  } else if (/gpt-4o/i.test(id)) {
    maxTokens = 16384;
  } else if (/qwen/i.test(id)) {
    maxTokens = 8192;
  } else if (contextWindow <= 65536) {
    maxTokens = Math.min(maxTokens, 8192);
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

/**
 * Probe an endpoint to find the working baseUrl, API flavor, and available models.
 */
export async function probeProvider({
  baseUrl,
  apiKey,
  api = "openai-completions",
  testModelId,
  providerName = "",
  timeout = 10000,
}) {
  let cleanUrl = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!cleanUrl) {
    return { ok: false, error: "Missing baseUrl" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    if (api === "anthropic-messages") {
      // Probe Anthropic endpoint
      const res = await testAnthropic(cleanUrl, apiKey, controller.signal);
      clearTimeout(timer);
      if (res.ok) {
        const models = (res.models && res.models.length > 0)
          ? res.models.map((m) => inferModelCapabilities(m.id || m, providerName))
          : [inferModelCapabilities(testModelId || "claude-3-7-sonnet-20250219", providerName)];
        return {
          ok: true,
          normalizedBaseUrl: res.normalizedUrl,
          api: "anthropic-messages",
          models,
          probedVia: res.probedVia,
        };
      }
      return { ok: false, error: res.error || "Anthropic endpoint unreachable" };
    }

    // Default to openai-completions probe
    // 1. Try /models endpoints first (with and without /v1)
    const hasV1 = /\/v1$/i.test(cleanUrl);
    const candidateUrls = hasV1
      ? [cleanUrl, cleanUrl.replace(/\/v1$/i, "")]
      : [cleanUrl, `${cleanUrl}/v1`];

    for (const url of candidateUrls) {
      const modelsEndpoint = `${url}/models`;
      try {
        const res = await fetch(modelsEndpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (res.status === 200) {
          const json = await res.json();
          const rawList = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
          const filtered = filterChatModels(rawList);
          if (filtered.length > 0) {
            clearTimeout(timer);
            // In OMP, openai-completions appends /chat/completions.
            // If models endpoint was at ${url}/models, the baseUrl must be ${url}.
            return {
              ok: true,
              normalizedBaseUrl: url,
              api: "openai-completions",
              models: filtered.map((m) => inferModelCapabilities(m.id || m, providerName)),
              probedVia: "models_endpoint",
            };
          }
        }
      } catch {}
    }

    // 2. If /models failed or returned 404, probe chat/completions directly
    for (const url of candidateUrls) {
      const chatEndpoint = `${url}/chat/completions`;
      const modelToTest = testModelId || "test-probe";
      try {
        const res = await fetch(chatEndpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelToTest,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });

        // 200 = Success; 400/404 with error JSON about model not found also confirms the endpoint exists!
        if (res.status === 200 || res.status === 400 || res.status === 404) {
          let isJsonError = false;
          try {
            const errJson = await res.json();
            // If it returned structured error, the endpoint is indeed an active OpenAI API!
            if (errJson?.error) isJsonError = true;
          } catch {}

          if (res.status === 200 || isJsonError) {
            clearTimeout(timer);
            const models = testModelId
              ? [inferModelCapabilities(testModelId, providerName)]
              : [];
            return {
              ok: true,
              normalizedBaseUrl: url,
              api: "openai-completions",
              models,
              probedVia: "chat_completions",
            };
          }
        }
      } catch {}
    }

    clearTimeout(timer);
    return {
      ok: false,
      error: `Could not verify OpenAI endpoint at ${cleanUrl}. Both /models and /chat/completions failed.`,
    };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.name === "AbortError" ? "Probe timed out" : err.message };
  }
}

async function testAnthropic(cleanUrl, apiKey, signal) {
  const candidateUrls = [cleanUrl, `${cleanUrl}/v1`].filter((u, i, a) => a.indexOf(u) === i);
  for (const url of candidateUrls) {
    try {
      const endpoint = `${url}/messages`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal,
      });

      if (res.status === 200 || res.status === 400) {
        return { ok: true, normalizedUrl: url, probedVia: "messages_endpoint" };
      }
    } catch {}
  }
  return { ok: false, error: "Anthropic /messages endpoint failed" };
}
