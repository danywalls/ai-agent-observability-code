/**
 * Chapter 2: "What an Agent REALLY Is" (LangChain v1 TypeScript version)
 *
 * The exact same support agent built with LangChain v1 (`createAgent`).
 * Under the hood, `createAgent` runs a ReAct loop powered by LangGraph,
 * passing an array of Messages (`SystemMessage`, `HumanMessage`, `AIMessage`, `ToolMessage`)
 * on every step.
 *
 * Run to inspect the message state step by step:
 *   export GOOGLE_API_KEY=your_key
 *   npx tsx src/ch02-react-loop-agent.ts
 */
import { createAgent, tool, HumanMessage, toolCallLimitMiddleware } from 'langchain';
import { z } from 'zod';

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
    schema: z.object({ orderId: z.string() }),
  },
);

// Tool 2: Search store policies (FAQ)
export const searchFaq = tool(
  async ({ query }) => {
    const q = query.toLowerCase();
    const matches = faqArticles.filter(
      (a) => a.topic.includes(q) || a.content.toLowerCase().includes(q) || q.includes('refund') || q.includes('return'),
    );
    return JSON.stringify(matches);
  },
  {
    name: 'searchFaq',
    description: 'Searches the store FAQ and policies about returns, refunds, and shipping times.',
    schema: z.object({ query: z.string() }),
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
      orderId: z.string(),
      reason: z.string(),
    }),
  },
);

export const agent = createAgent({
  model: 'google-genai:gemini-2.5-flash',
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
    console.log(`[${msg.getType()}]`, msg.content);
  }
}
