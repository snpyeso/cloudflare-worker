// src/schema.js
var ALLOWED_SCHEMA_KEYS = /* @__PURE__ */ new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "maxItems",
  "minItems",
  "properties",
  "propertyOrdering",
  "required",
  "anyOf",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "default",
  "example"
]);
function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  return sanitizeSchemaNode(schema);
}
function sanitizeSchemaNode(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaNode);
  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [propertyName, sanitizeSchemaNode(propertySchema)])
      );
      continue;
    }
    if (key === "items") {
      cleaned.items = sanitizeSchemaNode(value);
      continue;
    }
    if (key === "anyOf") {
      cleaned.anyOf = Array.isArray(value) ? value.map(sanitizeSchemaNode) : void 0;
      continue;
    }
    cleaned[key] = value;
  }
  if (!cleaned.type && cleaned.properties) {
    cleaned.type = "object";
  }
  return stripUndefined(cleaned);
}
function stripUndefined(value) {
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    if (value[key] === void 0) {
      delete value[key];
    } else {
      stripUndefined(value[key]);
    }
  }
  return value;
}

// src/encoding.js
function utf8ToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(String(value || "")));
}
function base64UrlToUtf8(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}
function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function base64UrlToBytes(value) {
  const base64 = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");
  return base64ToBytes(padded);
}
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 32768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
function pemToArrayBuffer(pem) {
  const base64 = String(pem || "").replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  return base64ToBytes(base64).buffer;
}
function normalizePrivateKey(value) {
  let key = value;
  if (key && typeof key === "object") {
    key = key.privateKey || key.private_key || "";
  }
  key = String(key || "").trim();
  if (key.startsWith("{") || key.startsWith('"')) {
    try {
      const parsed = JSON.parse(key);
      key = typeof parsed === "object" && parsed ? parsed.privateKey || parsed.private_key || "" : parsed;
    } catch {
    }
  }
  key = String(key || "").trim();
  if (key.startsWith('"') && key.endsWith('"') || key.startsWith("'") && key.endsWith("'")) {
    key = key.slice(1, -1).trim();
  }
  key = key.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n").replace(/\r\n?/g, "\n").trim();
  return normalizePemLineBreaks(key);
}
function normalizePemLineBreaks(key) {
  const match = key.match(/^(-----BEGIN [^-]+-----)\s*([A-Za-z0-9+/=\s]+?)\s*(-----END [^-]+-----)$/s);
  if (!match) return key;
  const [, header, body, footer] = match;
  const compactBody = body.replace(/\s+/g, "");
  const wrappedBody = compactBody.match(/.{1,64}/g)?.join("\n") || compactBody;
  return `${header}
${wrappedBody}
${footer}`;
}

// src/thoughtSignatures.js
var MAX_SIGNATURES = 1e3;
var SIGNATURE_MARKER = "_ts_";
var THOUGHT_SIGNATURE_BYPASS = "context_engineering_is_the_way_to_go";
var toolCallSignatures = /* @__PURE__ */ new Map();
var toolNameSignatures = /* @__PURE__ */ new Map();
function rememberToolCallSignature(id, signature, name = "") {
  if (!signature) return;
  if (id) {
    toolCallSignatures.set(String(id), signature);
  }
  if (name) {
    toolNameSignatures.set(String(name), signature);
  }
  while (toolCallSignatures.size > MAX_SIGNATURES) {
    const oldestKey = toolCallSignatures.keys().next().value;
    toolCallSignatures.delete(oldestKey);
  }
}
function getToolCallSignature(id) {
  return id ? toolCallSignatures.get(String(id)) || readSignatureFromId(id) : "";
}
function getToolNameSignature(name) {
  return name ? toolNameSignatures.get(String(name)) || "" : "";
}
function makeSignedToolId(prefix, index, signature) {
  const random = crypto.randomUUID().replaceAll("-", "");
  const base = `${prefix}_${index}_${random}`;
  return signature ? `${base}${SIGNATURE_MARKER}${utf8ToBase64Url(signature)}` : base;
}
function readSignatureFromId(id) {
  const value = String(id || "");
  const markerIndex = value.lastIndexOf(SIGNATURE_MARKER);
  if (markerIndex === -1) return "";
  try {
    return base64UrlToUtf8(value.slice(markerIndex + SIGNATURE_MARKER.length));
  } catch {
    return "";
  }
}

