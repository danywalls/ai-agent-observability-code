/**
 * Chapter 4: "Tokens, Latency, and Cost: The Bill Nobody Explained" (Genkit version)
 *
 * Demonstrates:
 *   1. The "SELECT * / bloated tool payload" trap vs. returning lean, explicit fields.
 *   2. Reading `response.usage` (`inputTokens`, `outputTokens`, `thoughtsTokens`,
 *      `cachedContentTokens`, `totalTokens`) directly from `ai.generate()`.
 *   3. Calculating the exact USD cost of an agent run inside a traced step.
 *
 * Run with Developer UI (auto-loads `.env` on Node 20.12+):
 *   export GEMINI_API_KEY=your_key
 *   npx genkit start -- npx tsx --watch src/ch04-tokens-cost-latency.ts
 *
 * Or run once directly in your terminal:
 *   npm run ch04
 */
import { genkit, z, type GenerationUsage } from 'genkit';
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

// Example pricing table (USD per 1M tokens): update as provider pricing evolves
const PRICING_PER_MILLION: Record<string, { input: number; output: number; cachedInput: number }> = {
  'gemini-3-flash-preview': { input: 0.5, output: 3.0, cachedInput: 0.05 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedInput: 0.075 },
};

export function estimateCostUsd(modelName: string, usage?: GenerationUsage): number {
  const rates = PRICING_PER_MILLION[modelName] ?? PRICING_PER_MILLION['gemini-3-flash-preview'];
  const totalInput = usage?.inputTokens ?? 0;
  const cachedInput = usage?.cachedContentTokens ?? 0;
  const uncachedInput = Math.max(0, totalInput - cachedInput);
  // Note: reasoning/thinking models bill thoughtsTokens at the output rate
  const billableOutput = (usage?.outputTokens ?? 0) + (usage?.thoughtsTokens ?? 0);

  return (
    (uncachedInput / 1_000_000) * rates.input +
    (cachedInput / 1_000_000) * rates.cachedInput +
    (billableOutput / 1_000_000) * rates.output
  );
}

// ✅ Lean tool: returns ONLY the fields the agent actually needs and caps rows (limit <= 5)
const getCustomerRecentOrdersLean = ai.defineTool(
  {
    name: 'getCustomerRecentOrdersLean',
    description: 'Returns up to 5 recent orders for a customer with only orderId, date, status, and total.',
    inputSchema: z.object({
      customerEmail: z.string().describe('Authenticated customer email address'),
      limit: z.number().int().min(1).max(5).default(5).describe('Maximum number of recent orders to return (1 to 5)'),
    }),
    outputSchema: z.array(
      z.object({
        orderId: z.string(),
        date: z.string(),
        status: z.string(),
        total: z.number(),
      }),
    ),
  },
  async ({ limit }) => {
    const cap = Math.max(1, Math.min(limit ?? 5, 5));
    const allOrders = [
      { orderId: 'A-1001', date: '2026-11-10', status: 'shipped', total: 59.9 },
      { orderId: 'A-1002', date: '2026-11-13', status: 'processing', total: 120.0 },
      { orderId: 'A-1003', date: '2026-11-02', status: 'delivered', total: 15.5 },
      { orderId: 'A-1004', date: '2026-10-25', status: 'delivered', total: 42.0 },
      { orderId: 'A-1005', date: '2026-10-18', status: 'delivered', total: 29.9 },
      { orderId: 'A-1006', date: '2026-10-05', status: 'delivered', total: 88.0 },
    ];
    return allOrders.slice(0, cap);
  },
);

export const costAwareSupportAgent = ai.defineFlow(
  {
    name: 'costAwareSupportAgent',
    inputSchema: z.object({ customerEmail: z.string(), message: z.string() }),
    outputSchema: z.object({
      reply: z.string(),
      metrics: z.object({
        latencyMs: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        thoughtsTokens: z.number(),
        cachedTokens: z.number(),
        estimatedCostUsd: z.number(),
      }),
    }),
  },
  async ({ customerEmail, message }) => {
    const startTime = Date.now();

    const response = await ai.generate({
      system:
        'You are a concise customer support assistant. ' +
        `The authenticated customer email is ${customerEmail}. ` +
        'Use getCustomerRecentOrdersLean when the user asks about their orders.',
      prompt: message,
      tools: [getCustomerRecentOrdersLean],
      maxTurns: 4,
    });

    const latencyMs = Date.now() - startTime;
    const usage = response.usage;

    const metrics = await ai.run('calculate-run-cost', { usage, latencyMs }, async () => {
      return {
        latencyMs,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        thoughtsTokens: usage?.thoughtsTokens ?? 0,
        cachedTokens: usage?.cachedContentTokens ?? 0,
        estimatedCostUsd: Number(estimateCostUsd('gemini-3-flash-preview', usage).toFixed(6)),
      };
    });

    return {
      reply: response.text,
      metrics,
    };
  },
);

// Optional CLI runner when executed directly via `npm run ch04`
// (skipped under `genkit start`, which sets GENKIT_ENV=dev)
if (import.meta.url === `file://${process.argv[1]}` && process.env.GENKIT_ENV !== 'dev') {
  void (async () => {
    const result = await costAwareSupportAgent({
      customerEmail: 'laura@example.com',
      message: 'What are my recent orders and which one was the most expensive?',
    });
    console.log('\n[Agent reply]\n', result.reply);
    console.log('\n[Run metrics]\n', result.metrics);
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
