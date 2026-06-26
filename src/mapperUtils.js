import { THOUGHT_SIGNATURE_BYPASS } from './thoughtSignatures.js';

export function functionCallPart(functionCall, thoughtSignature) {
  const part = { functionCall };
  part.thoughtSignature = thoughtSignature || THOUGHT_SIGNATURE_BYPASS;
  return part;
}

export function functionCallPartsWithSignatures(parts) {
  let lastThoughtSignature = '';
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

export function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      mergeDeep(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

export function stripUndefined(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    } else {
      stripUndefined(value[key]);
    }
  }
}

export function extractGeminiChunkParts(gemini, mapFinishReason) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = (candidate.content?.parts || []).filter((part) => !part.thought);
  return {
    text: parts.map((part) => part.text).filter(Boolean).join(''),
    functionCalls: functionCallPartsWithSignatures(candidate.content?.parts || [])
      .map((part) => ({
        ...part.functionCall,
        thoughtSignature: part.thoughtSignature,
        thought_signature: part.thoughtSignature
      })),
    finishReason: candidate.finishReason ? mapFinishReason(candidate.finishReason) : null
  };
}