// src/mapperUtils.js
function functionCallPart(functionCall, thoughtSignature) {
  const part = { functionCall };
  part.thoughtSignature = thoughtSignature || THOUGHT_SIGNATURE_BYPASS;
  return part;
}
function functionCallPartsWithSignatures(parts) {
  let lastThoughtSignature = "";
  const functionCallParts = [];
  for (const part of parts || []) {
    if (part.thoughtSignature) {
      lastThoughtSignature = part.thoughtSignature;
    }
    if (part.functionCall) {
      functionCallParts.push({
        ...part,
        thoughtSignature: part.thoughtSignature || lastThoughtSignature
      });
    }
  }
  return functionCallParts;
}
function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
      mergeDeep(target[key], value);
    } else {
      target[key] = value;
    }
  }
}
function stripUndefined2(value) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (value[key] === void 0) {
      delete value[key];
    } else {
      stripUndefined2(value[key]);
    }
  }
}
function extractGeminiChunkParts(gemini, mapFinishReason2) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = (candidate.content?.parts || []).filter((part) => !part.thought);
  return {
    text: parts.map((part) => part.text).filter(Boolean).join(""),
    functionCalls: functionCallPartsWithSignatures(candidate.content?.parts || []).map((part) => ({
      ...part.functionCall,
      thoughtSignature: part.thoughtSignature,
      thought_signature: part.thoughtSignature
    })),
    finishReason: candidate.finishReason ? mapFinishReason2(candidate.finishReason) : null
  };
}

// src/sse.js
var encoder = new TextEncoder();
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,x-api-key,anthropic-version,anthropic-beta",
  "Access-Control-Max-Age": "86400"
};
function withCors(headers = {}) {
  return { ...CORS_HEADERS, ...headers };
}
function createSseResponse(handler, options = {}) {
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const write = (text) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          closed = true;
          options.onCancel?.();
          return false;
        }
      };
      const sse = {
        data(payload) {
          return write(`data: ${payload === null ? "[DONE]" : JSON.stringify(payload)}

`);
        },
        event(event, payload) {
          return write(`event: ${event}
data: ${JSON.stringify(payload)}

`);
        },
        comment(text) {
          return write(`: ${text}

`);
        },
        closed() {
          return closed;
        }
      };
      const heartbeat = setInterval(() => {
        sse.comment("keep-alive");
      }, 15e3);
      try {
        await handler(sse);
      } catch (error) {
        writeStreamError(sse, error, options.format);
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      options.onCancel?.();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: withCors({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    })
  });
}
function writeStreamError(sse, error, format) {
  const message = error?.message || String(error);
  if (format === "anthropic") {
    sse.event("error", {
      type: "error",
      error: {
        type: "api_error",
        message
      }
    });
    return;
  }
  sse.data({
    error: {
      message,
      type: "api_error",
      details: error?.details
    }
  });
  sse.data(null);
}

