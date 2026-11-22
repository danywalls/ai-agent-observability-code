/**
 * Chapter 9: "One Agent, Three Lenses: Comparing Genkit, LangSmith, and OpenTelemetry / Progress"
 *
 * This side-by-side script runs the exact same customer support scenario
 * ("Can you apply discount code VIP50 to my order A-1001?") where a tool
 * fails with a silent parameter mismatch (`discountCode` vs. normalized uppercase),
 * and prints the exact trace representation produced by each of the three lenses:
 *
 *   1. Genkit lens (`flow` -> `prompt` -> `model` -> `tool` with `genkit:*` attributes)
 *   2. LangSmith lens (`chain` -> `llm` -> `tool` with `run_type` & `usage_metadata`)
 *   3. OpenTelemetry / Progress Observability lens (`invoke_agent` -> `chat` -> `execute_tool`
 *      enriched by the Collector with USD cost and customer attribution)
 *
 * Run:
 *   npm run ch09
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace';

// Shared business scenario: applying a promo code to an order
export interface PromoScenarioInput {
  userId: string;
  customerTier: 'free' | 'vip';
  threadId: string;
  orderId: string;
  promoCodePassedByLlm: string; // e.g., "vip50 " (lowercase + trailing space -> subtle bug!)
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

// Collector processor that records the real OTel spans (including logical tool ERROR status)
const capturedOtelSpans: Array<{
  name: string;
  op: string;
  tokensIn?: number;
  tokensOut?: number;
  status: string;
}> = [];

class ComparisonSpanCollector implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    capturedOtelSpans.push({
      name: span.name,
      op: String(span.attributes['gen_ai.operation.name'] ?? 'custom'),
      tokensIn: span.attributes['gen_ai.usage.input_tokens'] as number | undefined,
      tokensOut: span.attributes['gen_ai.usage.output_tokens'] as number | undefined,
      status: span.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
    });
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

const sdk = new NodeSDK({
  serviceName: 'support-agent-three-lenses',
  spanProcessors: [new ComparisonSpanCollector()],
});
sdk.start();
const tracer = trace.getTracer('support-agent-three-lenses', '1.0.0');

export async function runScenarioAcrossThreeLenses(scenario: PromoScenarioInput) {
  capturedOtelSpans.length = 0;
  let toolOutput: ReturnType<typeof executePromoTool> | undefined;

  await tracer.startActiveSpan('invoke_agent supportAgent', async (agentSpan) => {
    agentSpan.setAttributes({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'supportAgent',
      'gen_ai.conversation.id': scenario.threadId,
      'user.id': scenario.userId,
      'customer.tier': scenario.customerTier,
    });

    // Step 1: First LLM call decides to invoke applyPromoCode
    await tracer.startActiveSpan('chat gemini-3-flash-preview', async (llm1) => {
      llm1.setAttributes({
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'gemini-3-flash-preview',
        'gen_ai.usage.input_tokens': 310,
        'gen_ai.usage.output_tokens': 28,
      });
      llm1.end();
    });

    // Step 2: Tool execution fails logically because the LLM passed "vip50 " instead of "VIP50"
    toolOutput = await tracer.startActiveSpan('execute_tool applyPromoCode', async (toolSpan) => {
      toolSpan.setAttributes({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'applyPromoCode',
      });
      const res = executePromoTool(scenario.orderId, scenario.promoCodePassedByLlm);
      if (!res.applied) {
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: res.errorCode });
      }
      toolSpan.end();
      return res;
    });

    // Step 3: Second LLM call explains the result to the user
    await tracer.startActiveSpan('chat gemini-3-flash-preview', async (llm2) => {
      llm2.setAttributes({
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'gemini-3-flash-preview',
        'gen_ai.usage.input_tokens': 390,
        'gen_ai.usage.output_tokens': 45,
      });
      llm2.end();
    });

    agentSpan.end();
  });

  return {
    scenario,
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

    console.log('=== Tool Output Captured in All Three Lenses ===');
    console.log(result.toolOutput);
    console.log('\n=== Captured OpenTelemetry Spans (notice ERROR status on applyPromoCode) ===');
    console.table(result.capturedOtelSpans);
    console.log('\n=== How Each Step Appears Across the Three Lenses ===');
    console.table(result.lenses);
    await sdk.shutdown();
  })().catch((err) => {
    console.error('Chapter 9 execution failed:', err);
    process.exit(1);
  });
}
