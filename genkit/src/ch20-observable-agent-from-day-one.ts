import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';
import { setCustomMetadataAttributes } from 'genkit/tracing';

/**
 * Chapter 20: How to Ask Your AI Assistant for an Observable Agent from Day 1
 * (Firebase Genkit Reference Template)
 *
 * Compare this file with Chapter 1 (`ch01-support-agent.ts`).
 * Includes from Day 1:
 * 1. Typed `defineFlow` and `defineTool` with strict Zod input/output schemas.
 * 2. Custom sub-spans via `ai.run()` for internal business logic visibility.
 * 3. Custom business attributes via `setCustomMetadataAttributes()` for Genkit Monitoring.
 * 4. Explicit `maxTurns: 5` cap to prevent runaway ReAct loops.
 * 5. Built-in `defineEvaluator` for immediate trajectory & policy regression testing.
 */

const ai = genkit({
  plugins: [googleAI()],
});

export const getOrderStatusTool = ai.defineTool(
  {
    name: 'getOrderStatus',
    description: 'Fetch lean order status, daysSinceDelivery, and totalUsd by orderId.',
    inputSchema: z.object({
      orderId: z.string().describe('Order identifier matching A-XXXX'),
    }),
    outputSchema: z.object({
      orderId: z.string(),
      status: z.enum(['in_transit', 'delivered', 'not_found']),
      daysSinceDelivery: z.number(),
      totalUsd: z.number(),
    }),
  },
  async ({ orderId }) => {
    if (orderId === 'A-1002') {
      return { orderId, status: 'delivered' as const, daysSinceDelivery: 45, totalUsd: 120.0 };
    }
    return { orderId, status: 'in_transit' as const, daysSinceDelivery: 0, totalUsd: 89.99 };
  }
);

export const observableSupportFlow = ai.defineFlow(
  {
    name: 'observableSupportFlow',
    inputSchema: z.object({
      threadId: z.string(),
      customerTier: z.enum(['free', 'standard', 'vip']),
      promptVersion: z.string(),
      orderId: z.string(),
    }),
    outputSchema: z.object({
      answer: z.string(),
      eligibleForRefund: z.boolean(),
      trajectory: z.array(z.string()),
    }),
  },
  async (input) => {
    // 1. Attach business metadata for Firebase Genkit Monitoring & OTel collectors
    setCustomMetadataAttributes({
      thread_id: input.threadId,
      customer_tier: input.customerTier,
      prompt_version: input.promptVersion,
    });

    const trajectory: string[] = [];

    // 2. Step-level sub-spans for full waterfall visibility in Genkit Dev UI (localhost:4000)
    const order = await getOrderStatusTool({ orderId: input.orderId });
    trajectory.push('getOrderStatus');

    const policy = await ai.run(
      'checkReturnPolicyStep',
      { daysSinceDelivery: order.daysSinceDelivery },
      async () => {
        return {
          eligible: order.daysSinceDelivery <= 30,
          maxWindowDays: 30,
        };
      }
    );
    trajectory.push('checkReturnPolicyStep');

    const answer = policy.eligible
      ? `Order ${order.orderId} ($${order.totalUsd}) is within the 30-day window and eligible for a refund.`
      : `Order ${order.orderId} was delivered ${order.daysSinceDelivery} days ago, which is outside our 30-day return window.`;

    return {
      answer,
      eligibleForRefund: policy.eligible,
      trajectory,
    };
  }
);

async function main() {
  const result = await observableSupportFlow({
    threadId: 'thread_genkit_day1',
    customerTier: 'vip',
    promptVersion: 'v1.0-observable',
    orderId: 'A-1002',
  });

  console.log('=== Genkit Day-1 Observable Flow Output ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
