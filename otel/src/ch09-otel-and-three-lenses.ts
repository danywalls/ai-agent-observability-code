/**
 * Chapter 9: "OpenTelemetry Without Fear: The Standard Underneath All Three"
 *
 * Reveals how OpenTelemetry GenAI Semantic Conventions (`gen_ai.*`, including
 * `gen_ai.evaluation.*`) and OTLP unify Genkit (Ch. 5), LangSmith (Ch. 6-7), and
 * Progress Observability Platform (Ch. 8) under one vendor-neutral standard.
 *
 * Also reproduces the silent business-logic bug (`applyPromoCode` receiving "vip50 "
 * and returning `{ applied: false }` instead of throwing) and shows how each of the
 * three ecosystems represents the exact same trace and evaluation verdict.
 *
 * Run (privacy default: prompt/response events omitted):
 *   npm run ch09
 *
 * Run with opt-in message capture:
 *   OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true npm run ch09
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace';

export interface PromoScenarioInput {
  userId: string;
  customerTier: 'free' | 'vip';
  threadId: string;
  orderId: string;
  promoCodePassedByLlm: string; // e.g. "vip50 " (lowercase + trailing space -> subtle bug!)
}

export function executePromoTool(orderId: string, code: string) {
  const validCodes: Record<string, number> = { VIP50: 0.5, WELCOME10: 0.1 };
  const discount = validCodes[code]; // Bug: case-sensitive & un-trimmed lookup!
  if (!discount) {
    return {
      applied: false,
      errorCode: 'INVALID_PROMO_CODE',
      message: `Code "${code}" does not exist. Valid format is uppercase alphanumeric.`,
    };
  }
  return { applied: true, orderId, discountPercent: discount * 100 };
}

const MODEL_RATES_PER_1M: Record<string, { input: number; output: number }> = {
  'gemini-3-flash-preview': { input: 0.3, output: 2.5 },
};

export interface CapturedSpanSummary {
  name: string;
  op: string;
  tokensIn?: number;
  tokensOut?: number;
  enrichedCostUsd?: string;
  events: string;
  status: string;
}

const capturedOtelSpans: CapturedSpanSummary[] = [];

class CollectorCostEnricherProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes;
    const operation = String(attrs['gen_ai.operation.name'] ?? 'evaluation');
    const model = String(attrs['gen_ai.request.model'] ?? attrs['gen_ai.response.model'] ?? '');
    const inTokens = attrs['gen_ai.usage.input_tokens'] as number | undefined;
    const outTokens = attrs['gen_ai.usage.output_tokens'] as number | undefined;

    let enrichedCostUsd: string | undefined;
    let costSummary = '';
    if (operation === 'chat' && MODEL_RATES_PER_1M[model] && inTokens !== undefined && outTokens !== undefined) {
      const rate = MODEL_RATES_PER_1M[model];
      const costUsd = (inTokens / 1_000_000) * rate.input + (outTokens / 1_000_000) * rate.output;
      enrichedCostUsd = `$${costUsd.toFixed(6)}`;
      costSummary = ` | tokens=${inTokens}->${outTokens} | enrichedCost=${enrichedCostUsd}`;
    }

    const evalLabel = attrs['gen_ai.evaluation.score.label'];
    const evalSummary = evalLabel ? ` | eval=${String(attrs['gen_ai.evaluation.name'])}:${String(evalLabel)}` : '';

    const eventNames = span.events.map((e) => e.name);
    const eventsText =
      eventNames.length > 0
        ? eventNames.join(',')
        : operation === 'invoke_agent' || Boolean(evalLabel)
          ? 'n/a'
          : 'none (privacy default)';
    const eventsLog = operation === 'invoke_agent' || Boolean(evalLabel) ? '' : ` | events=${eventsText}`;

    const parent = span.parentSpanContext?.spanId ? ` (parent=${span.parentSpanContext.spanId.slice(0, 8)})` : ' (root)';
    const status = span.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK';
    console.log(`[OTel Span] ${span.name}${parent} | op=${operation}${costSummary}${evalSummary}${eventsLog} | status=${status}`);

    capturedOtelSpans.push({
      name: span.name,
      op: operation,
      tokensIn: inTokens,
      tokensOut: outTokens,
      ...(enrichedCostUsd ? { enrichedCostUsd } : {}),
      events: eventsText,
      status,
    });
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

// Forward spans via OTLP HTTP automatically whenever OTEL_EXPORTER_OTLP_ENDPOINT is configured
const spanProcessors: SpanProcessor[] = [new CollectorCostEnricherProcessor()];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  spanProcessors.push(new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }));
}

const sdk = new NodeSDK({
  serviceName: 'store-support-agent',
  spanProcessors,
});

sdk.start();
const tracer = trace.getTracer('store-support-agent', '1.0.0');

// Security boundary: raw prompts and tool payloads remain opt-in
const CAPTURE_CONTENT = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true';

export async function runScenarioAcrossThreeLenses(scenario: PromoScenarioInput) {
  capturedOtelSpans.length = 0;
  let toolOutput: ReturnType<typeof executePromoTool> | undefined;

  await tracer.startActiveSpan('invoke_agent supportAgent', async (agentSpan) => {
    agentSpan.setAttributes({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': 'google_genai',
      'gen_ai.agent.name': 'supportAgent',
      'gen_ai.conversation.id': scenario.threadId,
      'user.id': scenario.userId,
      'customer.tier': scenario.customerTier,
    });

    try {
      // 1. First LLM call decides to apply the promo code
      await tracer.startActiveSpan('chat gemini-3-flash-preview', async (llm1) => {
        llm1.setAttributes({
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': 'google_genai',
          'gen_ai.request.model': 'gemini-3-flash-preview',
          'gen_ai.usage.input_tokens': 310,
          'gen_ai.usage.output_tokens': 28,
          'gen_ai.response.finish_reasons': ['tool_calls'],
        });
        if (CAPTURE_CONTENT) {
          llm1.addEvent('gen_ai.user.message', {
            content: `Can you apply promo code VIP50 to order ${scenario.orderId}?`,
          });
        }
        llm1.end();
      });

      // 2. Tool call fails logically because LLM passed "vip50 " instead of "VIP50"
      toolOutput = await tracer.startActiveSpan('execute_tool applyPromoCode', async (toolSpan) => {
        toolSpan.setAttributes({
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'applyPromoCode',
          'gen_ai.tool.call.id': 'call_promo_01',
        });
        const res = executePromoTool(scenario.orderId, scenario.promoCodePassedByLlm);
        if (!res.applied) {
          toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: res.errorCode });
          toolSpan.setAttribute('tool.business_success', false);
        }
        if (CAPTURE_CONTENT) {
          toolSpan.addEvent('gen_ai.tool.message', { content: JSON.stringify(res) });
        }
        toolSpan.end();
        return res;
      });

      // 3. Second LLM call explains the failed coupon to the customer
      await tracer.startActiveSpan('chat gemini-3-flash-preview', async (llm2) => {
        llm2.setAttributes({
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': 'google_genai',
          'gen_ai.request.model': 'gemini-3-flash-preview',
          'gen_ai.usage.input_tokens': 390,
          'gen_ai.usage.output_tokens': 45,
          'gen_ai.response.finish_reasons': ['stop'],
        });
        if (CAPTURE_CONTENT) {
          llm2.addEvent('gen_ai.assistant.message', {
            content: `Sorry, promo code "${scenario.promoCodePassedByLlm}" was rejected (${toolOutput?.errorCode}).`,
          });
        }
        llm2.end();
      });

      // 4. Standardized OpenTelemetry evaluation span (matching Ch. 8 Progress Evaluation Scores)
      await tracer.startActiveSpan('evaluation.policy_accuracy', async (evalSpan) => {
        evalSpan.setAttributes({
          'gen_ai.evaluation.name': 'policy_accuracy',
          'gen_ai.evaluation.score.label': toolOutput?.applied ? 'PASS' : 'FAIL',
          'gen_ai.evaluation.score.value': toolOutput?.applied ? 1 : 0,
          'gen_ai.evaluation.explanation':
            'Agent rejected valid VIP50 coupon because applyPromoCode performed a case-sensitive, un-trimmed lookup on "vip50 ".',
        });
        evalSpan.end();
      });

      agentSpan.setStatus({ code: SpanStatusCode.OK });
    } finally {
      agentSpan.end();
    }
  });

  return {
    scenario,
    captureContent: CAPTURE_CONTENT,
    toolOutput,
    capturedOtelSpans: [...capturedOtelSpans],
    lenses: [
      {
        step: '1. Root Agent',
        genkitView: 'flow: supportAgent',
        langsmithView: 'chain: LangGraph (supportAgent)',
        otelProgressView: 'invoke_agent supportAgent (gen_ai.conversation.id)',
      },
      {
        step: '2. LLM Call #1',
        genkitView: 'model: googleai/gemini-3-flash-preview (310 -> 28 tok)',
        langsmithView: 'llm: ChatGoogleGenerativeAI (310 -> 28 tok)',
        otelProgressView: 'chat gemini-3-flash-preview (enriched cost: $0.000163)',
      },
      {
        step: '3. Tool Call',
        genkitView: 'tool: applyPromoCode (input: "vip50 ")',
        langsmithView: 'tool: applyPromoCode (ToolMessage: INVALID_PROMO_CODE)',
        otelProgressView: 'execute_tool applyPromoCode [status=ERROR]',
      },
      {
        step: '4. LLM Call #2',
        genkitView: 'model: googleai/gemini-3-flash-preview (390 -> 45 tok)',
        langsmithView: 'llm: ChatGoogleGenerativeAI (390 -> 45 tok)',
        otelProgressView: 'chat gemini-3-flash-preview (enriched cost: $0.000229)',
      },
      {
        step: '5. Judge Eval',
        genkitView: 'evaluator: defineEvaluator score=0 (FAIL)',
        langsmithView: 'feedback: policy_accuracy=0 (Evaluators)',
        otelProgressView: 'gen_ai.evaluation.score.label="FAIL" + explanation',
      },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const result = await runScenarioAcrossThreeLenses({
      userId: 'usr_laura_42',
      customerTier: 'vip',
      threadId: 'thread_promo_99',
      orderId: 'A-1001',
      promoCodePassedByLlm: 'vip50 ',
    });

    console.log(`\nPrivacy message capture: ${result.captureContent ? 'ENABLED (opt-in)' : 'DISABLED (privacy default)'}`);
    console.log('Tool payload returned to LLM:', result.toolOutput);
    console.log('\n=== Captured OpenTelemetry GenAI Spans ===');
    console.table(result.capturedOtelSpans);
    console.log('\n=== How Each Step Maps Across All Three Ecosystems ===');
    console.table(result.lenses);
    await sdk.shutdown();
  })().catch((err) => {
    console.error('Chapter 9 execution failed:', err);
    process.exit(1);
  });
}
