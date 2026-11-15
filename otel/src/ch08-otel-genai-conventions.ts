/**
 * Chapter 8: "OpenTelemetry Without Fear: The Standard Underneath Everything"
 *
 * Shows:
 *   1. How an AI agent trace is represented using standard OpenTelemetry GenAI
 *      Semantic Conventions (`gen_ai.*`):
 *        - `invoke_agent supportAgent` (root agent span)
 *        - `chat gemini-2.5-flash`     (LLM client span with token usage)
 *        - `execute_tool getOrder`     (tool execution span)
 *   2. How the privacy opt-in works (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`):
 *      recording message events ONLY when explicitly enabled.
 *   3. How an OpenTelemetry Collector / enterprise platform (such as Progress Observability
 *      Platform, LangSmith OTLP, or Genkit Monitoring) receives these standard spans over OTLP
 *      and enriches them with USD cost and user attribution.
 *
 * Run locally (prints the standard GenAI spans + simulated Collector enrichment):
 *   npx tsx src/ch08-otel-genai-conventions.ts
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

// ---------------------------------------------------------------------------
// 1. Simulated Collector Enricher (illustrates how platforms like Progress
//    Observability Platform or LangSmith enrich incoming OTel GenAI spans)
// ---------------------------------------------------------------------------
const MODEL_RATES_PER_1M: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

class CollectorCostEnricherProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes;
    const operation = attrs['gen_ai.operation.name'];
    const model = String(attrs['gen_ai.request.model'] ?? attrs['gen_ai.response.model'] ?? '');
    const inTokens = Number(attrs['gen_ai.usage.input_tokens'] ?? 0);
    const outTokens = Number(attrs['gen_ai.usage.output_tokens'] ?? 0);

    let costSummary = '';
    if (operation === 'chat' && MODEL_RATES_PER_1M[model]) {
      const rate = MODEL_RATES_PER_1M[model];
      const costUsd = (inTokens / 1_000_000) * rate.input + (outTokens / 1_000_000) * rate.output;
      costSummary = ` | tokens=${inTokens}->${outTokens} | enrichedCost=$${costUsd.toFixed(6)}`;
    }

    const parent = span.parentSpanContext?.spanId ? ` (parent=${span.parentSpanContext.spanId.slice(0, 8)})` : ' (root)';
    console.log(
      `[OTel Span] ${span.name}${parent} | op=${operation}${costSummary}`,
    );
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

// In production, if OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g., to Progress Observability
// Collector, LangSmith OTLP endpoint, or Genkit Monitoring), OTLPTraceExporter sends spans there.
const sdk = new NodeSDK({
  serviceName: 'store-support-agent',
  spanProcessors: [
    new CollectorCostEnricherProcessor(),
  ],
  traceExporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? new OTLPTraceExporter() : undefined,
});

sdk.start();
const tracer = trace.getTracer('store-support-agent', '1.0.0');

// Security boundary: prompts/completions are ONLY recorded if explicitly opted in
const CAPTURE_CONTENT = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true';

// ---------------------------------------------------------------------------
// 2. Agent instrumented with OpenTelemetry GenAI Semantic Conventions
// ---------------------------------------------------------------------------
export async function runOtelInstrumentedAgent(input: {
  userId: string;
  sessionId: string;
  question: string;
}) {
  // Tier 1: Agent Invocation Span (`invoke_agent {gen_ai.agent.name}`)
  return tracer.startActiveSpan('invoke_agent supportAgent', async (agentSpan) => {
    agentSpan.setAttributes({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': 'google_genai',
      'gen_ai.agent.name': 'supportAgent',
      'gen_ai.agent.id': 'agent_support_v1',
      'gen_ai.conversation.id': input.sessionId,
      'user.id': input.userId,
    });

    try {
      // Tier 2: First LLM Call (`chat {gen_ai.request.model}`) -> decides to call getOrder
      await tracer.startActiveSpan('chat gemini-2.5-flash', async (llmSpan1) => {
        llmSpan1.setAttributes({
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': 'google_genai',
          'gen_ai.request.model': 'gemini-2.5-flash',
          'gen_ai.response.model': 'gemini-2.5-flash-001',
          'gen_ai.usage.input_tokens': 420,
          'gen_ai.usage.output_tokens': 35,
          'gen_ai.response.finish_reasons': ['tool_calls'],
        });

        if (CAPTURE_CONTENT) {
          llmSpan1.addEvent('gen_ai.user.message', { content: input.question });
        }
        llmSpan1.end();
      });

      // Tier 3: Tool Execution Span (`execute_tool {gen_ai.tool.name}`)
      const orderResult = await tracer.startActiveSpan('execute_tool getOrder', async (toolSpan) => {
        toolSpan.setAttributes({
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'getOrder',
          'gen_ai.tool.call.id': 'call_01',
        });
        const data = { found: true, orderId: 'A-1001', status: 'shipped', total: 59.9 };
        if (CAPTURE_CONTENT) {
          toolSpan.addEvent('gen_ai.tool.message', { content: JSON.stringify(data) });
        }
        toolSpan.end();
        return data;
      });

      // Tier 2: Second LLM Call (`chat {gen_ai.request.model}`) -> writes final answer
      const finalReply = await tracer.startActiveSpan('chat gemini-2.5-flash', async (llmSpan2) => {
        llmSpan2.setAttributes({
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': 'google_genai',
          'gen_ai.request.model': 'gemini-2.5-flash',
          'gen_ai.response.model': 'gemini-2.5-flash-001',
          'gen_ai.usage.input_tokens': 510,
          'gen_ai.usage.output_tokens': 48,
          'gen_ai.response.finish_reasons': ['stop'],
        });

        const answer = `Order ${orderResult.orderId} is ${orderResult.status} ($${orderResult.total}).`;
        if (CAPTURE_CONTENT) {
          llmSpan2.addEvent('gen_ai.assistant.message', { content: answer });
        }
        llmSpan2.end();
        return answer;
      });

      agentSpan.setStatus({ code: SpanStatusCode.OK });
      return finalReply;
    } finally {
      agentSpan.end();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reply = await runOtelInstrumentedAgent({
    userId: 'usr_laura_42',
    sessionId: 'sess_9001',
    question: 'Where is my order A-1001?',
  });
  console.log('\nFinal agent reply:', reply);
  await sdk.shutdown();
}
