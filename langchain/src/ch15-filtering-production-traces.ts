import { Client } from 'langsmith';

type ListRunsParams = Parameters<Client['listRuns']>[0];

/**
 * Chapter 15: Finding the Needle: Filtering Production Traces for Errors,
 * Slowness, and Bad Answers
 *
 * All code, variable names, and comments are in English.
 * Demonstrates:
 * 1. The 4 canonical LangSmith production filters:
 *    - `status = "error"` (`neq(error, null)`)
 *    - `feedback_score < X` (`and(eq(feedback_key, "user_thumb"), lt(feedback_score, 1))`)
 *    - `run_type = "llm" AND latency > X` (`and(eq(run_type, "llm"), gt(latency, 5))`)
 *    - `metadata["ls_model_name"] = X` (`has(metadata, '{"ls_model_name": "gpt-4o-mini"}')`)
 * 2. Combining `filter` (target run), `traceFilter` (root run), and `treeFilter`
 *    (any child/sibling run in the tree) to isolate complex multi-step agent bugs.
 * 3. Equivalent attribute filters in OpenTelemetry / Progress Observability Platform
 *    using `gen_ai.*` semantic conventions.
 */

export interface SimulatedSpan {
  id: string;
  traceId: string;
  isRoot: boolean;
  name: string;
  runType: 'chain' | 'llm' | 'tool';
  status: 'success' | 'error';
  latencySeconds: number;
  totalTokens?: number;
  metadata: Record<string, string>;
  tags: string[];
  feedback?: Record<string, number>;
  errorMessage?: string;
}

const langsmithClient = new Client();

/**
 * Canonical LangSmith `listRuns` filter configurations ready for production use.
 */
export const PRODUCTION_TRACE_FILTERS: Record<string, ListRunsParams> = {
  // 1. All root traces that ended in an unhandled exception or tool error
  erroredRootTraces: {
    projectName: 'support-agent-prod',
    isRoot: true,
    error: true,
    filter: 'neq(error, null)',
  },

  // 2. All root traces where the user gave a thumbs-down (user_thumb < 1)
  negativeUserFeedbackTraces: {
    projectName: 'support-agent-prod',
    isRoot: true,
    filter: 'and(eq(feedback_key, "user_thumb"), lt(feedback_score, 1))',
  },

  // 3. Slow LLM calls taking more than 4 seconds
  slowLlmCalls: {
    projectName: 'support-agent-prod',
    runType: 'llm',
    filter: 'and(eq(run_type, "llm"), gt(latency, 4))',
  },

  // 4. Filter by model name stored in metadata["ls_model_name"]
  specificModelRuns: {
    projectName: 'support-agent-prod',
    filter: 'has(metadata, "{\\"ls_model_name\\": \\"gpt-4o-mini\\"}")',
  },

  // 5. Hierarchical filter: Root traces with 👎 (traceFilter) that invoked `requestRefund`
  //    somewhere inside their execution tree (treeFilter) for VIP customers
  badRefundTracesForVip: {
    projectName: 'support-agent-prod',
    isRoot: true,
    filter: 'has(metadata, "{\\"customer_tier\\": \\"vip\\"}")',
    traceFilter: 'and(eq(feedback_key, "user_thumb"), eq(feedback_score, 0))',
    treeFilter: 'and(eq(run_type, "tool"), eq(name, "requestRefund"))',
  },
};

/**
 * Sample production spans representing 4 different traces in our online store support agent.
 */
const SAMPLE_PRODUCTION_SPANS: SimulatedSpan[] = [
  // Trace 1: Healthy, fast order status lookup (👍)
  {
    id: 'run_root_1',
    traceId: 'trace_1',
    isRoot: true,
    name: 'supportAgent',
    runType: 'chain',
    status: 'success',
    latencySeconds: 1.4,
    totalTokens: 520,
    metadata: { ls_model_name: 'gemini-2.5-flash', customer_tier: 'standard' },
    tags: ['prod', 'order-status'],
    feedback: { user_thumb: 1 },
  },
  // Trace 2: Slow LLM call during a complex multi-item inquiry
  {
    id: 'run_llm_2',
    traceId: 'trace_2',
    isRoot: false,
    name: 'ChatOpenAI',
    runType: 'llm',
    status: 'success',
    latencySeconds: 6.8,
    totalTokens: 6400,
    metadata: { ls_model_name: 'gpt-4o-mini', customer_tier: 'vip' },
    tags: ['prod'],
  },
  // Trace 3: VIP customer got a bad refund decision and clicked 👎
  {
    id: 'run_root_3',
    traceId: 'trace_3',
    isRoot: true,
    name: 'supportAgent',
    runType: 'chain',
    status: 'success',
    latencySeconds: 2.9,
    totalTokens: 1120,
    metadata: { ls_model_name: 'gpt-4o-mini', customer_tier: 'vip' },
    tags: ['prod', 'refund-flow'],
    feedback: { user_thumb: 0 },
  },
  {
    id: 'run_tool_3b',
    traceId: 'trace_3',
    isRoot: false,
    name: 'requestRefund',
    runType: 'tool',
    status: 'success',
    latencySeconds: 0.4,
    metadata: { ls_model_name: 'gpt-4o-mini', customer_tier: 'vip' },
    tags: ['prod'],
  },
  // Trace 4: Tool failure when the ERP API timed out
  {
    id: 'run_root_4',
    traceId: 'trace_4',
    isRoot: true,
    name: 'supportAgent',
    runType: 'chain',
    status: 'error',
    latencySeconds: 10.2,
    totalTokens: 410,
    metadata: { ls_model_name: 'gemini-2.5-flash', customer_tier: 'vip' },
    tags: ['prod'],
    errorMessage: 'ERPTimeoutError: GET /orders/A-1003 timed out after 10000ms',
  },
];

