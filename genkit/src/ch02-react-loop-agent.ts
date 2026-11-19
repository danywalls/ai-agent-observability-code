/**
 * Chapter 2: "What an Agent REALLY Is" (Genkit version)
 *
 * Here our support agent has THREE tools:
 *   1. getOrder: looks up an order by ID
 *   2. searchFaq: answers policy questions (returns, shipping, warranty)
 *   3. requestRefund: creates a refund request for a delivered order
 *
 * Notice that one user message ("Can I get a refund for order A-1003?")
 * makes the model loop through multiple tool calls on its own:
 *   Reason -> Call getOrder -> Observe -> Reason -> Call searchFaq -> Observe -> Call requestRefund -> Final answer
 *
 * Run with Developer UI:
 *   export GEMINI_API_KEY=your_key
 *   npx genkit start -- npx tsx --watch src/ch02-react-loop-agent.ts
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

// Fake database
const orders: Record<string, { status: string; date: string; total: number; item: string }> = {
  'A-1001': { status: 'shipped', date: '2026-11-10', total: 59.9, item: 'Wireless Headphones' },
  'A-1002': { status: 'processing', date: '2026-11-13', total: 120.0, item: 'Mechanical Keyboard' },
  'A-1003': { status: 'delivered', date: '2026-11-02', total: 15.5, item: 'USB-C Cable' },
};

const faqArticles = [
  {
    topic: 'returns and refunds',
    content:
      'Customers can request a refund within 30 days of delivery, only if the order status is "delivered" and total is under $100 for automatic processing.',
  },
  {
    topic: 'shipping times',
    content: 'Standard shipping takes 3 to 5 business days. Express shipping takes 24 hours.',
  },
];

// Tool 1: Look up order details
const getOrder = ai.defineTool(
  {
    name: 'getOrder',
    description: 'Returns the status, delivery/order date, item name and total of an order given its ID (format A-XXXX).',
    inputSchema: z.object({
      orderId: z.string().describe('Order ID in format A-XXXX'),
    }),
    outputSchema: z.object({
      found: z.boolean(),
      status: z.string().optional(),
      date: z.string().optional(),
      total: z.number().optional(),
      item: z.string().optional(),
    }),
  },
  async ({ orderId }) => {
    const order = orders[orderId];
    return order ? { found: true, ...order } : { found: false };
  },
);

// Tool 2: Search store policies (FAQ)
const searchFaq = ai.defineTool(
  {
    name: 'searchFaq',
    description: 'Searches the store FAQ and policies about returns, refunds, and shipping times.',
    inputSchema: z.object({
      query: z.string().describe('Topic or keyword to search in store policies'),
    }),
    outputSchema: z.array(z.object({ topic: z.string(), content: z.string() })),
  },
  async ({ query }) => {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    return faqArticles.filter((a) => {
      const haystack = `${a.topic} ${a.content}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  },
);

// Tool 3: Process a refund
const requestRefund = ai.defineTool(
  {
    name: 'requestRefund',
    description:
      'Submits a refund for an order. Only call this AFTER verifying order status is "delivered" and checking the refund policy.',
    inputSchema: z.object({
      orderId: z.string().describe('Order ID in format A-XXXX'),
      reason: z.string().describe('Short reason for the refund request'),
    }),
    outputSchema: z.object({
      refundId: z.string(),
      approved: z.boolean(),
      message: z.string(),
    }),
  },
  async ({ orderId, reason }) => {
    return {
      refundId: `REF-${orderId}`,
      approved: true,
      message: `Refund processed for ${orderId} (reason: ${reason})`,
    };
  },
);

export const supportAgentWithTools = ai.defineFlow(
  {
    name: 'supportAgentWithTools',
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.string(),
  },
  async ({ message }) => {
    const { text } = await ai.generate({
      system:
        'You are the customer support assistant of an online store. ' +
        "Always check the order details and the store's refund policy before processing any refund. " +
        "Reply briefly in the customer's language.",
      prompt: message,
      tools: [getOrder, searchFaq, requestRefund],
      maxTurns: 5, // Safety brake so the ReAct loop cannot run forever!
    });
    return text;
  },
);
