/**
 * Chapter 5: "Your First Trace with Genkit: The DevTools for Your Agent"
 *
 * Shows a fully instrumented Genkit agent where every building block
 * appears as its own distinct Span inside the Genkit Developer UI (`localhost:4000`):
 *   - `flow`:      observableSupportAgent
 *   - `custom`:    ai.run('normalize-query', ...)
 *   - `retriever`: storePolicyRetriever (via ai.defineSimpleRetriever + ai.retrieve)
 *   - `prompt`:    supportPrompt (via ai.definePrompt)
 *   - `model`:     googleai/gemini-2.5-flash
 *   - `tool`:      getOrderStatus
 *   - `output`:    Structured output validated by Zod (CustomerReplySchema)
 *
 * Run with Developer UI:
 *   export GEMINI_API_KEY=your_key
 *   npx genkit start -- npx tsx --watch src/ch05-genkit-devtools-trace.ts
 */
import { genkit, z } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-2.5-flash'),
});

// 1. Retriever: creates a dedicated `retriever` span in the trace tree
interface PolicyArticle {
  id: string;
  category: string;
  text: string;
}

const policyKnowledgeBase: PolicyArticle[] = [
  {
    id: 'pol-returns-2024',
    category: 'returns',
    // ⚠️ Intentional stale document to demonstrate RAG debugging in the trace!
    text: '[2024 Legacy Policy] Damaged items can be returned within 60 days with no restocking fee.',
  },
  {
    id: 'pol-returns-2026',
    category: 'returns',
    text: '[2026 Current Policy] Standard returns are accepted within 30 days of delivery. Damaged items must be reported within 14 days.',
  },
  {
    id: 'pol-shipping-2026',
    category: 'shipping',
    text: 'Orders with status "shipped" arrive within 3 to 5 business days.',
  },
];

export const storePolicyRetriever = ai.defineSimpleRetriever(
  {
    name: 'storePolicyRetriever',
    content: 'text',
    metadata: ['id', 'category'],
  },
  async (query) => {
    const q = query.text.toLowerCase();
    return policyKnowledgeBase.filter(
      (doc) => doc.text.toLowerCase().includes(q) || q.includes(doc.category) || q.includes('return'),
    );
  },
);

// 2. Tool: creates a dedicated `tool` span whenever the LLM invokes it
export const getOrderStatus = ai.defineTool(
  {
    name: 'getOrderStatus',
    description: 'Looks up the current status, delivery date, and total of an order by ID (format A-XXXX).',
    inputSchema: z.object({ orderId: z.string() }),
    outputSchema: z.object({
      found: z.boolean(),
      status: z.string().optional(),
      deliveredDate: z.string().optional(),
      total: z.number().optional(),
    }),
  },
  async ({ orderId }) => {
    const mockOrders: Record<string, { status: string; deliveredDate: string; total: number }> = {
      'A-1001': { status: 'shipped', deliveredDate: '2026-11-10', total: 59.9 },
      'A-1003': { status: 'delivered', deliveredDate: '2026-10-05', total: 15.5 }, // 40 days ago!
    };
    const match = mockOrders[orderId];
    return match ? { found: true, ...match } : { found: false };
  },
);

// 3. Structured output schema: ensures the model returns typed JSON (and logs schema validation in the trace)
const CustomerReplySchema = z.object({
  answer: z.string(),
  citedPolicyIds: z.array(z.string()).describe('IDs of the policy documents used to answer'),
  orderStatusChecked: z.boolean(),
});

// 4. Defined Prompt: creates a reusable `prompt` action visible in the Developer UI playground
export const supportPrompt = ai.definePrompt({
  name: 'supportPrompt',
  input: {
    schema: z.object({
      customerQuestion: z.string(),
    }),
  },
  output: {
    schema: CustomerReplySchema,
  },
  tools: [getOrderStatus],
  maxTurns: 4,
  system:
    'You are the customer support assistant of an online store. ' +
    'Base your policy answers strictly on the provided context documents and cite their IDs. ' +
    'If the user mentions an order ID, call getOrderStatus first.',
  messages: async (input) => [
    {
      role: 'user',
      content: [{ text: input.customerQuestion }],
    },
  ],
});

// 5. Root Flow: ties together custom steps, retrieval, prompt hydration, tool calls, and LLM generation
export const observableSupportAgent = ai.defineFlow(
  {
    name: 'observableSupportAgent',
    inputSchema: z.object({ question: z.string() }),
    outputSchema: CustomerReplySchema,
  },
  async ({ question }) => {
    // Custom step span
    const normalizedQuestion = await ai.run('normalize-query', question, async () => {
      return question.trim();
    });

    // Retriever span
    const docs = await ai.retrieve({
      retriever: storePolicyRetriever,
      query: normalizedQuestion,
    });

    // Prompt + Model + Tool loop + Output parser spans
    const { output } = await supportPrompt(
      { customerQuestion: normalizedQuestion },
      { docs },
    );

    if (!output) {
      throw new Error('Model failed to produce structured output matching CustomerReplySchema');
    }

    return output;
  },
);