// src/anthropicGeminiMapper.js
function asGeminiPartsFromAnthropic(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part.type === "text") {
        if (part.text) parts.push({ text: part.text });
      } else if (part.type === "image") {
        if (part.source?.type === "base64") {
          parts.push({
            inlineData: {
              mimeType: part.source.media_type,
              data: part.source.data
            }
          });
        }
      }
    }
    return parts;
  }
  return [];
}
function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => part.text || "").filter(Boolean).join("\n");
}
function parseToolResultContent(content) {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return { content };
    }
  }
  if (Array.isArray(content)) {
    return {
      content: content.map((part) => part.type === "text" ? part.text : JSON.stringify(part)).join("\n")
    };
  }
  return content || {};
}
function readThoughtSignature(value) {
  return value?.thoughtSignature || value?.thought_signature || getToolCallSignature(value?.id) || getToolNameSignature(value?.name) || "";
}
function anthropicToGemini(request, modelOverrides2 = {}) {
  const contents = [];
  const toolUseNames = /* @__PURE__ */ new Map();
  for (const message of request.messages || []) {
    if (message.role === "assistant") {
      const parts2 = asGeminiPartsFromAnthropic(message.content);
      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item.type !== "tool_use") continue;
        toolUseNames.set(item.id, item.name);
        parts2.push(
          functionCallPart(
            {
              name: item.name,
              args: item.input || {}
            },
            readThoughtSignature(item)
          )
        );
      }
      if (parts2.length > 0) contents.push({ role: "model", parts: parts2 });
      continue;
    }
    const toolResults = Array.isArray(message.content) ? message.content.filter((part) => part.type === "tool_result") : [];
    if (toolResults.length > 0) {
      contents.push({
        role: "user",
        parts: toolResults.map((result) => ({
          functionResponse: {
            name: toolUseNames.get(result.tool_use_id) || result.name || result.tool_use_id || "tool_result",
            response: parseToolResultContent(result.content)
          }
        }))
      });
      continue;
    }
    const parts = asGeminiPartsFromAnthropic(message.content);
    if (parts.length > 0) contents.push({ role: "user", parts });
  }
  const body = {
    contents,
    generationConfig: {
      temperature: request.temperature,
      topP: request.top_p,
      maxOutputTokens: request.max_tokens,
      stopSequences: request.stop_sequences
    }
  };
  const systemText = textFromAnthropicContent(request.system);
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  const functionDeclarations = (request.tools || []).filter((tool) => tool.name).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: sanitizeGeminiSchema(tool.input_schema)
  }));
  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }];
  }
  if (request.tool_choice) {
    body.toolConfig = buildToolConfig(request.tool_choice, functionDeclarations);
  }
  mergeDeep(body, modelOverrides2);
  stripUndefined2(body);
  return body;
}
function buildToolConfig(toolChoice, functionDeclarations) {
  if (toolChoice.type === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice.type === "any") return { functionCallingConfig: { mode: "ANY" } };
  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.name]
      }
    };
  }
  if (functionDeclarations.length > 0) return { functionCallingConfig: { mode: "AUTO" } };
  return void 0;
}
function geminiToAnthropic(gemini, requestModel) {
  const candidate = gemini.candidates?.[0] || {};
  const rawParts = candidate.content?.parts || [];
  const parts = rawParts.filter((part) => !part.thought);
  const content = [];
  const signedFunctionCallParts = functionCallPartsWithSignatures(rawParts);
  for (const part of parts) {
    if (part.text) {
      content.push({ type: "text", text: part.text });
    }
    if (part.functionCall) {
      const signedPart = signedFunctionCallParts.shift() || part;
      const id = makeSignedToolId("toolu", content.length, signedPart.thoughtSignature);
      rememberToolCallSignature(id, signedPart.thoughtSignature, part.functionCall.name);
      content.push({
        type: "tool_use",
        id,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
        thought_signature: signedPart.thoughtSignature,
        thoughtSignature: signedPart.thoughtSignature
      });
    }
  }
  return {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: requestModel,
    content,
    stop_reason: content.some((part) => part.type === "tool_use") ? "tool_use" : mapStopReason(candidate.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: gemini.usageMetadata?.promptTokenCount || 0,
      output_tokens: gemini.usageMetadata?.candidatesTokenCount || 0
    }
  };
}
function geminiChunkParts(gemini) {
  return extractGeminiChunkParts(gemini, mapStopReason);
}
function mapStopReason(reason) {
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (reason === "SAFETY" || reason === "RECITATION") return "stop_sequence";
  return "end_turn";
}
function createAnthropicStreamStrategy() {
  let stopReason = "end_turn";
  return {
    didToolUse() {
      stopReason = "tool_use";
    },
    didFinish(reason) {
      if (stopReason !== "tool_use") stopReason = reason;
    },
    stopReason() {
      return stopReason;
    }
  };
}
function streamAnthropicResponse(model, stream, abortController) {
  return createSseResponse(async (sse) => {
    const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    const strategy = createAnthropicStreamStrategy();
    let contentIndex = 0;
    let textBlockOpen = false;
    sse.event("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
    for await (const geminiChunk of stream) {
      if (sse.closed()) break;
      const chunk = geminiChunkParts(geminiChunk);
      if (chunk.text) {
        if (!textBlockOpen) {
          sse.event("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" }
          });
          textBlockOpen = true;
        }
        sse.event("content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: { type: "text_delta", text: chunk.text }
        });
      }
      for (const call of chunk.functionCalls) {
        if (textBlockOpen) {
          sse.event("content_block_stop", { type: "content_block_stop", index: contentIndex });
          contentIndex += 1;
          textBlockOpen = false;
        }
        const toolUseId = makeSignedToolId("toolu", contentIndex, call.thoughtSignature);
        rememberToolCallSignature(toolUseId, call.thoughtSignature, call.name);
        sse.event("content_block_start", {
          type: "content_block_start",
          index: contentIndex,
          content_block: {
            type: "tool_use",
            id: toolUseId,
            name: call.name,
            input: {},
            thought_signature: call.thoughtSignature,
            thoughtSignature: call.thoughtSignature
          }
        });
        sse.event("content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args || {}) }
        });
        sse.event("content_block_stop", { type: "content_block_stop", index: contentIndex });
        contentIndex += 1;
        strategy.didToolUse();
      }
      if (chunk.finishReason) {
        strategy.didFinish(chunk.finishReason);
      }
    }
    if (textBlockOpen && !sse.closed()) {
      sse.event("content_block_stop", { type: "content_block_stop", index: contentIndex });
    }
    if (!sse.closed()) {
      sse.event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: strategy.stopReason(), stop_sequence: null },
        usage: { output_tokens: 0 }
      });
      sse.event("message_stop", { type: "message_stop" });
    }
  }, {
    format: "anthropic",
    onCancel: () => abortController?.abort()
  });
}

