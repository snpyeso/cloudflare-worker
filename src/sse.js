const encoder = new TextEncoder();

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta',
  'Access-Control-Max-Age': '86400'
};

export function withCors(headers = {}) {
  return { ...CORS_HEADERS, ...headers };
}

export function createSseResponse(handler, options = {}) {
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
          return write(`data: ${payload === null ? '[DONE]' : JSON.stringify(payload)}\n\n`);
        },
        event(event, payload) {
          return write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        },
        comment(text) {
          return write(`: ${text}\n\n`);
        },
        closed() {
          return closed;
        }
      };

      const heartbeat = setInterval(() => {
        sse.comment('keep-alive');
      }, 15000);

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
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    })
  });
}

function writeStreamError(sse, error, format) {
  const message = error?.message || String(error);
  if (format === 'anthropic') {
    sse.event('error', {
      type: 'error',
      error: {
        type: 'api_error',
        message
      }
    });
    return;
  }

  sse.data({
    error: {
      message,
      type: 'api_error',
      details: error?.details
    }
  });
  sse.data(null);
}
