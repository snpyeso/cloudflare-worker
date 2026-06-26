import { normalizePrivateKey } from './encoding.js';

const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'];

export function getWorkerConfig(env) {
  const serviceAccount = parseJson(env.VERTEX_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON || '') || {};
  const models = splitLines(env.VERTEX_MODELS || env.MODELS);
  const modelOverrides = parseJson(env.VERTEX_MODEL_OVERRIDES || env.POST_BODY_PARAMETER_OVERRIDES || '') || {};

  return {
    apiToken: String(env.API_TOKEN || '').trim(),
    vertex: {
      projectId: String(env.VERTEX_PROJECT_ID || env.PROJECT_ID || serviceAccount.project_id || '').trim(),
      location: String(env.VERTEX_LOCATION || env.LOCATION || 'global').trim() || 'global',
      clientEmail: String(env.VERTEX_CLIENT_EMAIL || env.CLIENT_EMAIL || serviceAccount.client_email || '').trim(),
      privateKey: normalizePrivateKey(env.VERTEX_PRIVATE_KEY || env.PRIVATE_KEY || serviceAccount.private_key || ''),
      models: models.length > 0 ? models : DEFAULT_MODELS,
      preferences: {
        post_body_parameter_overrides: modelOverrides.post_body_parameter_overrides || modelOverrides
      }
    },
    allowAnyVertexModel: truthy(env.ALLOW_ANY_VERTEX_MODEL)
  };
}

export function assertVertexConfigured(config) {
  const { projectId, clientEmail, privateKey } = config.vertex;
  if (!projectId || !clientEmail || !privateKey) {
    const error = new Error('Vertex AI is not configured. Set VERTEX_SERVICE_ACCOUNT_JSON or VERTEX_PROJECT_ID, VERTEX_CLIENT_EMAIL, and VERTEX_PRIVATE_KEY.');
    error.status = 500;
    throw error;
  }
}

export function resolveModel(config, requestedModel) {
  const model = String(requestedModel || '').trim();
  if (!model) return config.vertex.models[0];
  if (config.allowAnyVertexModel || config.vertex.models.includes(model)) return model;

  const error = new Error(`Model '${model}' is not configured. Set VERTEX_MODELS or enable ALLOW_ANY_VERTEX_MODEL.`);
  error.status = 400;
  throw error;
}

export function modelOverrides(config, model) {
  return config.vertex.preferences?.post_body_parameter_overrides?.[model] || {};
}

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJson(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
