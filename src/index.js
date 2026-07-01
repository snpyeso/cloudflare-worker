import { anthropicToGemini, geminiToAnthropic, streamAnthropicResponse } from './anthropicGeminiMapper.js';
import { getWorkerConfig, assertVertexConfigured, modelOverrides, resolveModel } from './config.js';
import { openAiToGemini, geminiToOpenAi, streamOpenAiResponse } from './openaiGeminiMapper.js';
import { CORS_HEADERS, withCors } from './sse.js';
import { VertexClient } from './vertexClient.js';
import { rememberToolCallSignature, THOUGHT_SIGNATURE_BYPASS } from './thoughtSignatures.js';
import { getLocale } from './locale.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = getWorkerConfig(env);
    const locale = getLocale(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return jsonResponse({
          ok: true,
          name: locale.name,
          description: locale.rootDescription,
          endpoints: locale.endpoints
        });
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        const configured = Boolean(config.vertex.projectId && config.vertex.clientEmail && config.vertex.privateKey);
        return jsonResponse({
          ok: true,
          provider: locale.health.provider,
          configured,
          status: configured ? locale.health.configured : locale.health.notConfigured,
          project_id: config.vertex.projectId || null,
          location: config.vertex.location,
          models: config.vertex.models
        });
      }

      if (url.pathname.startsWith('/v1/')) {
        assertApiToken(config, request, locale);
        assertVertexConfigured(config, locale);
      }

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: config.vertex.models.map((model) => ({
            id: model,
            object: 'model',
            created: 0,
            owned_by: 'vertex'
          }))
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return await handleOpenAiChat(request, config, locale);
      }

      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        return await handleAnthropicMessages(request, config, locale);
      }

      return jsonResponse({ error: { message: locale.errors.notFound, type: locale.errors.notFoundType } }, 404);
    } catch (error) {
      return errorResponse(error, url.pathname === '/v1/messages', locale);
    }
  }
};

async function handleOpenAiChat(request, config, locale) {
  const body = await readJson(request, locale);
  const model = resolveModel(config, body.model, locale);
  const vertexBody = openAiToGemini(body, modelOverrides(config, model));
  restoreMissingThoughtSignatures(vertexBody);

  const client = new VertexClient(config.vertex);
  const abortController = linkedAbortController(request, locale);

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

async function handleAnthropicMessages(request, config, locale) {
  const body = await readJson(request, locale);
  const model = resolveModel(config, body.model, locale);
  const vertexBody = anthropicToGemini(body, modelOverrides(config, model));
  restoreMissingThoughtSignatures(vertexBody);

  const client = new VertexClient(config.vertex);
  const abortController = linkedAbortController(request, locale);

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

function assertApiToken(config, request, locale) {
  const expected = config.apiToken;
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.replace(/^Bearer\s+/i, '').trim();
  const apiKey = request.headers.get('x-api-key') || '';
  const actual = bearer || apiKey.trim();

  if (!expected || actual !== expected) {
    const error = new Error(locale.errors.invalidApiKey);
    error.status = 401;
    throw error;
  }
}

async function readJson(request, locale) {
  try {
    return await request.json();
  } catch {
    const error = new Error(locale.errors.invalidJson);
    error.status = 400;
    throw error;
  }
}

function linkedAbortController(request, locale) {
  const controller = new AbortController();
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  setTimeout(() => controller.abort(new Error(locale.errors.timeout)), 180000);
  return controller;
}

function restoreMissingThoughtSignatures(vertexBody) {
  for (const content of vertexBody.contents || []) {
    for (const part of content.parts || []) {
      if (!part.functionCall || part.thoughtSignature) continue;
      part.thoughtSignature = THOUGHT_SIGNATURE_BYPASS;
      rememberToolCallSignature('', part.thoughtSignature, part.functionCall.name);
    }
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: withCors({
      'Content-Type': 'application/json; charset=utf-8'
    })
  });
}

function errorResponse(error, anthropic = false, locale) {
  const status = error.status || 500;
  const message = error.message || locale.errors.internalError;
  const payload = anthropic
    ? {
        type: 'error',
        error: {
          type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error',
          message
        }
      }
    : {
        error: {
          message,
          type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error',
          details: error.details
        }
      };

  return jsonResponse(payload, status);
}
