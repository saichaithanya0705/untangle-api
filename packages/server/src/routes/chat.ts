import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import type {
  ProviderRegistry,
  OpenAIRequest,
  OpenAIError,
  OpenAIResponse,
  DeploymentRouter,
  ControlPlaneService,
  ApiCompatibilityConfig,
  RoutingConfig,
  ResolvedDeployment,
} from '@untangle-ai/core';
import { usageTracker } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';
import { tracedFetch } from '../observability/tracing.js';
import { enforceVirtualKeyGate, estimateTextTokens } from './virtual-key.js';
import { findUnknownFields, normalizeChatBody } from './compatibility.js';
import { resolveDeploymentSelectionContext } from './region-routing.js';
import { ExactResponseCache, buildExactCacheKey } from '../cache/exact-cache.js';

interface ChatContext {
  registry: ProviderRegistry;
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
  router: DeploymentRouter;
  controlPlane?: ControlPlaneService;
  virtualKeyHeader?: string;
  requireVirtualKey?: boolean;
  apiCompatibility?: ApiCompatibilityConfig;
  routingConfig?: RoutingConfig;
  exactCache?: ExactResponseCache;
}

const CHAT_ALLOWED_FIELDS = new Set<string>([
  'model',
  'messages',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'n',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'user',
  'tools',
  'tool_choice',
  'response_format',
  'seed',
  'parallel_tool_calls',
  'input',
  'reasoning_effort',
]);

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

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const parsedAt = Date.parse(trimmed);
  if (!Number.isNaN(parsedAt)) {
    return Math.max(0, parsedAt - nowMs);
  }

  return undefined;
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

function missingApiKeyError(providerId: string): OpenAIError {
  return {
    error: {
      message: `No API key configured for provider: ${providerId}`,
      type: 'authentication_error',
      code: 'missing_api_key',
    },
  };
}

function dispatchShadowChatTraffic(
  c: Context,
  routeContext: ChatContext,
  deploymentRouter: DeploymentRouter,
  shadowDeployments: ResolvedDeployment[],
  baseRequest: OpenAIRequest,
): void {
  if (shadowDeployments.length === 0) {
    return;
  }

  queueMicrotask(() => {
    void Promise.allSettled(shadowDeployments.map(async (deployment, index) => {
      const apiKey = await routeContext.getApiKey(deployment.providerId);
      if (!apiKey) {
        deploymentRouter.recordFailure(deployment);
        return;
      }

      const requestForDeployment: OpenAIRequest = {
        ...baseRequest,
        model: deployment.modelId,
        stream: false,
      };
      const providerRequest = deployment.adapter.transformRequest(requestForDeployment);
      const endpointUrl = deployment.adapter.getEndpointUrl('chat', { request: requestForDeployment, apiKey });
      const headers = {
        'Content-Type': 'application/json',
        ...deployment.adapter.getAuthHeaders(apiKey),
      };

      const attemptStart = Date.now();
      try {
        const response = await tracedFetch(c, endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(providerRequest),
        }, {
          providerId: deployment.providerId,
          modelId: deployment.modelId,
          endpoint: 'chat.shadow',
          attempt: index + 1,
        });

        if (!response.ok) {
          deploymentRouter.recordFailure(deployment, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          });
          await response.arrayBuffer().catch(() => undefined);
          return;
        }

        deploymentRouter.recordSuccess(deployment, Date.now() - attemptStart);
        await response.arrayBuffer().catch(() => undefined);
      } catch {
        deploymentRouter.recordFailure(deployment);
      }
    }));
  });
}

export function buildChatContinuationRequest(
  baseRequest: OpenAIRequest,
  modelId: string,
  partialOutput: string,
  policyPrompt: string,
): OpenAIRequest {
  if (partialOutput.trim().length === 0) {
    return { ...baseRequest, model: modelId };
  }

  return {
    ...baseRequest,
    model: modelId,
    messages: [
      ...baseRequest.messages,
      { role: 'assistant', content: partialOutput },
      { role: 'user', content: policyPrompt },
    ],
  };
}

