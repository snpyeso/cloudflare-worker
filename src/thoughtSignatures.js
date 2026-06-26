import { base64UrlToUtf8, utf8ToBase64Url } from './encoding.js';

const MAX_SIGNATURES = 1000;
const SIGNATURE_MARKER = '_ts_';

export const THOUGHT_SIGNATURE_BYPASS = 'context_engineering_is_the_way_to_go';

const toolCallSignatures = new Map();
const toolNameSignatures = new Map();

export function rememberToolCallSignature(id, signature, name = '') {
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

export function getToolCallSignature(id) {
  return id ? toolCallSignatures.get(String(id)) || readSignatureFromId(id) : '';
}

export function getToolNameSignature(name) {
  return name ? toolNameSignatures.get(String(name)) || '' : '';
}

export function makeSignedToolId(prefix, index, signature) {
  const random = crypto.randomUUID().replaceAll('-', '');
  const base = `${prefix}_${index}_${random}`;
  return signature ? `${base}${SIGNATURE_MARKER}${utf8ToBase64Url(signature)}` : base;
}

export function readSignatureFromId(id) {
  const value = String(id || '');
  const markerIndex = value.lastIndexOf(SIGNATURE_MARKER);
  if (markerIndex === -1) return '';

  try {
    return base64UrlToUtf8(value.slice(markerIndex + SIGNATURE_MARKER.length));
  } catch {
    return '';
  }
}
