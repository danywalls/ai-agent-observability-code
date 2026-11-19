/**
 * Chapter 3: "Why Your Usual Logs Aren't Enough" (Genkit version)
 *
 * Part A (`checkRefundEligibilityUntraced`) shows what happens when you try to debug
 * concurrent agent requests with `console.log`: interleaved lines, no tree,
 * no timing per step, and no visibility into custom business steps.
 *
 * Part B (`supportAgentWithCustomSteps`) shows how turning custom functions
 * into traced steps (`ai.run`) puts your own business logic (like eligibility
 * rules or customer tier lookup) inside the exact same trace tree as the LLM
 * and tool calls.
 *
 * Run with Developer UI (auto-loads `.env` on Node 20.12+):
 *   export GEMINI_API_KEY=your_key
 *   npx genkit start -- npx tsx --watch src/ch03-logs-vs-traces.ts
 *
 * Or run once directly in your terminal:
 *   npm run ch03
 */
import { genkit, z } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';

// Load local .env if present (Node 20.12+) without overriding exported shell variables
try {
  process.loadEnvFile?.();
} catch {
  // No .env file present; rely on exported environment variables
}

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-3-flash-preview'),
});

const orders: Record<
  string,
  { status: string; date: string; total: number; customerTier: 'free' | 'vip'; daysSinceOrder: number }
> = {
  'A-1001': { status: 'shipped', date: '2026-11-10', total: 59.9, customerTier: 'free', daysSinceOrder: 4 },
  'A-1002': { status: 'delivered', date: '2026-09-01', total: 120.0, customerTier: 'vip', daysSinceOrder: 74 }, // > 30 days ago, but VIP!
  'A-1003': { status: 'delivered', date: '2026-11-02', total: 15.5, customerTier: 'free', daysSinceOrder: 12 },
};

// ❌ What a coding assistant typically gives you when you ask for "logging":
function checkRefundEligibilityUntraced(orderId: string) {
  console.log(`[INFO] Checking refund eligibility for ${orderId}`);
  const order = orders[orderId];
  if (!order) {
    console.log('[WARN] Order not found');
    return { eligible: false, reason: 'Order not found' };
  }
  // Hidden bug: VIP customers are supposed to have 90 days, but the code checks 30 days for everyone!
  const daysSinceOrder = order.daysSinceOrder;
  const maxDays = 30;
  const eligible = order.status === 'delivered' && daysSinceOrder <= maxDays;
  console.log(`[INFO] Eligibility result: ${eligible}`);
  return { eligible, daysSinceOrder, maxDays, customerTier: order.customerTier };
}

const getOrderWithEligibility = ai.defineTool(
  {
    name: 'getOrderWithEligibility',
    description: 'Looks up an order by ID and checks whether it is eligible for a refund.',
    inputSchema: z.object({ orderId: z.string().describe('Order ID in format A-XXXX') }),
    outputSchema: z.object({
      found: z.boolean(),
      status: z.string().optional(),
      total: z.number().optional(),
      customerTier: z.string().optional(),
      eligibleForRefund: z.boolean().optional(),
      eligibilityReason: z.string().optional(),
    }),
  },
  async ({ orderId }) => {
    const order = orders[orderId];
    if (!order) return { found: false };

    // ✅ Wrapping custom business logic in `ai.run` creates a child Span in the trace
    // with its exact input, output, and duration.
    const eligibility = await ai.run('check-refund-eligibility', { orderId, tier: order.customerTier }, async () => {
      return checkRefundEligibilityUntraced(orderId);
    });

    return {
      found: true,
      status: order.status,
      total: order.total,
      customerTier: order.customerTier,
      eligibleForRefund: eligibility.eligible,
      eligibilityReason: `daysSinceOrder=${eligibility.daysSinceOrder}, maxDays=${eligibility.maxDays} (tier=${eligibility.customerTier})`,
    };
  },
);

export const supportAgentWithCustomSteps = ai.defineFlow(
  {
    name: 'supportAgentWithCustomSteps',
    inputSchema: z.object({ userId: z.string(), message: z.string() }),
    outputSchema: z.string(),
  },
  async ({ userId, message }) => {
    // Another custom span at the start of the flow
    const sanitizedMessage = await ai.run('sanitize-input', message, async () => {
      return message.trim();
    });

    const { text } = await ai.generate({
      system:
        'You are the customer support assistant of an online store. ' +
        'VIP customers have a 90-day return window; standard customers have 30 days. ' +
        'Use getOrderWithEligibility before answering any refund question.',
      prompt: sanitizedMessage,
      tools: [getOrderWithEligibility],
      maxTurns: 4,
    });

    return `[User: ${userId}] ${text}`;
  },
);

// Optional CLI runner when executed directly via `npm run ch03`
// (skipped under `genkit start`, which sets GENKIT_ENV=dev)
if (import.meta.url === `file://${process.argv[1]}` && process.env.GENKIT_ENV !== 'dev') {
  void (async () => {
    const reply = await supportAgentWithCustomSteps({
      userId: 'vip-101',
      message:
        'I bought a $120 keyboard two months ago (order A-1002). As a VIP member I get 90 days to return it, can I return it?',
    });
    console.log('\n[Agent reply]\n', reply);
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
