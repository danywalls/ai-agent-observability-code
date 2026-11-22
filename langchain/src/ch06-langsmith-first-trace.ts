/**
 * Chapter 6: "Your First Trace with LangChain + LangSmith"
 *
 * Shows the 4 ways to trace TypeScript code in LangSmith (matching the LangChain Academy
 * "Tracing Basics & Alternative Ways to Trace" module, adapted to TypeScript):
 *   1. Automatic LangChain/LangGraph tracing via env vars (`LANGSMITH_TRACING=true`)
 *   2. `traceable()` wrapper for custom functions (`retriever`, `chain`, `tool`, etc.)
 *   3. `RunTree` low-level API for explicit manual control over parent/child runs
 *   4. Runtime `tags` and `metadata` (including `thread_id`) passed on invocation
 *
 * Run (loads `.env` automatically if present):
 *   export GOOGLE_API_KEY=your_gemini_key
 *   export LANGSMITH_TRACING=true
 *   export LANGSMITH_API_KEY=your_langsmith_key
 *   export LANGSMITH_PROJECT=support-agent-dev
 *   npm run ch06
 */
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { createAgent, tool, HumanMessage } from 'langchain';
import { RunTree } from 'langsmith';
import { getCurrentRunTree, traceable } from 'langsmith/traceable';
import { z } from 'zod';

try {
  process.loadEnvFile?.();
} catch {
  // Optional .env file in langchain/
}

interface PolicyDoc {
  id: string;
  category: string;
  keywords: string[];
  text: string;
}

const activePolicies: PolicyDoc[] = [
  {
    id: 'pol-returns-2026',
    category: 'returns',
    keywords: ['return', 'refund', 'damaged', 'exchange'],
    text: 'Standard returns are accepted within 30 days of delivery. Damaged items must be reported within 14 days.',
  },
  {
    id: 'pol-shipping-2026',
    category: 'shipping',
    keywords: ['ship', 'shipping', 'deliver', 'delivery', 'transit'],
    text: 'Orders with status "shipped" arrive within 3 to 5 business days.',
  },
];

// 1. `traceable` with `run_type: 'retriever'` -> renders with a Retriever icon & document view in LangSmith
export const retrieveStorePolicies = traceable(
  async (input: { query: string }) => {
    const q = input.query.toLowerCase();
    return activePolicies
      .filter(
        (doc) =>
          doc.text.toLowerCase().includes(q) ||
          q.includes(doc.category) ||
          doc.keywords.some((kw) => q.includes(kw)),
      )
      .map((doc) => ({
        page_content: doc.text,
        type: 'Document',
        metadata: { id: doc.id, category: doc.category },
      }));
  },
  {
    name: 'retrieveStorePolicies',
    run_type: 'retriever',
    tags: ['rag', 'knowledge-base'],
  },
);

// 2. LangChain `tool` -> automatically traced as `run_type: 'tool'` inside `createAgent`
export const getOrderStatus = tool(
  async ({ orderId }) => {
    const mockOrders: Record<string, { status: string; deliveredDate: string; total: number }> = {
      'A-1001': { status: 'shipped', deliveredDate: '2026-11-10', total: 59.9 },
      'A-1003': { status: 'delivered', deliveredDate: '2026-10-05', total: 15.5 },
    };
    const match = mockOrders[orderId];
    return JSON.stringify(match ? { found: true, ...match } : { found: false });
  },
  {
    name: 'getOrderStatus',
    description: 'Looks up the current status, delivery date, and total of an order by ID (format A-XXXX).',
    schema: z.object({
      orderId: z.string().describe('Order identifier such as A-1003'),
    }),
  },
);

export const supportAgent = createAgent({
  model: 'google-genai:gemini-3-flash-preview',
  tools: [getOrderStatus],
  systemPrompt:
    'You are the customer support assistant of an online store. ' +
    'Base your policy answers strictly on the provided policy documents and call getOrderStatus when an order ID is mentioned.',
});

// 3. Top-level `traceable` workflow (`run_type: 'chain'`) that combines the retriever and the LangChain agent
//    under a single unified parent Trace.
export const runSupportWorkflow = traceable(
  async (input: {
    userId: string;
    customerTier: 'free' | 'vip';
    threadId: string;
    question: string;
  }) => {
    // Attach thread_id, user_id, and business tags to the ROOT run so LangSmith's Threads tab groups it
    const rootRun = getCurrentRunTree(true);
    if (rootRun) {
      rootRun.metadata = {
        ...rootRun.metadata,
        user_id: input.userId,
        customer_tier: input.customerTier,
        thread_id: input.threadId,
      };
      rootRun.tags = [...(rootRun.tags ?? []), `tier:${input.customerTier}`, 'channel:web'];
    }

    // Child Run #1: Retriever
    const docs = await retrieveStorePolicies({ query: input.question });
    const contextBlock = docs.map((d) => `[${d.metadata.id}] ${d.page_content}`).join('\n');

    // Child Run #2: LangGraph ReAct agent (inherits the active trace automatically!)
    const response = await supportAgent.invoke(
      {
        messages: [
          new HumanMessage(
            `Context documents:\n${contextBlock}\n\nCustomer question: ${input.question}`,
          ),
        ],
      },
      {
        // Runtime tags & metadata attached to the LangChain run and searchable in LangSmith
        tags: [`tier:${input.customerTier}`, 'channel:web'],
        metadata: {
          user_id: input.userId,
          customer_tier: input.customerTier,
          thread_id: input.threadId,
        },
      },
    );

    return {
      answer: response.messages.at(-1)?.content,
      retrievedDocIds: docs.map((d) => d.metadata.id),
    };
  },
  {
    name: 'runSupportWorkflow',
    run_type: 'chain',
  },
);

// 4. Alternative way to trace: explicit `RunTree` API (when you need manual lifecycle control)
export async function manualRunTreeExample(orderId: string) {
  const parentRun = new RunTree({
    name: 'manualOrderAudit',
    run_type: 'chain',
    inputs: { orderId },
    tags: ['manual-run-tree'],
  });
  await parentRun.postRun();

  const childToolRun = await parentRun.createChild({
    name: 'verifyWarehouseStock',
    run_type: 'tool',
    inputs: { orderId },
  });
  await childToolRun.postRun();

  await childToolRun.end({ outputs: { inStock: true, warehouse: 'MAD-01' } });
  await childToolRun.patchRun();

  await parentRun.end({ outputs: { auditPassed: true } });
  await parentRun.patchRun();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const result = await runSupportWorkflow({
      userId: 'usr_laura_42',
      customerTier: 'vip',
      threadId: 'thread-ch06-001',
      question: 'Can I return order A-1003?',
    });
    console.log('Support workflow result:', result);

    await manualRunTreeExample('A-1003');
    console.log('Manual RunTree audit trace submitted.');

    // Flush batched LangSmith runs before the CLI process exits
    await awaitAllCallbacks();
  })().catch((err) => {
    console.error('Chapter 6 execution failed:', err);
    process.exit(1);
  });
}
