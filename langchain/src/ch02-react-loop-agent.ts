/**
 * Chapter 2: "What an Agent REALLY Is" (LangChain v1 TypeScript version)
 *
 * The exact same support agent built with LangChain v1 (`createAgent`).
 * Under the hood, `createAgent` runs a ReAct loop powered by LangGraph,
 * passing an array of Messages (`SystemMessage`, `HumanMessage`, `AIMessage`, `ToolMessage`)
 * on every step.
 *
 * Run to inspect the message state step by step:
 *   export GEMINI_API_KEY=your_key   # or GOOGLE_API_KEY
 *   npx tsx src/ch02-react-loop-agent.ts
 */
import { createAgent, tool, HumanMessage, toolCallLimitMiddleware } from 'langchain';
import { z } from 'zod';

// Load local .env if present (Node 20.12+) without overriding exported shell variables
try {
  process.loadEnvFile?.();
} catch {
  // No .env file present; rely on exported environment variables
}

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
export const getOrder = tool(
  async ({ orderId }) => {
    const order = orders[orderId];
    return JSON.stringify(order ? { found: true, ...order } : { found: false });
  },
  {
    name: 'getOrder',
    description: 'Returns the status, delivery/order date, item name and total of an order given its ID (format A-XXXX).',
    schema: z.object({
      orderId: z.string().describe('Order ID in format A-XXXX'),
    }),
  },
);

// Tool 2: Search store policies (FAQ)
export const searchFaq = tool(
  async ({ query }) => {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const matches = faqArticles.filter((a) => {
      const haystack = `${a.topic} ${a.content}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
    return JSON.stringify(matches);
  },
  {
    name: 'searchFaq',
    description: 'Searches the store FAQ and policies about returns, refunds, and shipping times.',
    schema: z.object({
      query: z.string().describe('Topic or keyword to search in store policies'),
    }),
  },
);

// Tool 3: Process a refund
export const requestRefund = tool(
  async ({ orderId, reason }) => {
    return JSON.stringify({
      refundId: `REF-${orderId}`,
      approved: true,
      message: `Refund processed for ${orderId} (reason: ${reason})`,
    });
  },
  {
    name: 'requestRefund',
    description:
      'Submits a refund for an order. Only call this AFTER verifying order status is "delivered" and checking the refund policy.',
    schema: z.object({
      orderId: z.string().describe('Order ID in format A-XXXX'),
      reason: z.string().describe('Short reason for the refund request'),
    }),
  },
);

export const agent = createAgent({
  model: 'google-genai:gemini-3-flash-preview',
  tools: [getOrder, searchFaq, requestRefund],
  systemPrompt:
    'You are the customer support assistant of an online store. ' +
    "Always check the order details and the store's refund policy before processing any refund. " +
    "Reply briefly in the customer's language.",
  // Safety brake so a runaway tool loop cannot run forever
  middleware: [toolCallLimitMiddleware({ runLimit: 5 })],
});

// Optional CLI runner: prints every message added to the state during the ReAct loop
if (import.meta.url === `file://${process.argv[1]}`) {
  const question = new HumanMessage('Hi, I want a refund for order A-1003 because the cable does not fit.');
  const result = await agent.invoke({ messages: [question] });

  for (const msg of result.messages) {
    const toolCalls =
      'tool_calls' in msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (toolCalls.length > 0) {
      console.log(
        `[${msg.getType()}] tool_calls:`,
        JSON.stringify(toolCalls.map((tc) => ({ name: tc.name, args: tc.args }))),
      );
    } else {
      console.log(
        `[${msg.getType()}]`,
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      );
    }
  }
}
