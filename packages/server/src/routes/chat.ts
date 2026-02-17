import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { ProviderAdapter, OpenAIRequest, OpenAIError, OpenAIResponse } from '@untangle-ai/core';
import { usageTracker } from '@untangle-ai/core';

interface ChatContext {
  registry: { getForModel(modelId: string): ProviderAdapter | undefined };
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
}

export function createChatRoutes(ctx: ChatContext) {
  const app = new Hono();

  app.post('/v1/chat/completions', async (c) => {
    const startTime = Date.now();
    let providerId = '';
    let modelId = '';

    try {
      const body = await c.req.json<OpenAIRequest>();
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
      const endpointUrl = adapter.getEndpointUrl('chat');
      const headers = {
        'Content-Type': 'application/json',
        ...adapter.getAuthHeaders(apiKey),
      };

      if (body.stream) {
        return stream(c, async (streamWriter) => {
          let totalOutputTokens = 0;

          try {
            const response = await fetch(endpointUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(providerRequest),
            });

            if (!response.ok) {
              const errorText = await response.text();
              await streamWriter.write(`data: ${JSON.stringify({ error: { message: errorText } })}\n\n`);

              // Track failed request
              usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, errorText);
              return;
            }

            const reader = response.body!.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const text = decoder.decode(value, { stream: true });
              const lines = text.split('\n').filter(line => line.trim());

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data === '[DONE]') {
                    await streamWriter.write('data: [DONE]\n\n');
                  } else {
                    const chunk = adapter.transformStreamChunk(data);
                    if (chunk) {
                      await streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);
                      // Estimate tokens from chunk content
                      if (chunk.choices?.[0]?.delta?.content) {
                        totalOutputTokens += Math.ceil(chunk.choices[0].delta.content.length / 4);
                      }
                    }
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
        const errorBody = await response.json().catch(() => ({ message: response.statusText })) as { error?: { message?: string }; message?: string };

        // Track failed request
        usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, errorBody.error?.message || errorBody.message);

        return c.json<OpenAIError>({
          error: { message: errorBody.error?.message || errorBody.message || 'Unknown error', type: 'api_error', code: null }
        }, response.status as any);
      }

      const providerResponse = await response.json();
      const openaiResponse = adapter.transformResponse(providerResponse) as OpenAIResponse;

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
