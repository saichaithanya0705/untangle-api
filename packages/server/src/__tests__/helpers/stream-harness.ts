export interface StreamingResponseOptions {
  failAfterEmit?: boolean;
  failError?: Error;
}

export function createStreamingResponse(
  eventBlocks: string[],
  options?: StreamingResponseOptions,
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  let failed = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < eventBlocks.length) {
        controller.enqueue(encoder.encode(eventBlocks[index]));
        index += 1;
        return;
      }
      if (options?.failAfterEmit && !failed) {
        failed = true;
        controller.error(options.failError ?? new Error('network stream interrupted'));
        return;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function extractSseDataEntries(body: string): string[] {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
}
