/**
 * Chapter 1: "I asked AI to build an agent… and it worked"
 *
 * This is the kind of code an AI coding assistant generates when you ask:
 *   "Build me a support agent for my online store that looks up orders
 *    and answers customer questions. Use Genkit and Gemini."
 *
 * It works. But... what happens behind the scenes when you call it?
 *
 * Run it with the Developer UI (to SEE the traces):
 *   export GEMINI_API_KEY=your_key
 *   npx genkit start -- npx tsx --watch src/ch01-support-agent.ts
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

// Fake "database" for the example
const orders: Record<string, { status: string; date: string; total: number }> = {
  'A-1001': { status: 'shipped', date: '2026-11-10', total: 59.9 },
  'A-1002': { status: 'processing', date: '2026-11-13', total: 120.0 },
  'A-1003': { status: 'delivered', date: '2026-11-02', total: 15.5 },
};

// Tool: the model decides WHEN to call it and WITH WHICH arguments
const getOrder = ai.defineTool(
  {
    name: 'getOrder',
    description: 'Returns the status, date and total of an order given its ID (format A-XXXX).',
    inputSchema: z.object({ orderId: z.string() }),
    outputSchema: z.object({
      found: z.boolean(),
      status: z.string().optional(),
      date: z.string().optional(),
      total: z.number().optional(),
    }),
  },
  async ({ orderId }) => {
    const order = orders[orderId];
    return order ? { found: true, ...order } : { found: false };
  },
);

// The "agent": a flow that lets the model reason and use tools
export const supportAgent = ai.defineFlow(
  {
    name: 'supportAgent',
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.string(),
  },
  async ({ message }) => {
    const { text } = await ai.generate({
      system:
        'You are the customer support assistant of an online store. ' +
        "Reply briefly and kindly, in the customer's language. " +
        'If the customer asks about an order, use the getOrder tool.',
      prompt: message,
      tools: [getOrder],
    });
    return text;
  },
);