// src/config.js
var DEFAULT_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro-preview"];
function getWorkerConfig(env) {
  const serviceAccount = parseJson(env.VERTEX_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON || "") || {};
  const models = splitLines(env.VERTEX_MODELS || env.MODELS);
  const modelOverrides2 = parseJson(env.VERTEX_MODEL_OVERRIDES || env.POST_BODY_PARAMETER_OVERRIDES || "") || {};
  return {
    apiToken: String(env.API_TOKEN || "").trim(),
    vertex: {
      projectId: String(env.VERTEX_PROJECT_ID || env.PROJECT_ID || serviceAccount.project_id || "").trim(),
      location: String(env.VERTEX_LOCATION || env.LOCATION || "global").trim() || "global",
      clientEmail: String(env.VERTEX_CLIENT_EMAIL || env.CLIENT_EMAIL || serviceAccount.client_email || "").trim(),
      privateKey: normalizePrivateKey(env.VERTEX_PRIVATE_KEY || env.PRIVATE_KEY || serviceAccount.private_key || ""),
      models: models.length > 0 ? models : DEFAULT_MODELS,
      preferences: {
        post_body_parameter_overrides: modelOverrides2.post_body_parameter_overrides || modelOverrides2
      }
    },
    allowAnyVertexModel: truthy(env.ALLOW_ANY_VERTEX_MODEL)
  };
}
function assertVertexConfigured(config) {
  const { projectId, clientEmail, privateKey } = config.vertex;
  if (!projectId || !clientEmail || !privateKey) {
    const error = new Error("Vertex AI is not configured. Set VERTEX_SERVICE_ACCOUNT_JSON or VERTEX_PROJECT_ID, VERTEX_CLIENT_EMAIL, and VERTEX_PRIVATE_KEY.");
    error.status = 500;
    throw error;
  }
}
function resolveModel(config, requestedModel) {
  const model = String(requestedModel || "").trim();
  if (!model) return config.vertex.models[0];
  if (config.allowAnyVertexModel || config.vertex.models.includes(model)) return model;
  const error = new Error(`Model '${model}' is not configured. Set VERTEX_MODELS or enable ALLOW_ANY_VERTEX_MODEL.`);
  error.status = 400;
  throw error;
}
function modelOverrides(config, model) {
  return config.vertex.preferences?.post_body_parameter_overrides?.[model] || {};
}
function splitLines(value) {
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}
function parseJson(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

// src/openaiGeminiMapper.js
function asGeminiParts(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part.type === "text" || part.type === "input_text") {
        if (part.text) parts.push({ text: part.text });
      } else if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        if (url.startsWith("data:")) {
          const [header, base64] = url.split(",");
          const mimeType = header.split(":")[1].split(";")[0];
          parts.push({
            inlineData: {
              mimeType,
              data: base64
            }
          });
        }
      }
    }
    return parts;
  }
  return [];
}
function asTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "input_text") return part.text || "";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
function parseToolArguments(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return { value: args };
  }
}
function readThoughtSignature2(value) {
  return value?.extra_content?.google?.thought_signature || value?.extra_content?.google?.thoughtSignature || value?.thoughtSignature || value?.thought_signature || value?.function?.thoughtSignature || value?.function?.thought_signature || getToolCallSignature(value?.id) || getToolNameSignature(value?.function?.name) || "";
}
function openAiToGemini(request, modelOverrides2 = {}) {
  const systemTexts = [];
  const contents = [];
  const toolCallNames = /* @__PURE__ */ new Map();
  for (const message of request.messages || []) {
    if (message.role === "system") {
      const text = asTextContent(message.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (message.role === "assistant") {
      const parts2 = asGeminiParts(message.content);
      for (const toolCall of message.tool_calls || []) {
        if (toolCall.type !== "function") continue;
        if (toolCall.id) toolCallNames.set(toolCall.id, toolCall.function.name);
        parts2.push(
          functionCallPart(
            {
              name: toolCall.function.name,
              args: parseToolArguments(toolCall.function.arguments)
            },
            readThoughtSignature2(toolCall)
          )
        );
      }
      if (parts2.length > 0) {
        contents.push({ role: "model", parts: parts2 });
      }
      continue;
    }
    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.name || toolCallNames.get(message.tool_call_id) || message.tool_call_id || "tool_result",
              response: parseToolArguments(message.content)
            }
          }
        ]
      });
      continue;
    }
    const parts = asGeminiParts(message.content);
    if (parts.length > 0) {
      contents.push({ role: "user", parts });
    }
  }
  const body = {
    contents,
    generationConfig: {
      temperature: request.temperature,
      topP: request.top_p,
      maxOutputTokens: request.max_tokens,
      stopSequences: request.stop ? Array.isArray(request.stop) ? request.stop : [request.stop] : void 0
    }
  };
  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemTexts.join("\n\n") }] };
  }
  const functionDeclarations = (request.tools || []).filter((tool) => tool.type === "function" && tool.function?.name).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: sanitizeGeminiSchema(tool.function.parameters)
  }));
  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }];
  }
  if (request.tool_choice && request.tool_choice !== "auto") {
    body.toolConfig = buildToolConfig2(request.tool_choice, functionDeclarations);
  }
  mergeDeep(body, modelOverrides2);
  stripUndefined2(body);
  return body;
}
function buildToolConfig2(toolChoice, functionDeclarations) {
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  const name = toolChoice?.function?.name;
  if (name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [name]
      }
    };
  }
  if (functionDeclarations.length > 0) {
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  return void 0;
}
function geminiToOpenAi(gemini, requestModel) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  const visibleParts = parts.filter((part) => !part.thought);
  const text = visibleParts.map((part) => part.text).filter(Boolean).join("");
  const functionCallParts = functionCallPartsWithSignatures(parts);
  const hasToolCalls = functionCallParts.length > 0;
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: hasToolCalls ? functionCallParts.map((part, index) => openAiToolCall(part, index)) : void 0
        },
        finish_reason: hasToolCalls ? "tool_calls" : mapFinishReason(candidate.finishReason)
      }
    ],
    usage: {
      prompt_tokens: gemini.usageMetadata?.promptTokenCount || 0,
      completion_tokens: gemini.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: gemini.usageMetadata?.totalTokenCount || 0
    }
  };
}
function openAiToolCall(part, index) {
  const id = makeSignedToolId("call", index, part.thoughtSignature);
  rememberToolCallSignature(id, part.thoughtSignature, part.functionCall.name);
  return {
    id,
    type: "function",
    function: {
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args || {})
    },
    thought_signature: part.thoughtSignature,
    thoughtSignature: part.thoughtSignature,
    extra_content: {
      google: {
        thought_signature: part.thoughtSignature,
        thoughtSignature: part.thoughtSignature
      }
    }
  };
}
function geminiChunkParts2(gemini) {
  return extractGeminiChunkParts(gemini, mapFinishReason);
}
function mapFinishReason(reason) {
  if (!reason || reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  return "stop";
}
function createOpenAiStreamStrategy() {
  let toolCallIndex = 0;
  let sawToolCall = false;
  return {
    nextToolCall(call) {
      sawToolCall = true;
      const index = toolCallIndex;
      toolCallIndex += 1;
      return {
        index,
        toolCallId: makeSignedToolId("call", index, call.thoughtSignature)
      };
    },
    finishReason(reason) {
      return sawToolCall ? "tool_calls" : reason;
    }
  };
}
function streamOpenAiResponse(model, stream, abortController) {
  return createSseResponse(async (sse) => {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1e3);
    const strategy = createOpenAiStreamStrategy();
    let finished = false;
    sse.data({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    });
    for await (const geminiChunk of stream) {
      if (sse.closed()) break;
      const chunk = geminiChunkParts2(geminiChunk);
      if (chunk.text) {
        sse.data({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }]
        });
      }
      for (const call of chunk.functionCalls) {
        const { index, toolCallId } = strategy.nextToolCall(call);
        rememberToolCallSignature(toolCallId, call.thoughtSignature, call.name);
        sse.data({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: toolCallId,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: ""
                    },
                    thought_signature: call.thoughtSignature,
                    thoughtSignature: call.thoughtSignature,
                    extra_content: {
                      google: {
                        thought_signature: call.thoughtSignature,
                        thoughtSignature: call.thoughtSignature
                      }
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        });
        sse.data({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    function: {
                      arguments: JSON.stringify(call.args || {})
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        });
      }
      if (chunk.finishReason) {
        sse.data({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: strategy.finishReason(chunk.finishReason) }]
        });
        finished = true;
      }
    }
    if (!finished && !sse.closed()) {
      sse.data({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      });
    }
    if (!sse.closed()) {
      sse.data(null);
    }
  }, {
    format: "openai",
    onCancel: () => abortController?.abort()
  });
}

