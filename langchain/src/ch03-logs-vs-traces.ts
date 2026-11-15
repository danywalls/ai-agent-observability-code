/**
 * Chapter 3: "Why Your Usual Logs Aren't Enough" (LangChain + LangSmith `traceable` version)
 *
 * Shows how `traceable` from `langsmith/traceable` turns any regular TypeScript
 * function into a child Run (Span) inside the parent trace, with its own run_type,
 * inputs, outputs, and latency.
 *
 * Run:
 *   export GOOGLE_API_KEY=your_key
 *   export LANGSMITH_TRACING=true
 *   export LANGSMITH_API_KEY=your_langsmith_key
 *   npx tsx src/ch03-logs-vs-traces.ts
 */
import { createAgent, tool, HumanMessage } from 'langchain';
import { traceable } from 'langsmith/traceable';
import { z } from 'zod';

const orders: Record<string, { status: string; date: string; total: number; customerTier: 'free' | 'vip' }> = {
  'A-1001': { status: 'shipped', date: '2026-11-10', total: 59.9, customerTier: 'free' },
  'A-1002': { status: 'delivered', date: '2026-09-01', total: 120.0, customerTier: 'vip' },
  'A-1003': { status: 'delivered', date: '2026-11-02', total: 15.5, customerTier: 'free' },
};

// ✅ Wrapping a regular function with `traceable` records its exact inputs and outputs
// as a nested Run inside the agent trace.
const checkRefundEligibility = traceable(
  async (input: { orderId: string; customerTier: 'free' | 'vip' }) => {
    const order = orders[input.orderId];
    if (!order) {
      return { eligible: false, daysSinceOrder: 0, maxDays: 0 };
    }
    const daysSinceOrder = 74; // simulated for A-1002
    const maxDays = 30; // Bug: ignores input.customerTier === 'vip' (should be 90)!
    return {
      eligible: order.status === 'delivered' && daysSinceOrder <= maxDays,
      daysSinceOrder,
      maxDays,
      customerTier: input.customerTier,
    };
  },
  { name: 'checkRefundEligibility', run_type: 'chain' },
);

export const getOrderWithEligibility = tool(
  async ({ orderId }) => {
    const order = orders[orderId];
    if (!order) return JSON.stringify({ found: false });

    const eligibility = await checkRefundEligibility({
      orderId,
      customerTier: order.customerTier,
    });

    return JSON.stringify({
      found: true,
      ...order,
      ...eligibility,
    });
  },
  {
    name: 'getOrderWithEligibility',
    description: 'Looks up an order by ID and checks whether it is eligible for a refund.',
    schema: z.object({ orderId: z.string() }),
  },
);

export const agent = createAgent({
  model: 'google-genai:gemini-2.5-flash',
  tools: [getOrderWithEligibility],
  systemPrompt:
    'You are the customer support assistant of an online store. ' +
    'VIP customers have a 90-day return window; standard customers have 30 days. ' +
    'Use getOrderWithEligibility before answering any refund question.',
});

// Top-level workflow wrapped with `traceable` so the entire user request becomes one root Trace
export const handleSupportRequest = traceable(
  async (input: { userId: string; message: string }) => {
    const result = await agent.invoke({
      messages: [new HumanMessage(input.message)],
    });
    return result.messages.at(-1)?.content;
  },
  { name: 'handleSupportRequest', run_type: 'chain' },
);