export function createChatRoutes(ctx: ChatContext) {
  const app = new Hono();
  const deploymentRouter = ctx.router;
  const getContextValue = (context: Context, key: string): unknown => (
    context.get as unknown as (name: string) => unknown
  )(key);

  app.post('/v1/chat/completions', async (c) => {
    const startTime = Date.now();
    let providerId = '';
    let modelId = '';
    let usageMetadata: Record<string, string> | undefined;

    try {
      const rawBody = await c.req.json().catch(() => null);
      const normalizedBody = normalizeChatBody(rawBody, ctx.apiCompatibility);
      if (!normalizedBody) {
        return c.json<OpenAIError>({
          error: {
            message: 'Invalid request body. Expected { model: string, messages: OpenAIMessage[] }',
            type: 'invalid_request_error',
            code: 'invalid_body',
          },
        }, 400);
      }

      const unknownFields = findUnknownFields(normalizedBody, CHAT_ALLOWED_FIELDS, ctx.apiCompatibility);
      if (unknownFields.length > 0) {
        return c.json<OpenAIError>({
          error: {
            message: `Unknown request fields: ${unknownFields.join(', ')}`,
            type: 'invalid_request_error',
            code: 'unknown_fields',
          },
        }, 400);
      }

      if (!isValidChatRequest(normalizedBody)) {
        return c.json<OpenAIError>({
          error: {
            message: 'Invalid request body. Expected { model: string, messages: OpenAIMessage[] }',
            type: 'invalid_request_error',
            code: 'invalid_body',
          },
        }, 400);
      }

      const body: OpenAIRequest = normalizedBody;
      const estimatedInputTokens = estimateTextTokens(JSON.stringify(body.messages));
      const virtualKeyGate = await enforceVirtualKeyGate(c, ctx, {
        modelId: body.model,
        inputTokens: estimatedInputTokens,
      });
      if (virtualKeyGate.deniedResponse) {
        return virtualKeyGate.deniedResponse;
      }
      const tenantId = virtualKeyGate.virtualKeyId ?? (getContextValue(c, 'tenantId') as string | undefined);
      usageMetadata = virtualKeyGate.virtualKeyId
        ? { virtualKeyId: virtualKeyGate.virtualKeyId }
        : undefined;
      const selectionContext = resolveDeploymentSelectionContext(c, ctx.routingConfig);
      const selection = deploymentRouter.selectDeployments(body.model, ctx.registry, selectionContext);
      const exactCacheKey = (!body.stream && ctx.exactCache?.isEnabled('chat'))
        ? buildExactCacheKey('chat', normalizedBody, {
            tenantId,
            virtualKeyId: virtualKeyGate.virtualKeyId,
            clientRegion: selectionContext?.clientRegion,
          })
        : undefined;
      if (exactCacheKey) {
        const cached = ctx.exactCache?.get<OpenAIResponse>(exactCacheKey);
        if (cached) {
          c.header('x-untangle-cache', 'hit');
          return c.json(cached);
        }
      }

      if (selection.deployments.length === 0) {
        return c.json<OpenAIError>({
          error: { message: `Model not found: ${body.model}`, type: 'invalid_request_error', code: 'model_not_found' },
        }, 404);
      }

      if (body.stream) {
        c.header('Content-Type', 'text/event-stream; charset=utf-8');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');

        return stream(c, async (streamWriter) => {
          let totalOutputTokens = 0;
          let streamStarted = false;
          let partialOutput = '';
          let lastError: OpenAIError | null = null;
          let attempt = 0;

          for (const deployment of selection.deployments) {
            attempt += 1;
            providerId = deployment.providerId;
            modelId = deployment.modelId;

            const apiKey = await ctx.getApiKey(deployment.providerId);
            if (!apiKey) {
              lastError = missingApiKeyError(deployment.providerId);
              observabilityMetrics.recordFallback();
              continue;
            }

            const allowMidStreamContinuation = streamStarted
              && deployment.streamFallbackPolicy.mode === 'continue-with-policy-prompt';
            const requestForDeployment: OpenAIRequest = allowMidStreamContinuation
              ? buildChatContinuationRequest(
                body,
                deployment.modelId,
                partialOutput,
                deployment.streamFallbackPolicy.policyPrompt,
              )
              : { ...body, model: deployment.modelId };
            const providerRequest = deployment.adapter.transformRequest(requestForDeployment);
            const endpointUrl = deployment.adapter.getEndpointUrl('chat', { request: requestForDeployment, apiKey });
            const headers = {
              'Content-Type': 'application/json',
              ...deployment.adapter.getAuthHeaders(apiKey),
            };

            const attemptStart = Date.now();
            let sseBuffer = '';

            try {
              const response = await tracedFetch(c, endpointUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(providerRequest),
              }, {
                providerId: deployment.providerId,
                modelId: deployment.modelId,
                endpoint: 'chat.completions',
                attempt,
              });

              if (!response.ok) {
                const upstreamError = await readUpstreamError(response);
                const normalized = deployment.adapter.normalizeError(upstreamError);
                lastError = normalized;

                deploymentRouter.recordFailure(deployment, {
                  retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
                });

                if (
                  deploymentRouter.isRetryableStatus(deployment, response.status)
                  && (
                    !streamStarted
                    || deployment.streamFallbackPolicy.mode === 'continue-with-policy-prompt'
                  )
                ) {
                  observabilityMetrics.recordFallback();
                  continue;
                }

                await streamWriter.write(`data: ${JSON.stringify(normalized)}\n\n`);
                usageTracker.recordUsage(
                  providerId,
                  modelId,
                  0,
                  totalOutputTokens,
                  Date.now() - startTime,
                  false,
                  normalized.error.message,
                  usageMetadata,
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
                      streamStarted = true;
                      await streamWriter.write('data: [DONE]\n\n');
                      deploymentRouter.recordSuccess(deployment, Date.now() - attemptStart);
                      usageTracker.recordUsage(
                        providerId,
                        modelId,
                        estimatedInputTokens,
                        totalOutputTokens,
                        Date.now() - startTime,
                        true,
                        undefined,
                        usageMetadata,
                      );
                      return;
                    }

                    const chunk = deployment.adapter.transformStreamChunk(data, requestForDeployment);
                    if (!chunk) continue;

                    streamStarted = true;
                    await streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);

                    if (chunk.choices?.[0]?.delta?.content) {
                      const delta = chunk.choices[0].delta.content;
                      partialOutput += delta;
                      totalOutputTokens += Math.ceil(delta.length / 4);
                    }
                  }

                  eventBoundary = sseBuffer.indexOf('\n\n');
                }
              }

              if (sseBuffer.trim().length > 0) {
                for (const data of parseSseEventData(sseBuffer)) {
                  if (data === '[DONE]') {
                    streamStarted = true;
                    await streamWriter.write('data: [DONE]\n\n');
                    break;
                  }

                  const chunk = deployment.adapter.transformStreamChunk(data, requestForDeployment);
                  if (!chunk) continue;

                  streamStarted = true;
                  await streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  if (chunk.choices?.[0]?.delta?.content) {
                    const delta = chunk.choices[0].delta.content;
                    partialOutput += delta;
                    totalOutputTokens += Math.ceil(delta.length / 4);
                  }
                }
              }

              deploymentRouter.recordSuccess(deployment, Date.now() - attemptStart);
              if (streamStarted) {
                await streamWriter.write('data: [DONE]\n\n');
              }

              usageTracker.recordUsage(
                providerId,
                modelId,
                estimatedInputTokens,
                totalOutputTokens,
                Date.now() - startTime,
                true,
                undefined,
                usageMetadata,
              );
              return;
            } catch (err) {
              const normalized = deployment.adapter.normalizeError(err);
              lastError = normalized;
              deploymentRouter.recordFailure(deployment);

              if (
                deploymentRouter.isRetryableError(deployment, err)
                && (
                  !streamStarted
                  || deployment.streamFallbackPolicy.mode === 'continue-with-policy-prompt'
                )
              ) {
                observabilityMetrics.recordFallback();
                continue;
              }

              await streamWriter.write(`data: ${JSON.stringify(normalized)}\n\n`);
              usageTracker.recordUsage(
                providerId,
                modelId,
                0,
                totalOutputTokens,
                Date.now() - startTime,
                false,
                String(err),
                usageMetadata,
              );
              return;
            }
          }

          const finalError: OpenAIError = lastError ?? {
            error: {
              message: 'No healthy deployment available for the requested model.',
              type: 'service_unavailable',
              code: 'no_healthy_deployment',
            },
          };
          await streamWriter.write(`data: ${JSON.stringify(finalError)}\n\n`);
          if (providerId && modelId) {
            usageTracker.recordUsage(
              providerId,
              modelId,
              0,
              totalOutputTokens,
              Date.now() - startTime,
              false,
              finalError.error.message,
              usageMetadata,
            );
          }
        });
      }

      let lastError: OpenAIError | null = null;
      let lastStatus = 500;
      let attempt = 0;

      for (const deployment of selection.deployments) {
        attempt += 1;
        providerId = deployment.providerId;
        modelId = deployment.modelId;

        const apiKey = await ctx.getApiKey(deployment.providerId);
        if (!apiKey) {
          lastError = missingApiKeyError(deployment.providerId);
          lastStatus = 401;
          observabilityMetrics.recordFallback();
          continue;
        }

        const requestForDeployment: OpenAIRequest = { ...body, model: deployment.modelId };
        const providerRequest = deployment.adapter.transformRequest(requestForDeployment);
        const endpointUrl = deployment.adapter.getEndpointUrl('chat', { request: requestForDeployment, apiKey });
        const headers = {
          'Content-Type': 'application/json',
          ...deployment.adapter.getAuthHeaders(apiKey),
        };

        const attemptStart = Date.now();

        try {
          const response = await tracedFetch(c, endpointUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(providerRequest),
          }, {
            providerId: deployment.providerId,
            modelId: deployment.modelId,
            endpoint: 'chat.completions',
            attempt,
          });

          if (!response.ok) {
            const upstreamError = await readUpstreamError(response);
            const normalized = deployment.adapter.normalizeError(upstreamError);
            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
            deploymentRouter.recordFailure(deployment, { retryAfterMs });

            lastError = normalized;
            lastStatus = response.status;

            if (deploymentRouter.isRetryableStatus(deployment, response.status)) {
              observabilityMetrics.recordFallback();
              continue;
            }

            usageTracker.recordUsage(
              providerId,
              modelId,
              0,
              0,
              Date.now() - startTime,
              false,
              normalized.error.message,
              usageMetadata,
            );
            return c.json(normalized, toHttpErrorStatus(response.status));
          }

          const providerResponse = await response.json();
          const openaiResponse = deployment.adapter.transformResponse(
            providerResponse,
            requestForDeployment,
          ) as OpenAIResponse;

          deploymentRouter.recordSuccess(deployment, Date.now() - attemptStart);

          const inputTokens = openaiResponse.usage?.prompt_tokens ?? estimatedInputTokens;
          const outputTokens = openaiResponse.usage?.completion_tokens
            ?? Math.ceil((openaiResponse.choices?.[0]?.message?.content?.length ?? 0) / 4);

          usageTracker.recordUsage(providerId, modelId, inputTokens, outputTokens, Date.now() - startTime, true, undefined, usageMetadata);
          dispatchShadowChatTraffic(
            c,
            ctx,
            deploymentRouter,
            selection.shadowDeployments,
            { ...body, stream: false },
          );
          if (exactCacheKey) {
            ctx.exactCache?.set(exactCacheKey, openaiResponse);
            c.header('x-untangle-cache', 'miss');
          }
          return c.json(openaiResponse);
        } catch (err) {
          deploymentRouter.recordFailure(deployment);
          const normalized = deployment.adapter.normalizeError(err);
          lastError = normalized;
          lastStatus = 502;

          if (deploymentRouter.isRetryableError(deployment, err)) {
            observabilityMetrics.recordFallback();
            continue;
          }

          usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, String(err), usageMetadata);
          return c.json(normalized, 500);
        }
      }

      const finalError: OpenAIError = lastError ?? {
        error: {
          message: 'No healthy deployment available for the requested model.',
          type: 'service_unavailable',
          code: 'no_healthy_deployment',
        },
      };

      if (providerId && modelId) {
        usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, finalError.error.message, usageMetadata);
      }
      return c.json(finalError, toHttpErrorStatus(lastStatus));
    } catch (err) {
      console.error('Chat completion error:', err);

      if (providerId && modelId) {
        usageTracker.recordUsage(providerId, modelId, 0, 0, Date.now() - startTime, false, String(err), usageMetadata);
      }

      return c.json<OpenAIError>({
        error: { message: err instanceof Error ? err.message : 'Internal server error', type: 'internal_error', code: null },
      }, 500);
    }
  });

  return app;
}
