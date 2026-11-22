/**
 * Chapter 8: "Progress Observability Platform: Tracing, FinOps Costs, and LLM-as-a-Judge"
 *
 * Shows how a framework-agnostic TypeScript support agent (calling @google/genai directly
 * with zero LangChain/Genkit lock-in) integrates with Progress Observability Platform:
 *   1. Loads ESM loader hooks (`@progress/observability/register/hooks`) before loading
 *      provider SDKs dynamically after `Observability.instrument(...)`.
 *   2. Wraps domain logic (`store-support-agent`, `lookup-order`, `check-return-policy`)
 *      with `wrapFunctionWithSpan` and propagates business tags (`tier:vip`, `order:A-1002`,
 *      `channel:web`) across all child spans via `propagateAttributes`.
 *   3. Exports live spans to Progress Collector (`OBSERVABILITY_API_KEY=ac_p_...`) where
 *      automatic USD Cost Analytics and LLM-as-a-Judge Evaluation Tasks operate without
 *      hardcoding pricing tables or re-running the agent.
 *
 * Run offline preview (no API keys required):
 *   npm run ch08
 *
 * Run live against Gemini + Progress Observability Platform:
 *   GOOGLE_API_KEY=... OBSERVABILITY_API_KEY=ac_p_... npm run ch08
 */
import '@progress/observability/register/hooks';
import {
  Observability,
  ObservabilityInstruments,
  ObservabilitySpanKind,
  propagateAttributes,
  wrapFunctionWithSpan,
} from '@progress/observability';
import type { Content, FunctionDeclaration, Part } from '@google/genai';

try {
  process.loadEnvFile?.();
} catch {
  // .env file is optional; environment variables may already be exported in the shell
}

export interface OrderRecord {
  orderId: string;
  customerTier: 'free' | 'vip';
  item: string;
  totalUsd: number;
  status: 'delivered' | 'shipped' | 'processing';
  daysSinceDelivery: number;
}

export const ORDERS: Record<string, OrderRecord> = {
  'A-1001': {
    orderId: 'A-1001',
    customerTier: 'free',
    item: 'Mechanical Keyboard',
    totalUsd: 129.0,
    status: 'delivered',
    daysSinceDelivery: 12,
  },
  'A-1002': {
    orderId: 'A-1002',
    customerTier: 'vip',
    item: 'Noise-Canceling Headphones',
    totalUsd: 149.0,
    status: 'delivered',
    daysSinceDelivery: 45,
  },
  'A-1003': {
    orderId: 'A-1003',
    customerTier: 'free',
    item: 'USB-C Hub',
    totalUsd: 59.0,
    status: 'shipped',
    daysSinceDelivery: 0,
  },
};

export const RETURN_POLICIES: Record<'free' | 'vip', { returnWindowDays: number; summary: string }> = {
  free: {
    returnWindowDays: 30,
    summary: 'Standard free-tier customers can return delivered items within 30 days.',
  },
  vip: {
    returnWindowDays: 90,
    summary: 'VIP members receive an extended 90-day return window for delivered items.',
  },
};

export interface SupportAgentInput {
  userId: string;
  sessionId: string;
  customerTier: 'free' | 'vip';
  orderId: string;
  question: string;
}

export interface SupportAgentResult {
  mode: 'live' | 'offline-preview';
  orderId: string;
  customerTier: 'free' | 'vip';
  answer: string;
}

export const lookupOrder = wrapFunctionWithSpan(
  async (span, orderId: string) => {
    const normalizedId = orderId.trim().toUpperCase();
    const order = ORDERS[normalizedId] ?? null;
    span.setAttributes({
      'order.id': normalizedId,
      'order.found': Boolean(order),
      ...(order ? { 'order.days_since_delivery': order.daysSinceDelivery, 'order.total_usd': order.totalUsd } : {}),
    });
    span.addTags([order ? 'order:found' : 'order:missing']);
    if (!order) {
      return { found: false as const, orderId: normalizedId };
    }
    return { found: true as const, ...order };
  },
  'lookup-order',
  { spanKind: ObservabilitySpanKind.TOOL, passSpan: true },
);

