import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { ProviderAdapter, OpenAIRequest, OpenAIError, OpenAIResponse } from '@untangle-ai/core';
import { usageTracker } from '@untangle-ai/core';

interface ChatContext {
  registry: { getForModel(modelId: string): ProviderAdapter | undefined };
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
}

function toHttpErrorStatus(status: number): 400 | 401 | 403 | 404 | 408 | 409 | 422 | 429 | 500 | 502 | 503 | 504 {
  switch (status) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 408:
    case 409:
    case 422:
    case 429:
    case 500:
    case 502:
    case 503:
    case 504:
      return status;
    default:
      return status >= 400 && status < 500 ? 400 : 502;
  }
}

function parseSseEventData(eventBlock: string): string[] {
  const dataLines = eventBlock
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length > 0) {
    return [dataLines.join('\n')];
  }

  const fallback = eventBlock.trim();
  return fallback.length > 0 ? [fallback] : [];
}

async function readUpstreamError(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({ error: { message: response.statusText } }));
  }

  const text = await response.text().catch(() => response.statusText);
  return { error: { message: text || response.statusText } };
}

function isValidChatRequest(body: unknown): body is OpenAIRequest {
  if (!body || typeof body !== 'object') return false;
  const maybe = body as Partial<OpenAIRequest>;
  if (typeof maybe.model !== 'string' || maybe.model.length === 0) return false;
  if (!Array.isArray(maybe.messages)) return false;
  return maybe.messages.every((m) => m && typeof m === 'object' && typeof m.role === 'string');
}

export function createChatRoutes(ctx: ChatContext) {
  const app = new Hono();

  app.post('/v1/chat/completions', async (c) => {
    const startTime = Date.now();
    let providerId = '';
    let modelId = '';

    try {
      const rawBody = await c.req.json().catch(() => null);
      if (!isValidChatRequest(rawBody)) {
        return c.json<OpenAIError>({
          error: {
            message: 'Invalid request body. Expected { model: string, messages: OpenAIMessage[] }',
            type: 'invalid_request_error',
            code: 'invalid_body',
          },
        }, 400);
      }
      const body: OpenAIRequest = rawBody;
      modelId = body.model;

      const adapter = ctx.registry.getForModel(body.model);
      if (!adapter) {
        return c.json<OpenAIError>({
          error: { message: `Model not found: ${body.model}`, type: 'invalid_request_error', code: 'model_not_found' }
        }, 404);
      }

      providerId = adapter.config.id;

      const apiKey = await ctx.getApiKey(adapter.config.id);
      if (!apiKey) {
        return c.json<OpenAIError>({
          error: { message: `No API key configured for provider: ${adapter.config.id}`, type: 'authentication_error', code: 'missing_api_key' }
        }, 401);
      }

      const providerRequest = adapter.transformRequest(body);
      const endpointUrl = adapter.getEndpointUrl('chat', { request: body, apiKey });
      const headers = {
        'Content-Type': 'application/json',
        ...adapter.getAuthHeaders(apiKey),
      };

      if (body.stream) {
        c.header('Content-Type', 'text/event-stream; charset=utf-8');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');

        return stream(c, async (streamWriter) => {
          let totalOutputTokens = 0;
          let sseBuffer = '';

          try {
            const response = await fetch(endpointUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(providerRequest),
            });

            if (!response.ok) {
              const upstreamError = await readUpstreamError(response);
              const normalized = adapter.normalizeError(upstreamError);
              await streamWriter.write(`data: ${JSON.stringify(normalized)}\n\n`);

              // Track failed request
              usageTracker.recordUsage(
                providerId,
                modelId,
                0,
                0,
                Date.now() - startTime,
                false,
                normalized.error.message
              );
              return;
            }

            if (!response.body) {
              throw new Error('Provider returned an empty streaming response body');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              sseBuffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

              let eventBoundary = sseBuffer.indexOf('\n\n');
              while (eventBoundary !== -1) {
                const block = sseBuffer.slice(0, eventBoundary);
                sseBuffer = sseBuffer.slice(eventBoundary + 2);

                for (const data of parseSseEventData(block)) {
                  if (data === '[DONE]') {
                    await streamWriter.write('data: [DONE]\n\n');
                    continue;
                  }

                  const chunk = adapter.transformStreamChunk(data, body);
                  if (!chunk) continue;

                  await streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);

                  // Estimate tokens from chunk content
                  if (chunk.choices?.[0]?.delta?.content) {
                    totalOutputTokens += Math.ceil(chunk.choices[0].delta.content.length / 4);
                  }
                }

                eventBoundary = sseBuffer.indexOf('\n\n');
              }
            }

            // Handle trailing event block if provider closes without final separator
            if (sseBuffer.trim().length > 0) {
              for (const data of parseSseEventData(sseBuffer)) {
                if (data !== '[DONE]') {
                  const chunk = adapter.transformStreamChunk(data, body);
                  if (chunk) {
                    await streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                }
              }
            }

            // Estimate input tokens from messages
            const inputTokens = Math.ceil(JSON.stringify(body.messages).length / 4);

            // Track successful streaming request
            usageTracker.recordUsage(providerId, modelId, inputTokens, totalOutputTokens, Date.now() - startTime, true);

          } catch (err) {
            const error = adapter.normalizeError(err);
            await streamWriter.write(`data: ${JSON.stringify(error)}\n\n`);

            // Track failed request
            usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, String(err));
          }
        });
      }

      // Non-streaming request
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(providerRequest),
      });

      if (!response.ok) {
        const errorBody = await readUpstreamError(response) as { error?: { message?: string }; message?: string };

        // Track failed request
        usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, errorBody.error?.message || errorBody.message);

        return c.json<OpenAIError>({
          error: { message: errorBody.error?.message || errorBody.message || 'Unknown error', type: 'api_error', code: null }
        }, toHttpErrorStatus(response.status));
      }

      const providerResponse = await response.json();
      const openaiResponse = adapter.transformResponse(providerResponse, body) as OpenAIResponse;

      // Track successful request with actual token counts from response
      const inputTokens = openaiResponse.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(body.messages).length / 4);
      const outputTokens = openaiResponse.usage?.completion_tokens ?? Math.ceil((openaiResponse.choices?.[0]?.message?.content?.length ?? 0) / 4);

      usageTracker.recordUsage(providerId, modelId, inputTokens, outputTokens, Date.now() - startTime, true);

      return c.json(openaiResponse);

    } catch (err) {
      console.error('Chat completion error:', err);

      // Track failed request
      if (providerId && modelId) {
        usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, String(err));
      }

      return c.json<OpenAIError>({
        error: { message: err instanceof Error ? err.message : 'Internal server error', type: 'internal_error', code: null }
      }, 500);
    }
  });

  return app;
}