export async function queryLangSmithRuns(
  filterKey: keyof typeof PRODUCTION_TRACE_FILTERS,
  options: { dryRun?: boolean } = {}
): Promise<void> {
  const params = PRODUCTION_TRACE_FILTERS[filterKey];
  console.log(`\n=== Filter Preset: ${filterKey} ===`);
  console.log('LangSmith Query Params:', JSON.stringify(params, null, 2));

  if (!options.dryRun && process.env.LANGSMITH_API_KEY) {
    const runs: string[] = [];
    for await (const run of langsmithClient.listRuns({ ...params, limit: 5 })) {
      runs.push(`${run.id} (${run.name} - ${run.status})`);
    }
    console.log('Live Matching Runs:', runs);
  }
}

function runLocalFilterSimulation() {
  console.log('=== Running Local Production Trace Filter Simulation ===');

  // 1. Status = "error"
  const errored = SAMPLE_PRODUCTION_SPANS.filter((s) => s.status === 'error');
  console.log(
    `\n1. [Status = "error"] -> Matched ${errored.length} span(s):`,
    errored.map((s) => `${s.id} (${s.errorMessage})`)
  );

  // 2. Feedback score < 1
  const negativeFeedback = SAMPLE_PRODUCTION_SPANS.filter(
    (s) => s.isRoot && s.feedback?.user_thumb !== undefined && s.feedback.user_thumb < 1
  );
  console.log(
    `2. [Feedback score < 1] -> Matched ${negativeFeedback.length} root trace(s):`,
    negativeFeedback.map((s) => `${s.traceId} (tier=${s.metadata.customer_tier})`)
  );

  // 3. run_type = "llm" AND latency > 4s
  const slowLlms = SAMPLE_PRODUCTION_SPANS.filter(
    (s) => s.runType === 'llm' && s.latencySeconds > 4
  );
  console.log(
    `3. [run_type = "llm" AND latency > 4s] -> Matched ${slowLlms.length} LLM call(s):`,
    slowLlms.map(
      (s) => `${s.id} (model=${s.metadata.ls_model_name}, latency=${s.latencySeconds}s)`
    )
  );

  // 4. metadata["ls_model_name"] = "gpt-4o-mini"
  const gpt4oMiniRuns = SAMPLE_PRODUCTION_SPANS.filter(
    (s) => s.metadata.ls_model_name === 'gpt-4o-mini'
  );
  console.log(
    `4. [metadata["ls_model_name"] = "gpt-4o-mini"] -> Matched ${gpt4oMiniRuns.length} span(s):`,
    gpt4oMiniRuns.map((s) => `${s.id} (${s.name})`)
  );

  // 5. Hierarchical filter: Root VIP trace + user_thumb == 0 + child tool "requestRefund"
  const vipBadRefundTraces = SAMPLE_PRODUCTION_SPANS.filter((root) => {
    if (!root.isRoot) return false;
    const isVip = root.metadata.customer_tier === 'vip';
    const hasThumbDown = root.feedback?.user_thumb === 0;
    const calledRequestRefundInTree = SAMPLE_PRODUCTION_SPANS.some(
      (child) =>
        child.traceId === root.traceId &&
        child.runType === 'tool' &&
        child.name === 'requestRefund'
    );
    return isVip && hasThumbDown && calledRequestRefundInTree;
  });
  console.log(
    `5. [Hierarchical: VIP + 👎 + child tool "requestRefund"] -> Matched ${vipBadRefundTraces.length} trace(s):`,
    vipBadRefundTraces.map((s) => `${s.traceId} (root=${s.id})`)
  );
}

async function main() {
  runLocalFilterSimulation();

  for (const key of Object.keys(PRODUCTION_TRACE_FILTERS)) {
    await queryLangSmithRuns(key, { dryRun: true });
  }
}

main().catch(console.error);