// src/vertexClient.js
var VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var DEFAULT_RETRY_ATTEMPTS = 3;
var DEFAULT_RETRY_DELAYS_MS = [1e3, 5e3, 15e3];
var RETRY_STATUS_CODES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var accessTokenCache = /* @__PURE__ */ new Map();
var privateKeyCache = /* @__PURE__ */ new Map();
var VertexClient = class {
  constructor(vertexConfig) {
    this.vertexConfig = vertexConfig;
  }
  async generateContent(model, body, options = {}) {
    const endpoint = this.buildEndpoint(model, "generateContent");
    const response = await this.fetchVertex(endpoint, body, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI request failed: ${friendlyVertexMessage(response.status, message)}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }
    return payload;
  }
  async *streamGenerateContent(model, body, options = {}) {
    const endpoint = `${this.buildEndpoint(model, "streamGenerateContent")}?alt=sse`;
    const response = await this.fetchVertex(endpoint, body, options);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI stream request failed: ${friendlyVertexMessage(response.status, message)}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }
    yield* parseSseStream(response.body);
  }
  async fetchVertex(endpoint, body, options = {}) {
    let lastResponse = null;
    let lastError = null;
    let signal = options.signal;
    let timeoutId;
    if (!signal) {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(new Error("Timeout reached (180s)")), 18e4);
    }
    for (let attempt = 0; attempt <= DEFAULT_RETRY_ATTEMPTS; attempt += 1) {
      let response;
      try {
        const token = await this.getAccessToken();
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          signal,
          body: JSON.stringify(body)
        });
      } catch (error) {
        if (signal?.aborted || attempt >= DEFAULT_RETRY_ATTEMPTS) {
          if (timeoutId) clearTimeout(timeoutId);
          throw lastError || error;
        }
        lastError = error;
        await sleep(retryDelayMs(null, attempt));
        continue;
      }
      if (!shouldRetry(response, attempt)) {
        if (timeoutId) clearTimeout(timeoutId);
        return response;
      }
      lastResponse = response;
      await response.body?.cancel?.().catch(() => {
      });
      await sleep(retryDelayMs(response, attempt));
    }
    if (timeoutId) clearTimeout(timeoutId);
    if (lastError) throw lastError;
    return lastResponse;
  }
  buildEndpoint(model, method) {
    const { projectId, location } = this.vertexConfig;
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    return `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${method}`;
  }
  async getAccessToken() {
    const now = Math.floor(Date.now() / 1e3);
    const cacheKey = `${this.vertexConfig.projectId}:${this.vertexConfig.clientEmail}`;
    const cached = accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt - 60 > now) {
      return cached.accessToken;
    }
    const assertion = await this.createJwtAssertion(now);
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error_description || payload.error || response.statusText;
      const error = new Error(`Google OAuth token request failed: ${message}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }
    accessTokenCache.set(cacheKey, {
      accessToken: payload.access_token,
      expiresAt: now + Number(payload.expires_in || 3600)
    });
    return payload.access_token;
  }
  async createJwtAssertion(now) {
    const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = utf8ToBase64Url(JSON.stringify({
      iss: this.vertexConfig.clientEmail,
      scope: VERTEX_SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now
    }));
    const unsigned = `${header}.${claim}`;
    let key;
    try {
      key = await importPrivateKey(this.vertexConfig.privateKey);
    } catch (error) {
      const wrapped = new Error("Private key could not be parsed. Set VERTEX_SERVICE_ACCOUNT_JSON or VERTEX_PRIVATE_KEY with the service account private_key value.");
      wrapped.status = 400;
      wrapped.details = { message: error.message };
      throw wrapped;
    }
    const signature = new Uint8Array(await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned)
    ));
    return `${unsigned}.${bytesToBase64Url(signature)}`;
  }
};
async function importPrivateKey(privateKey) {
  if (privateKeyCache.has(privateKey)) {
    return privateKeyCache.get(privateKey);
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  privateKeyCache.set(privateKey, key);
  return key;
}
function shouldRetry(response, attempt) {
  return attempt < DEFAULT_RETRY_ATTEMPTS && RETRY_STATUS_CODES.has(response.status);
}
function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return DEFAULT_RETRY_DELAYS_MS[Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length - 1)];
}
function friendlyVertexMessage(status, message) {
  if (status === 429) {
    return `${message} Retried automatically but Vertex AI quota/rate limit is still exhausted. Reduce request rate, switch model/location, or request a higher quota in Google Cloud.`;
  }
  return message;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function* parseSseStream(body) {
  const reader = body?.getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        yield JSON.parse(data);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  } finally {
    reader.releaseLock();
  }
}

// src/index.js
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = getWorkerConfig(env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return jsonResponse({
          ok: true,
          name: "vertex-api-cloudflare-worker",
          endpoints: ["/health", "/v1/models", "/v1/chat/completions", "/v1/messages"]
        });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          provider: "vertex",
          configured: Boolean(config.vertex.projectId && config.vertex.clientEmail && config.vertex.privateKey),
          project_id: config.vertex.projectId || null,
          location: config.vertex.location,
          models: config.vertex.models
        });
      }
      if (url.pathname.startsWith("/v1/")) {
        assertApiToken(config, request);
        assertVertexConfigured(config);
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return jsonResponse({
          object: "list",
          data: config.vertex.models.map((model) => ({
            id: model,
            object: "model",
            created: 0,
            owned_by: "vertex"
          }))
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await handleOpenAiChat(request, config);
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return await handleAnthropicMessages(request, config);
      }
      return jsonResponse({ error: { message: "Not found", type: "not_found_error" } }, 404);
    } catch (error) {
      return errorResponse(error, url.pathname === "/v1/messages");
    }
  }
};
async function handleOpenAiChat(request, config) {
  const body = await readJson(request);
  const model = resolveModel(config, body.model);
  const vertexBody = openAiToGemini(body, modelOverrides(config, model));
  restoreMissingThoughtSignatures(vertexBody);
  const client = new VertexClient(config.vertex);
  const abortController = linkedAbortController(request);
  if (body.stream) {
    return streamOpenAiResponse(
      model,
      client.streamGenerateContent(model, vertexBody, { signal: abortController.signal }),
      abortController
    );
  }
  const vertexResponse = await client.generateContent(model, vertexBody, { signal: abortController.signal });
  return jsonResponse(geminiToOpenAi(vertexResponse, model));
}
async function handleAnthropicMessages(request, config) {
  const body = await readJson(request);
  const model = resolveModel(config, body.model);
  const vertexBody = anthropicToGemini(body, modelOverrides(config, model));
  restoreMissingThoughtSignatures(vertexBody);
  const client = new VertexClient(config.vertex);
  const abortController = linkedAbortController(request);
  if (body.stream) {
    return streamAnthropicResponse(
      model,
      client.streamGenerateContent(model, vertexBody, { signal: abortController.signal }),
      abortController
    );
  }
  const vertexResponse = await client.generateContent(model, vertexBody, { signal: abortController.signal });
  return jsonResponse(geminiToAnthropic(vertexResponse, model));
}
function assertApiToken(config, request) {
  const expected = config.apiToken;
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  const apiKey = request.headers.get("x-api-key") || "";
  const actual = bearer || apiKey.trim();
  if (!expected || actual !== expected) {
    const error = new Error("Invalid API key");
    error.status = 401;
    throw error;
  }
}
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error("Invalid JSON request body");
    error.status = 400;
    throw error;
  }
}
function linkedAbortController(request) {
  const controller = new AbortController();
  request.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  setTimeout(() => controller.abort(new Error("Timeout reached (180s)")), 18e4);
  return controller;
}
function restoreMissingThoughtSignatures(vertexBody) {
  for (const content of vertexBody.contents || []) {
    for (const part of content.parts || []) {
      if (!part.functionCall || part.thoughtSignature) continue;
      part.thoughtSignature = THOUGHT_SIGNATURE_BYPASS;
      rememberToolCallSignature("", part.thoughtSignature, part.functionCall.name);
    }
  }
}
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: withCors({
      "Content-Type": "application/json; charset=utf-8"
    })
  });
}
function errorResponse(error, anthropic = false) {
  const status = error.status || 500;
  const payload = anthropic ? {
    type: "error",
    error: {
      type: status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error",
      message: error.message || "Internal server error"
    }
  } : {
    error: {
      message: error.message || "Internal server error",
      type: status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error",
      details: error.details
    }
  };
  return jsonResponse(payload, status);
}
export {
  index_default as default
};