export const checkReturnPolicy = wrapFunctionWithSpan(
  async (span, customerTier: 'free' | 'vip', daysSinceDelivery: number) => {
    const normalizedTier = customerTier === 'vip' ? 'vip' : 'free';
    const policy = RETURN_POLICIES[normalizedTier];
    const eligible = daysSinceDelivery >= 0 && daysSinceDelivery <= policy.returnWindowDays;
    span.setAttributes({
      'customer.tier': normalizedTier,
      'order.days_since_delivery': daysSinceDelivery,
      'policy.window_days': policy.returnWindowDays,
      'policy.eligible': eligible,
    });
    span.addTags([`tier:${normalizedTier}`, eligible ? 'policy:eligible' : 'policy:expired']);
    return {
      customerTier: normalizedTier,
      daysSinceDelivery,
      returnWindowDays: policy.returnWindowDays,
      eligible,
      policySummary: policy.summary,
    };
  },
  'check-return-policy',
  { spanKind: ObservabilitySpanKind.TOOL, passSpan: true },
);

export async function runStoreSupportWithProgress(input: SupportAgentInput): Promise<SupportAgentResult> {
  const geminiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  const observabilityKey = process.env.OBSERVABILITY_API_KEY;
  const appName = process.env.OBSERVABILITY_APP_NAME ?? 'store-support-agent';
  const traceContent = process.env.OBSERVABILITY_TRACE_CONTENT !== 'false';

  if (!geminiKey || !observabilityKey) {
    console.log('=== Offline Preview Mode (missing GOOGLE_API_KEY or OBSERVABILITY_API_KEY) ===');
    const order = ORDERS[input.orderId.trim().toUpperCase()];
    const policy = RETURN_POLICIES[input.customerTier];
    const days = order?.daysSinceDelivery ?? 45;
    const eligible = days <= policy.returnWindowDays;
    const simulatedAnswer =
      `Order ${input.orderId} ($${order?.totalUsd.toFixed(2) ?? '149.00'}) arrived ${days} days ago. ` +
      `Because your account tier is ${input.customerTier.toUpperCase()} (${policy.returnWindowDays}-day policy window), ` +
      `you ${eligible ? 'ARE' : 'are NOT'} eligible for a full refund.`;

    console.log('Expected Progress Observability span tree when live keys are set:');
    console.log(`  App: ${appName} | traceContent=${traceContent}`);
    console.log(`  Tags propagated: tier:${input.customerTier}, order:${input.orderId}, channel:web`);
    console.log('  ├─ [agent] store-support-agent');
    console.log('  │  ├─ [llm]   models.generateContent (gemini-3-flash-preview)');
    console.log('  │  ├─ [tool]  lookup-order');
    console.log('  │  ├─ [tool]  check-return-policy');
    console.log('  │  └─ [llm]   models.generateContent (gemini-3-flash-preview)');
    console.log('\nSimulated reply:', simulatedAnswer);
    console.log('\nTo send live traces to https://observability.progress.com:');
    console.log('  GOOGLE_API_KEY=your_key OBSERVABILITY_API_KEY=ac_p_your_key npm run ch08');

    return {
      mode: 'offline-preview',
      orderId: input.orderId,
      customerTier: input.customerTier,
      answer: simulatedAnswer,
    };
  }

  await Observability.instrument({
    appName,
    apiKey: observabilityKey,
    ...(process.env.OBSERVABILITY_ENDPOINT ? { endpoint: process.env.OBSERVABILITY_ENDPOINT } : {}),
    instruments: new Set([ObservabilityInstruments.GOOGLE_GENERATIVEAI]),
    traceContent,
    additionalTags: ['env:dev', 'team:support'],
  });

  try {
    // Load @google/genai AFTER Observability.instrument() so ESM loader hooks patch generateContent
    const { GoogleGenAI, Type } = await import('@google/genai');
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: { apiVersion: 'v1beta' },
    });

    const lookupOrderDeclaration: FunctionDeclaration = {
      name: 'lookupOrder',
      description: 'Look up an order record by ID to inspect its item, USD total, status, and days since delivery.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          orderId: { type: Type.STRING, description: 'The order ID, e.g. A-1002.' },
        },
        required: ['orderId'],
      },
    };

    const checkReturnPolicyDeclaration: FunctionDeclaration = {
      name: 'checkReturnPolicy',
      description: 'Verify return eligibility for a customer tier (free = 30 days, vip = 90 days).',
      parameters: {
        type: Type.OBJECT,
        properties: {
          customerTier: { type: Type.STRING, description: 'Customer tier: "free" or "vip".' },
          daysSinceDelivery: { type: Type.INTEGER, description: 'Number of days since the order was delivered.' },
        },
        required: ['customerTier', 'daysSinceDelivery'],
      },
    };

    const tracedAgentFlow = wrapFunctionWithSpan(
      async (span, payload: SupportAgentInput): Promise<string> => {
        span.setAttributes({
          'user.id': payload.userId,
          'session.id': payload.sessionId,
          'customer.tier': payload.customerTier,
          'order.id': payload.orderId,
        });

        const contents: Content[] = [{ role: 'user', parts: [{ text: payload.question }] }];
        const model = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';
        const systemInstruction =
          'You are the store customer-support specialist. Always call lookupOrder and checkReturnPolicy ' +
          'before confirming refund eligibility. Standard customers get 30 days; VIP members get 90 days. ' +
          'Be concise, cite the exact policy window and order amount, and never invent order details.';

        for (let turn = 0; turn < 4; turn++) {
          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: [lookupOrderDeclaration, checkReturnPolicyDeclaration] }],
            },
          });

          const calls = response.functionCalls;
          if (!calls || calls.length === 0) {
            return response.text ?? 'Unable to generate a response.';
          }

          const modelContent = response.candidates?.[0]?.content ?? {
            role: 'model',
            parts: calls.map((functionCall) => ({ functionCall })),
          };
          contents.push(modelContent);

          const responseParts: Part[] = [];
          for (const call of calls) {
            const args = (call.args ?? {}) as Record<string, unknown>;
            let toolResult: Record<string, unknown>;
            if (call.name === 'lookupOrder') {
              toolResult = await lookupOrder(String(args.orderId ?? payload.orderId));
            } else if (call.name === 'checkReturnPolicy') {
              const tier = String(args.customerTier ?? payload.customerTier) === 'vip' ? 'vip' : 'free';
              const days = Number(args.daysSinceDelivery ?? 45);
              toolResult = await checkReturnPolicy(tier, days);
            } else {
              toolResult = { error: `Unknown tool: ${call.name}` };
            }

            responseParts.push({
              functionResponse: {
                name: call.name ?? 'unknown',
                ...(call.id ? { id: call.id } : {}),
                response: toolResult,
              },
            });
          }

          contents.push({ role: 'user', parts: responseParts });
        }

        return 'Exceeded maximum tool-calling turns while resolving support request.';
      },
      appName,
      { spanKind: ObservabilitySpanKind.AGENT, passSpan: true },
    );

    const answer = await propagateAttributes(
      [`tier:${input.customerTier}`, `order:${input.orderId}`, 'channel:web'],
      () => tracedAgentFlow(input),
    );

    return {
      mode: 'live',
      orderId: input.orderId,
      customerTier: input.customerTier,
      answer,
    };
  } finally {
    if (Observability.isInitialized) {
      await Observability.shutdown();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const result = await runStoreSupportWithProgress({
      userId: 'usr_laura_vip_42',
      sessionId: 'sess_a1002_01',
      customerTier: 'vip',
      orderId: 'A-1002',
      question: 'My order A-1002 arrived 45 days ago. As a VIP member, can I still get a refund?',
    });

    console.log(`\nMode: ${result.mode}`);
    console.log('Final support reply:\n', result.answer);
  })().catch((err) => {
    console.error('Chapter 8 execution failed:', err);
    process.exit(1);
  });
}
