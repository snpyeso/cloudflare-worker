import { anthropicToGemini, geminiToAnthropic, streamAnthropicResponse } from './anthropicGeminiMapper.js';
import { getWorkerConfig, assertVertexConfigured, modelOverrides, resolveModel } from './config.js';
import { openAiToGemini, geminiToOpenAi, streamOpenAiResponse } from './openaiGeminiMapper.js';
import { CORS_HEADERS, withCors } from './sse.js';
import { VertexClient } from './vertexClient.js';
import { rememberToolCallSignature, THOUGHT_SIGNATURE_BYPASS } from './thoughtSignatures.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = getWorkerConfig(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return jsonResponse({
          ok: true,
          name: 'vertex-api-cloudflare-worker',
          endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/messages']
        });
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({
          ok: true,
          provider: 'vertex',
          configured: Boolean(config.vertex.projectId && config.vertex.clientEmail && config.vertex.privateKey),
          project_id: config.vertex.projectId || null,
          location: config.vertex.location,
          models: config.vertex.models
        });
      }

      if (url.pathname.startsWith('/v1/')) {
        assertApiToken(config, request);
        assertVertexConfigured(config);
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
        return await handleOpenAiChat(request, config);
      }

      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        return await handleAnthropicMessages(request, config);
      }

      return jsonResponse({ error: { message: 'Not found', type: 'not_found_error' } }, 404);
    } catch (error) {
      return errorResponse(error, url.pathname === '/v1/messages');
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
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.replace(/^Bearer\s+/i, '').trim();
  const apiKey = request.headers.get('x-api-key') || '';
  const actual = bearer || apiKey.trim();

  if (!expected || actual !== expected) {
    const error = new Error('Invalid API key');
    error.status = 401;
    throw error;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error('Invalid JSON request body');
    error.status = 400;
    throw error;
  }
}

function linkedAbortController(request) {
  const controller = new AbortController();
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
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

function errorResponse(error, anthropic = false) {
  const status = error.status || 500;
  const payload = anthropic
    ? {
        type: 'error',
        error: {
          type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error',
          message: error.message || 'Internal server error'
        }
      }
    : {
        error: {
          message: error.message || 'Internal server error',
          type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error',
          details: error.details
        }
      };

  return jsonResponse(payload, status);
}
