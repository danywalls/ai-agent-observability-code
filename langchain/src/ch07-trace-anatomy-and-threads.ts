/**
 * Chapter 7: "Anatomy of a Trace: Run Types, Metadata, Tags, and Threads"
 *
 * Demonstrates all 6 canonical Run types from LangChain Academy ("Types of Runs"):
 *   1. `prompt`:    Hydrates a prompt template with variables
 *   2. `retriever`: Retrieves documents from a knowledge base
 *   3. `llm`:       Invokes a language model (with token & model metadata)
 *   4. `tool`:      Executes an action / function call
 *   5. `parser`:    Extracts structured data (Zod validation)
 *   6. `chain`:     Default orchestrator combining multiple runs
 *
 * Also demonstrates grouping multi-turn conversations into a single **Thread**
 * using `thread_id` (or `session_id` / `conversation_id`) inside `metadata`.
 *
 * Run:
 *   export GOOGLE_API_KEY=your_gemini_key
 *   export LANGSMITH_TRACING=true
 *   export LANGSMITH_API_KEY=your_langsmith_key
 *   npx tsx src/ch07-trace-anatomy-and-threads.ts
 */
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { getCurrentRunTree, traceable } from 'langsmith/traceable';
import { z } from 'zod';

// Simple in-memory thread store so Turn 2 remembers Turn 1
const threadHistoryStore = new Map<string, BaseMessage[]>();

// 1. Run type: `prompt`: hydrates a template into system + user instructions
export const hydrateSupportPrompt = traceable(
  async (input: { customerTier: 'free' | 'vip'; contextDocs: string[]; question: string }) => {
    const returnWindow = input.customerTier === 'vip' ? '90 days' : '30 days';
    return {
      systemPrompt:
        `You are a store support assistant. Customer tier: ${input.customerTier} (${returnWindow} return window).\n` +
        `Relevant policies:\n${input.contextDocs.join('\n')}`,
      userPrompt: input.question,
    };
  },
  { name: 'hydrateSupportPrompt', run_type: 'prompt' },
);

// 2. Run type: `retriever`: fetches documents from a database or vector index
export const fetchPolicyDocuments = traceable(
  async (input: { query: string }) => {
    return [
      {
        page_content: 'Orders in "delivered" status can be returned within the customer tier window.',
        type: 'Document',
        metadata: { id: 'pol-returns-2026', source: 'handbook.pdf' },
      },
    ];
  },
  { name: 'fetchPolicyDocuments', run_type: 'retriever' },
);

// 3. Run type: `tool`: executes an external action or lookup
export const lookupOrderInDb = traceable(
  async (input: { orderId: string }) => {
    const db: Record<string, { status: string; item: string; total: number }> = {
      'A-1003': { status: 'delivered', item: 'USB-C Cable', total: 15.5 },
    };
    return db[input.orderId] ?? { status: 'not_found', item: 'none', total: 0 };
  },
  { name: 'lookupOrderInDb', run_type: 'tool' },
);

// 4. Run type: `llm`: invokes an LLM (or wraps a custom/SDK model call with usage metadata)
export const callLanguageModel = traceable(
  async (input: {
    messages: { role: string; content: string }[];
    orderContext?: { status: string; item: string; total: number };
  }) => {
    // Simulated raw JSON string returned by the model so the example can run even offline
    const rawJsonText = JSON.stringify({
      reply: input.orderContext
        ? `Your order for ${input.orderContext.item} ($${input.orderContext.total}) is ${input.orderContext.status}.`
        : 'Please share your order ID so I can check it.',
      intent: 'order_status',
      requiresHumanEscalation: false,
    });

    return {
      content: rawJsonText,
      // Standard LangSmith usage_metadata so token counters & costs are populated on custom `llm` runs
      usage_metadata: {
        input_tokens: 185,
        output_tokens: 42,
        total_tokens: 227,
      },
    };
  },
  {
    name: 'callLanguageModel',
    run_type: 'llm',
    metadata: {
      ls_provider: 'google_genai',
      ls_model_name: 'gemini-2.5-flash',
      ls_model_type: 'chat',
    },
  },
);

// 5. Run type: `parser`: validates and extracts structured data from raw model text
const ParsedResponseSchema = z.object({
  reply: z.string(),
  intent: z.enum(['order_status', 'refund_request', 'general']),
  requiresHumanEscalation: z.boolean(),
});

export const parseModelJson = traceable(
  async (input: { rawText: string }) => {
    return ParsedResponseSchema.parse(JSON.parse(input.rawText));
  },
  { name: 'parseModelJson', run_type: 'parser' },
);

// 6. Run type: `chain`: default orchestrator combining all steps and grouping turns into a Thread
export const handleConversationTurn = traceable(
  async (input: {
    threadId: string;
    userId: string;
    customerTier: 'free' | 'vip';
    message: string;
  }) => {
    // Attach dynamic runtime metadata (including thread_id) and tags to the active RunTree
    const runTree = getCurrentRunTree(true);
    if (runTree) {
      runTree.metadata = {
        ...runTree.metadata,
        thread_id: input.threadId,
        user_id: input.userId,
        customer_tier: input.customerTier,
      };
      runTree.tags = [...(runTree.tags ?? []), `tier:${input.customerTier}`, 'env:local'];
    }

    const history = threadHistoryStore.get(input.threadId) ?? [];

    // Step A: Retriever run
    const docs = await fetchPolicyDocuments({ query: input.message });

    // Step B: Prompt run
    const hydrated = await hydrateSupportPrompt({
      customerTier: input.customerTier,
      contextDocs: docs.map((d) => d.page_content),
      question: input.message,
    });

    // Step C: Optional Tool run if an order ID (A-XXXX) appears in the current message or thread history
    const fullConversationText = [...history.map((m) => String(m.content)), input.message].join(' ');
    const orderMatch = fullConversationText.match(/A-\d{4}/);
    const orderContext = orderMatch ? await lookupOrderInDb({ orderId: orderMatch[0] }) : undefined;

    // Step D: LLM run
    const llmResult = await callLanguageModel({
      messages: [
        { role: 'system', content: hydrated.systemPrompt },
        ...history.map((m) => ({ role: m.getType(), content: String(m.content) })),
        { role: 'user', content: hydrated.userPrompt },
      ],
      orderContext,
    });

    // Step E: Parser run
    const parsed = await parseModelJson({ rawText: llmResult.content });

    // Save turn to thread memory
    history.push(new HumanMessage(input.message));
    history.push(new AIMessage(parsed.reply));
    threadHistoryStore.set(input.threadId, history);

    return parsed;
  },
  {
    name: 'handleConversationTurn',
    run_type: 'chain',
  },
);

if (import.meta.url === `file://${process.argv[1]}`) {
  const sharedThreadId = 'thread-frank-001';

  // Turn 1
  const turn1 = await handleConversationTurn({
    threadId: sharedThreadId,
    userId: 'usr_frank',
    customerTier: 'vip',
    message: 'Hi! Can you check my order A-1003?',
  });
  console.log('Turn 1:', turn1);

  // Turn 2 (same threadId -> grouped into the same Thread in LangSmith!)
  const turn2 = await handleConversationTurn({
    threadId: sharedThreadId,
    userId: 'usr_frank',
    customerTier: 'vip',
    message: 'And how much did I pay for that order?',
  });
  console.log('Turn 2:', turn2);
}
