import { SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({ serviceName: 'support-streaming' });
sdk.start();

const tracer = trace.getTracer('support-streaming', '1.0.0');

async function* mockTokenStream(signal: AbortSignal): AsyncGenerator<string> {
  const chunks = ['Your ', 'order ', 'A-1002 ', 'is eligible ', 'for replacement.'];
  for (const chunk of chunks) {
    if (signal.aborted) {
      throw new Error('Client aborted SSE stream');
    }
    await new Promise((r) => setTimeout(r, 30));
    yield chunk;
  }
}

async function streamSupportResponse(signal: AbortSignal): Promise<string> {
  return tracer.startActiveSpan('gen_ai.stream_response', async (span) => {
    const startMs = performance.now();
    let firstTokenMs: number | null = null;
    let lastChunkMs = startMs;
    const interChunkLatencies: number[] = [];
    let fullText = '';

    try {
      for await (const chunk of mockTokenStream(signal)) {
        const now = performance.now();
        if (firstTokenMs === null) {
          firstTokenMs = now - startMs;
          span.setAttribute('gen_ai.server.time_to_first_token', Number((firstTokenMs / 1000).toFixed(3)));
          span.addEvent('first_token', { ttft_ms: Math.round(firstTokenMs) });
        } else {
          interChunkLatencies.push(now - lastChunkMs);
        }
        lastChunkMs = now;
        fullText += chunk;
      }

      const avgTpotMs =
        interChunkLatencies.length > 0
          ? interChunkLatencies.reduce((a, b) => a + b, 0) / interChunkLatencies.length
          : 0;

      span.setAttribute('gen_ai.server.time_per_output_token', Number((avgTpotMs / 1000).toFixed(4)));
      span.setAttribute('gen_ai.usage.output_tokens', fullText.split(/\s+/).filter(Boolean).length);
      span.setStatus({ code: SpanStatusCode.OK });
      return fullText;
    } catch (error) {
      span.addEvent('stream_aborted', { reason: (error as Error).message });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function main() {
  const controller = new AbortController();
  const output = await streamSupportResponse(controller.signal);
  console.log('Completed SSE output:', output);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
