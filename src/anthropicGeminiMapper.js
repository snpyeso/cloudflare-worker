import { sanitizeGeminiSchema } from './schema.js';
import { getToolCallSignature, getToolNameSignature, makeSignedToolId, rememberToolCallSignature } from './thoughtSignatures.js';
import { functionCallPart, functionCallPartsWithSignatures, mergeDeep, stripUndefined, extractGeminiChunkParts } from './mapperUtils.js';
import { createSseResponse } from './sse.js';

function asGeminiPartsFromAnthropic(content) {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text) parts.push({ text: part.text });
      } else if (part.type === 'image') {
        if (part.source?.type === 'base64') {
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
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n');
}

function parseToolResultContent(content) {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return { content };
    }
  }

  if (Array.isArray(content)) {
    return {
      content: content
        .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part)))
        .join('\n')
    };
  }

  return content || {};
}

function readThoughtSignature(value) {
  return value?.thoughtSignature || value?.thought_signature || getToolCallSignature(value?.id) || getToolNameSignature(value?.name) || '';
}

export function anthropicToGemini(request, modelOverrides = {}) {
  const contents = [];
  const toolUseNames = new Map();

  for (const message of request.messages || []) {
    if (message.role === 'assistant') {
      const parts = asGeminiPartsFromAnthropic(message.content);

      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item.type !== 'tool_use') continue;
        toolUseNames.set(item.id, item.name);
        parts.push(
          functionCallPart(
            {
              name: item.name,
              args: item.input || {}
            },
            readThoughtSignature(item)
          )
        );
      }

      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const toolResults = Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'tool_result')
      : [];

    if (toolResults.length > 0) {
      contents.push({
        role: 'user',
        parts: toolResults.map((result) => ({
          functionResponse: {
            name: toolUseNames.get(result.tool_use_id) || result.name || result.tool_use_id || 'tool_result',
            response: parseToolResultContent(result.content)
          }
        }))
      });
      continue;
    }

    const parts = asGeminiPartsFromAnthropic(message.content);
    if (parts.length > 0) contents.push({ role: 'user', parts });
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

  const functionDeclarations = (request.tools || [])
    .filter((tool) => tool.name)
    .map((tool) => ({
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

  mergeDeep(body, modelOverrides);
  stripUndefined(body);
  return body;
}

function buildToolConfig(toolChoice, functionDeclarations) {
  if (toolChoice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.name]
      }
    };
  }
  if (functionDeclarations.length > 0) return { functionCallingConfig: { mode: 'AUTO' } };
  return undefined;
}

export function geminiToAnthropic(gemini, requestModel) {
  const candidate = gemini.candidates?.[0] || {};
  const rawParts = candidate.content?.parts || [];
  const parts = rawParts.filter((part) => !part.thought);
  const content = [];

  const signedFunctionCallParts = functionCallPartsWithSignatures(rawParts);
  for (const part of parts) {
    if (part.text) {
      content.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      const signedPart = signedFunctionCallParts.shift() || part;
      const id = makeSignedToolId('toolu', content.length, signedPart.thoughtSignature);
      rememberToolCallSignature(id, signedPart.thoughtSignature, part.functionCall.name);
      content.push({
        type: 'tool_use',
        id,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
        thought_signature: signedPart.thoughtSignature,
        thoughtSignature: signedPart.thoughtSignature
      });
    }
  }

  return {
    id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: content.some((part) => part.type === 'tool_use') ? 'tool_use' : mapStopReason(candidate.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: gemini.usageMetadata?.promptTokenCount || 0,
      output_tokens: gemini.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

export function geminiChunkParts(gemini) {
  return extractGeminiChunkParts(gemini, mapStopReason);
}

function mapStopReason(reason) {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'stop_sequence';
  return 'end_turn';
}

function createAnthropicStreamStrategy() {
  let stopReason = 'end_turn';

  return {
    didToolUse() {
      stopReason = 'tool_use';
    },
    didFinish(reason) {
      if (stopReason !== 'tool_use') stopReason = reason;
    },
    stopReason() {
      return stopReason;
    }
  };
}

export function streamAnthropicResponse(model, stream, abortController) {
  return createSseResponse(async (sse) => {
    const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const strategy = createAnthropicStreamStrategy();
    let contentIndex = 0;
    let textBlockOpen = false;

    sse.event('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
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
          sse.event('content_block_start', {
            type: 'content_block_start',
            index: contentIndex,
            content_block: { type: 'text', text: '' }
          });
          textBlockOpen = true;
        }
        sse.event('content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'text_delta', text: chunk.text }
        });
      }

      for (const call of chunk.functionCalls) {
        if (textBlockOpen) {
          sse.event('content_block_stop', { type: 'content_block_stop', index: contentIndex });
          contentIndex += 1;
          textBlockOpen = false;
        }

        const toolUseId = makeSignedToolId('toolu', contentIndex, call.thoughtSignature);
        rememberToolCallSignature(toolUseId, call.thoughtSignature, call.name);
        sse.event('content_block_start', {
          type: 'content_block_start',
          index: contentIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: call.name,
            input: {},
            thought_signature: call.thoughtSignature,
            thoughtSignature: call.thoughtSignature
          }
        });
        sse.event('content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args || {}) }
        });
        sse.event('content_block_stop', { type: 'content_block_stop', index: contentIndex });
        contentIndex += 1;
        strategy.didToolUse();
      }

      if (chunk.finishReason) {
        strategy.didFinish(chunk.finishReason);
      }
    }

    if (textBlockOpen && !sse.closed()) {
      sse.event('content_block_stop', { type: 'content_block_stop', index: contentIndex });
    }
    if (!sse.closed()) {
      sse.event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: strategy.stopReason(), stop_sequence: null },
        usage: { output_tokens: 0 }
      });
      sse.event('message_stop', { type: 'message_stop' });
    }
  }, {
    format: 'anthropic',
    onCancel: () => abortController?.abort()
  });
}
