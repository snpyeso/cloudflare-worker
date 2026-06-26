import { sanitizeGeminiSchema } from './schema.js';
import { getToolCallSignature, getToolNameSignature, makeSignedToolId, rememberToolCallSignature } from './thoughtSignatures.js';
import { functionCallPart, functionCallPartsWithSignatures, mergeDeep, stripUndefined, extractGeminiChunkParts } from './mapperUtils.js';
import { createSseResponse } from './sse.js';

function asGeminiParts(content) {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part.type === 'text' || part.type === 'input_text') {
        if (part.text) parts.push({ text: part.text });
      } else if (part.type === 'image_url') {
        const url = part.image_url?.url || '';
        if (url.startsWith('data:')) {
          const [header, base64] = url.split(',');
          const mimeType = header.split(':')[1].split(';')[0];
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
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === 'text') return part.text || '';
        if (part.type === 'input_text') return part.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseToolArguments(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;

  try {
    return JSON.parse(args);
  } catch {
    return { value: args };
  }
}

function readThoughtSignature(value) {
  return (
    value?.extra_content?.google?.thought_signature ||
    value?.extra_content?.google?.thoughtSignature ||
    value?.thoughtSignature ||
    value?.thought_signature ||
    value?.function?.thoughtSignature ||
    value?.function?.thought_signature ||
    getToolCallSignature(value?.id) ||
    getToolNameSignature(value?.function?.name) ||
    ''
  );
}

export function openAiToGemini(request, modelOverrides = {}) {
  const systemTexts = [];
  const contents = [];
  const toolCallNames = new Map();

  for (const message of request.messages || []) {
    if (message.role === 'system') {
      const text = asTextContent(message.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (message.role === 'assistant') {
      const parts = asGeminiParts(message.content);

      for (const toolCall of message.tool_calls || []) {
        if (toolCall.type !== 'function') continue;
        if (toolCall.id) toolCallNames.set(toolCall.id, toolCall.function.name);
        parts.push(
          functionCallPart(
            {
              name: toolCall.function.name,
              args: parseToolArguments(toolCall.function.arguments)
            },
            readThoughtSignature(toolCall)
          )
        );
      }

      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
      continue;
    }

    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.name || toolCallNames.get(message.tool_call_id) || message.tool_call_id || 'tool_result',
              response: parseToolArguments(message.content)
            }
          }
        ]
      });
      continue;
    }

    const parts = asGeminiParts(message.content);
    if (parts.length > 0) {
      contents.push({ role: 'user', parts });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature: request.temperature,
      topP: request.top_p,
      maxOutputTokens: request.max_tokens,
      stopSequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined
    }
  };

  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }

  const functionDeclarations = (request.tools || [])
    .filter((tool) => tool.type === 'function' && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: sanitizeGeminiSchema(tool.function.parameters)
    }));

  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }];
  }

  if (request.tool_choice && request.tool_choice !== 'auto') {
    body.toolConfig = buildToolConfig(request.tool_choice, functionDeclarations);
  }

  mergeDeep(body, modelOverrides);
  stripUndefined(body);
  return body;
}

function buildToolConfig(toolChoice, functionDeclarations) {
  if (toolChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }

  if (toolChoice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }

  const name = toolChoice?.function?.name;
  if (name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [name]
      }
    };
  }

  if (functionDeclarations.length > 0) {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }

  return undefined;
}

export function geminiToOpenAi(gemini, requestModel) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  const visibleParts = parts.filter((part) => !part.thought);
  const text = visibleParts.map((part) => part.text).filter(Boolean).join('');
  const functionCallParts = functionCallPartsWithSignatures(parts);
  const hasToolCalls = functionCallParts.length > 0;

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          tool_calls: hasToolCalls
            ? functionCallParts.map((part, index) => openAiToolCall(part, index))
            : undefined
        },
        finish_reason: hasToolCalls ? 'tool_calls' : mapFinishReason(candidate.finishReason)
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
  const id = makeSignedToolId('call', index, part.thoughtSignature);
  rememberToolCallSignature(id, part.thoughtSignature, part.functionCall.name);
  return {
    id,
    type: 'function',
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

export function geminiChunkParts(gemini) {
  return extractGeminiChunkParts(gemini, mapFinishReason);
}

function mapFinishReason(reason) {
  if (!reason || reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter';
  return 'stop';
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
        toolCallId: makeSignedToolId('call', index, call.thoughtSignature)
      };
    },
    finishReason(reason) {
      return sawToolCall ? 'tool_calls' : reason;
    }
  };
}

export function streamOpenAiResponse(model, stream, abortController) {
  return createSseResponse(async (sse) => {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const strategy = createOpenAiStreamStrategy();
    let finished = false;

    sse.data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    });

    for await (const geminiChunk of stream) {
      if (sse.closed()) break;

      const chunk = geminiChunkParts(geminiChunk);
      if (chunk.text) {
        sse.data({
          id,
          object: 'chat.completion.chunk',
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
          object: 'chat.completion.chunk',
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
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: ''
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
          object: 'chat.completion.chunk',
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
          object: 'chat.completion.chunk',
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
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
    }

    if (!sse.closed()) {
      sse.data(null);
    }
  }, {
    format: 'openai',
    onCancel: () => abortController?.abort()
  });
}
