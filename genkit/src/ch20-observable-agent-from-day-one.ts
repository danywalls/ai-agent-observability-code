import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';
import { setCustomMetadataAttributes } from 'genkit/tracing';

function loadLocalEnv(): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../.env', '../../.env']) {
    const envPath = resolve(currentDir, rel);
    if (existsSync(envPath)) {
      process.loadEnvFile?.(envPath);
    }
  }
  if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
    process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
  }
}

loadLocalEnv();

/**
 * Chapter 20: How to Ask Your AI Assistant for an Observable Agent from Day 1
 * (Firebase Genkit Reference Template)
 *
 * Compare this file with Chapter 1 (`ch01-support-agent.ts`).
 * Includes from Day 1:
 * 1. Typed `defineFlow` and `defineTool` with strict Zod input/output schemas.
 * 2. Real ReAct agent loop via `ai.generate({ tools, maxTurns: 5 })` (plus deterministic
 *    local simulation fallback when `GEMINI_API_KEY` is not configured).
 * 3. Custom sub-spans via `ai.run()` for internal business logic & usage metrics.
 * 4. Custom business attributes via `setCustomMetadataAttributes()` for Genkit Monitoring.
 */

const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

const ai = genkit({
  plugins: hasGeminiKey ? [googleAI()] : [],
  ...(hasGeminiKey ? { model: googleAI.model('gemini-3-flash-preview') } : {}),
});

export const getOrderStatusTool = ai.defineTool(
  {
    name: 'getOrderStatus',
    description:
      'Fetch lean order status, daysSinceDelivery, and totalUsd by orderId (format A-XXXX).',
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
    if (orderId === 'A-1003') {
      return { orderId, status: 'delivered' as const, daysSinceDelivery: 12, totalUsd: 15.5 };
    }
    return { orderId, status: 'in_transit' as const, daysSinceDelivery: 0, totalUsd: 89.99 };
  }
);

export const checkReturnPolicyTool = ai.defineTool(
  {
    name: 'checkReturnPolicy',
    description:
      'Check if a delivered order is eligible for a refund based on daysSinceDelivery and customerTier.',
    inputSchema: z.object({
      daysSinceDelivery: z.number().describe('Days elapsed since order delivery'),
      customerTier: z.enum(['free', 'standard', 'vip']),
    }),
    outputSchema: z.object({
      eligible: z.boolean(),
      maxWindowDays: z.number(),
    }),
  },
  async ({ daysSinceDelivery, customerTier }) => {
    return ai.run(
      'evaluate-return-window',
      { daysSinceDelivery, customerTier },
      async () => {
        const maxWindowDays = customerTier === 'vip' ? 60 : 30;
        return {
          eligible: daysSinceDelivery <= maxWindowDays,
          maxWindowDays,
        };
      }
    );
  }
);

export const observableSupportFlow = ai.defineFlow(
  {
    name: 'observableSupportFlow',
    inputSchema: z.object({
      threadId: z.string(),
      customerTier: z.enum(['free', 'standard', 'vip']),
      promptVersion: z.string(),
      message: z.string(),
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

    // Local simulation fallback when running without a paid API key
    if (!hasGeminiKey) {
      const orderId = input.message.match(/A-\d{4}/)?.[0] ?? 'A-1002';
      const order = await getOrderStatusTool({ orderId });
      const policy = await checkReturnPolicyTool({
        daysSinceDelivery: order.daysSinceDelivery,
        customerTier: input.customerTier,
      });
      await ai.run('record-usage-metrics', { simulated: true }, async () => ({
        inputTokens: 0,
        outputTokens: 0,
      }));
      return {
        answer: policy.eligible
          ? `Order ${order.orderId} ($${order.totalUsd}) was delivered ${order.daysSinceDelivery} days ago and is eligible under your ${policy.maxWindowDays}-day ${input.customerTier} return window. - Store Support AI`
          : `Order ${order.orderId} was delivered ${order.daysSinceDelivery} days ago, which is outside our ${policy.maxWindowDays}-day return window. - Store Support AI`,
        eligibleForRefund: policy.eligible,
        trajectory: ['getOrderStatus', 'checkReturnPolicy'],
      };
    }

    // 2. Real ReAct loop bounded by maxTurns: 5 and structured output
    const response = await ai.generate({
      system:
        `You are a concise customer support agent. Customer tier: ${input.customerTier}. ` +
        'Always call getOrderStatus first, then checkReturnPolicy before answering refund questions.',
      prompt: input.message,
      tools: [getOrderStatusTool, checkReturnPolicyTool],
      maxTurns: 5,
      output: {
        schema: z.object({
          answer: z.string(),
          eligibleForRefund: z.boolean(),
        }),
      },
    });

    const trajectory = response.messages
      .flatMap((m) => m.content)
      .filter((part) => Boolean(part.toolRequest))
      .map((part) => part.toolRequest!.name);

    // 3. Record token usage in a dedicated sub-span
    await ai.run('record-usage-metrics', { usage: response.usage }, async () => ({
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    }));

    return {
      answer: response.output?.answer ?? response.text,
      eligibleForRefund: response.output?.eligibleForRefund ?? false,
      trajectory,
    };
  }
);

async function main() {
  const result = await observableSupportFlow({
    threadId: 'thread_genkit_day1',
    customerTier: 'vip',
    promptVersion: 'v1.0-observable',
    message: 'Can I return order A-1002?',
  });

  console.log('=== Genkit Day-1 Observable Agent Output ===');
  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  process.env.GENKIT_ENV !== 'dev' &&
  Boolean(
    process.argv[1] &&
      fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*\/src\//, '/src/'))
  );

if (isMain) {
  main().catch(console.error);
}
