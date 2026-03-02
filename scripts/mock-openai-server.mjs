import http from 'node:http';

const PORT = process.env.MOCK_OPENAI_PORT ? Number(process.env.MOCK_OPENAI_PORT) : 4020;

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve(null);
      }
    });
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendSse(res, lines) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const line of lines) {
    res.write(line);
  }
  res.end();
}

function isFailModel(model) {
  return typeof model === 'string' && model.endsWith('-fail');
}

function isRetryAfterModel(model) {
  return typeof model === 'string' && model.endsWith('-retry');
}

function isCircuitModel(model) {
  return typeof model === 'string' && model.endsWith('-circuit');
}

function modelDelayMs(model) {
  if (typeof model !== 'string') return 10;
  if (model.includes('gpt-4o-mini')) return 20;
  if (model.includes('gpt-4o')) return 120;
  return 10;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson(req);
    if (!body) {
      return sendJson(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    }
    const model = body.model;

    if (isFailModel(model) || isCircuitModel(model)) {
      return sendJson(res, 503, { error: { message: 'Upstream unavailable', type: 'api_error', code: 'upstream_503' } });
    }
    if (isRetryAfterModel(model)) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      return res.end(JSON.stringify({ error: { message: 'Retry later', type: 'api_error', code: 'upstream_503' } }));
    }

    if (body.stream) {
      const lines = [
        'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      return sendSse(res, lines);
    }

    const delay = modelDelayMs(model);
    setTimeout(() => {
      sendJson(res, 200, {
        id: 'chatcmpl_mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }, delay);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const body = await readJson(req);
    if (!body) {
      return sendJson(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    }
    const model = body.model ?? 'mock-model';
    if (body.stream) {
      const lines = [
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_mock","object":"response","model":"' + model + '"}}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_mock","object":"response","model":"' + model + '","output_text":["Hello"]}}\n\n',
      ];
      return sendSse(res, lines);
    }
    return sendJson(res, 200, {
      id: 'resp_mock',
      object: 'response',
      model,
      output: [{ type: 'output_text', text: 'Hello' }],
      output_text: 'Hello',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
    const body = await readJson(req);
    if (!body) {
      return sendJson(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    }
    return sendJson(res, 200, {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: body.model ?? 'mock-embed',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    return sendJson(res, 200, { text: 'hello' });
  }

  if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
    const payload = Buffer.from('mock-audio');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': payload.length });
    return res.end(payload);
  }

  if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: 'http://example.com/mock.png' }],
    });
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai', created: 0 },
        { id: 'gpt-4o', object: 'model', owned_by: 'openai', created: 0 },
        { id: 'text-embedding-3-small', object: 'model', owned_by: 'openai', created: 0 },
      ],
    });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-openai] listening on http://127.0.0.1:${PORT}`);
});
