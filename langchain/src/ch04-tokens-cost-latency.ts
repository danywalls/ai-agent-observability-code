/**
 * Chapter 4: "Tokens, Latency, and Cost: The Bill Nobody Explained" (LangChain v1 version)
 *
 * Demonstrates:
 *   1. Inspecting `AIMessage.usage_metadata` (`input_tokens`, `output_tokens`, `total_tokens`)
 *      across every turn of a ReAct loop to see how input tokens snowball on each step.
 *   2. Using built-in LangChain v1 middleware (`summarizationMiddleware`, `modelCallLimitMiddleware`)
 *      to keep long conversations from blowing up your token budget.
 *
 * Run (auto-loads `.env` on Node 20.12+):
 *   export GEMINI_API_KEY=your_key   # or GOOGLE_API_KEY
 *   npm run ch04                     # or: npx tsx src/ch04-tokens-cost-latency.ts
 */
import {
  AIMessage,
  HumanMessage,
  createAgent,
  modelCallLimitMiddleware,
  summarizationMiddleware,
  tool,
} from 'langchain';
import { z } from 'zod';

// Load local .env if present (Node 20.12+) without overriding exported shell variables
try {
  process.loadEnvFile?.();
} catch {
  // No .env file present; rely on exported environment variables
}

// ✅ Lean tool: explicit column selection and row limit (inspired by LangChain SQL best practices)
export const getCustomerRecentOrders = tool(
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
    return JSON.stringify(allOrders.slice(0, cap));
  },
  {
    name: 'getCustomerRecentOrders',
    description: 'Returns recent orders (orderId, date, status, total). Always pass a small limit (max 5).',
    schema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(5)
        .describe('Maximum number of recent orders to return (1 to 5)'),
    }),
  },
);

export const budgetProtectedAgent = createAgent({
  model: 'google-genai:gemini-3-flash-preview',
  tools: [getCustomerRecentOrders],
  systemPrompt:
    'You are a concise customer support assistant. ' +
    'Prefer explicit, small queries (limit <= 5) and reply briefly.',
  middleware: [
    // Hard ceiling on how many times the LLM can be called in a single run
    modelCallLimitMiddleware({ runLimit: 4 }),
    // Automatically summarizes older messages when the thread grows too large
    summarizationMiddleware({
      model: 'google-genai:gemini-3-flash-preview',
      trigger: { tokens: 4000, messages: 12 },
      keep: { messages: 6 },
    }),
  ],
});

/**
 * Helper to extract per-step token snowballing from a completed agent run.
 */
export function summarizeTokenSnowball(messages: unknown[]) {
  let step = 0;
  let cumulativeInput = 0;
  let cumulativeOutput = 0;

  const breakdown = [];
  for (const msg of messages) {
    if (msg instanceof AIMessage && msg.usage_metadata) {
      step += 1;
      const { input_tokens, output_tokens, total_tokens } = msg.usage_metadata;
      cumulativeInput += input_tokens;
      cumulativeOutput += output_tokens;
      breakdown.push({
        llmCall: step,
        inputTokensThisCall: input_tokens,
        outputTokensThisCall: output_tokens,
        totalTokensThisCall: total_tokens,
      });
    }
  }

  return {
    totalLlmCalls: step,
    cumulativeInputTokens: cumulativeInput,
    cumulativeOutputTokens: cumulativeOutput,
    breakdown,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const result = await budgetProtectedAgent.invoke({
      messages: [new HumanMessage('What are my recent orders and which one is the most expensive?')],
    });

    const finalMessage = result.messages.at(-1)?.content;
    console.log(
      '\n[Agent reply]\n',
      typeof finalMessage === 'string' ? finalMessage : JSON.stringify(finalMessage, null, 2),
    );

    const summary = summarizeTokenSnowball(result.messages);
    console.table(summary.breakdown);
    console.log('Cumulative totals:', {
      totalLlmCalls: summary.totalLlmCalls,
      cumulativeInputTokens: summary.cumulativeInputTokens,
      cumulativeOutputTokens: summary.cumulativeOutputTokens,
    });
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
