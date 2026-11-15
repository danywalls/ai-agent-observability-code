import { Client } from 'langsmith';

/**
 * Chapter 16: Online Evaluation and Automations
 *
 * All code, variable names, and comments are in English.
 * Demonstrates:
 * 1. The fundamental difference between Offline Evaluators (which have `referenceOutputs`)
 *    and Online Evaluators (which run on live production traces and ONLY have `inputs`,
 *    `outputs`, and tool `context`, with no `referenceOutputs`).
 * 2. Implementing the 4 classic Reference-Free Online Evaluators:
 *    - Hallucination / Groundedness against tool context (RAG / tool outputs)
 *    - Perceived Helpfulness to the user's question
 *    - Output Structure / Signature compliance
 *    - Executable / Valid Code or JSON syntax check
 * 3. Implementing the 5 Canonical Production Automation Rules:
 *    - Low-frequency random sampling (e.g. 5%) -> Annotation Queue
 *    - Negative user feedback (`user_thumb == 0`) -> Annotation Queue
 *    - Positive user feedback (`user_thumb == 1`) -> Golden Dataset
 *    - Error status (`status == "error"`) -> PagerDuty / Webhook alert
 *    - Chaining Online Evaluator score (`online_groundedness == 0`) -> Annotation Queue / Dataset
 */

export interface ProductionTraceRun {
  runId: string;
  traceId: string;
  status: 'success' | 'error';
  inputs: {
    customerMessage: string;
  };
  toolContext: string[]; // Facts returned by tools/retrievers during the run
  outputs?: {
    answer: string;
    generatedActionJson?: string;
  };
  userFeedbackScore?: 0 | 1;
  errorMessage?: string;
}

export interface OnlineEvaluationScores {
  online_groundedness: number; // 1 = grounded in toolContext, 0 = hallucinated facts
  online_helpfulness: number; // 1 = directly addresses question, 0 = evasive/unhelpful
  online_structure_valid: number; // 1 = includes required support sign-off & order ref
  online_json_compiles: number; // 1 = valid JSON action payload, 0 = syntax error
}

export type AutomationAction =
  | { type: 'ADD_TO_ANNOTATION_QUEUE'; queueName: string; reason: string }
  | { type: 'ADD_TO_GOLDEN_DATASET'; datasetName: string; reason: string }
  | { type: 'ALERT_PAGERDUTY_WEBHOOK'; severity: 'critical' | 'warning'; reason: string };

const langsmithClient = new Client();

/**
 * Step 1: Reference-Free Online Evaluators
 * Notice that `referenceOutputs` does NOT exist here: these run asynchronously
 * on real user traffic where no human has written a ground-truth answer yet.
 */
export function runReferenceFreeOnlineEvaluators(
  run: ProductionTraceRun
): OnlineEvaluationScores {
  const answer = run.outputs?.answer ?? '';
  const combinedContext = run.toolContext.join(' ').toLowerCase();

  // 1. Hallucination / Groundedness check:
  // Any dollar amount mentioned in the final answer must exist in toolContext
  const mentionedAmounts = answer.match(/\$\d+(\.\d{2})?/g) ?? [];
  const hasUnverifiedAmount = mentionedAmounts.some(
    (amount) => !combinedContext.includes(amount.replace('$', '').toLowerCase())
  );
  const online_groundedness = answer.length > 0 && !hasUnverifiedAmount ? 1 : 0;

  // 2. Perceived Helpfulness check:
  // Did the agent provide a substantive answer (> 30 chars) without generic brush-offs?
  const isBrushOff = /i don't know|cannot help with that|try again later/i.test(answer);
  const online_helpfulness = answer.length >= 30 && !isBrushOff ? 1 : 0;

  // 3. Structure check:
  // Support answers must mention the order ID from the prompt (if any) and end with our signature
  const orderMatch = run.inputs.customerMessage.match(/A-\d{4}/);
  const mentionsOrder = orderMatch ? answer.includes(orderMatch[0]) : true;
  const hasSupportSignature = answer.trim().endsWith('- Store Support AI');
  const online_structure_valid = mentionsOrder && hasSupportSignature ? 1 : 0;

  // 4. Code / JSON compilation check (for structured outputs or coding assistants)
  let online_json_compiles = 1;
  if (run.outputs?.generatedActionJson) {
    try {
      JSON.parse(run.outputs.generatedActionJson);
    } catch {
      online_json_compiles = 0;
    }
  }

  return {
    online_groundedness,
    online_helpfulness,
    online_structure_valid,
    online_json_compiles,
  };
}

/**
 * Step 2: The 5 Canonical Production Automation Rules
 * Evaluates a finished production run + its online evaluation scores and triggers
 * the appropriate downstream actions (Annotation Queue, Golden Dataset, or PagerDuty).
 */
export function evaluateAutomationRules(
  run: ProductionTraceRun,
  onlineScores: OnlineEvaluationScores,
  options: { randomSampleRoll: number; samplingRate: number } = {
    randomSampleRoll: 0.5,
    samplingRate: 0.05,
  }
): AutomationAction[] {
  const actions: AutomationAction[] = [];

  // Rule 1: Low-frequency random sampling across all traces -> Annotation Queue
  if (options.randomSampleRoll < options.samplingRate) {
    actions.push({
      type: 'ADD_TO_ANNOTATION_QUEUE',
      queueName: 'routine-5pct-audit-queue',
      reason: `Random sample (${options.samplingRate * 100}% audit rate)`,
    });
  }

  // Rule 2: Negative user feedback (👎) -> Annotation Queue
  if (run.userFeedbackScore === 0) {
    actions.push({
      type: 'ADD_TO_ANNOTATION_QUEUE',
      queueName: 'negative-feedback-triage-queue',
      reason: 'Customer gave negative feedback (user_thumb = 0)',
    });
  }

  // Rule 3: Positive user feedback (👍) AND 100% online eval pass -> Golden Dataset
  if (
    run.userFeedbackScore === 1 &&
    onlineScores.online_groundedness === 1 &&
    onlineScores.online_helpfulness === 1
  ) {
    actions.push({
      type: 'ADD_TO_GOLDEN_DATASET',
      datasetName: 'support-agent-golden-v1',
      reason: 'Customer gave 👍 and online evaluators verified groundedness',
    });
  }

  // Rule 4: Run status == "error" -> Alert PagerDuty / Webhook
  if (run.status === 'error') {
    actions.push({
      type: 'ALERT_PAGERDUTY_WEBHOOK',
      severity: 'critical',
      reason: `Unhandled production run error: ${run.errorMessage ?? 'Unknown error'}`,
    });
  }

  // Rule 5: Chained Automation: Online Evaluator detected a hallucination -> Annotation Queue
  if (run.status === 'success' && onlineScores.online_groundedness === 0) {
    actions.push({
      type: 'ADD_TO_ANNOTATION_QUEUE',
      queueName: 'hallucination-review-queue',
      reason: 'Chained Rule: online_groundedness scored 0 (unverified dollar amount in reply)',
    });
  }

  return actions;
}

/**
 * Helper to persist Online Evaluation scores back onto the LangSmith trace as feedback.
 */
export async function attachOnlineScoresToTrace(
  run: ProductionTraceRun,
  scores: OnlineEvaluationScores,
  options: { dryRun?: boolean } = {}
): Promise<void> {
  if (options.dryRun || !process.env.LANGSMITH_API_KEY) {
    return;
  }

  for (const [key, score] of Object.entries(scores)) {
    await langsmithClient.createFeedback(run.runId, key, {
      traceId: run.traceId,
      score,
      feedbackSourceType: 'model',
    });
  }
}

async function main() {
  const sampleProductionRuns: ProductionTraceRun[] = [
    // Run 1: Hallucinated a $199.00 compensation that was never in the tool output
    {
      runId: 'run_prod_101',
      traceId: 'trace_prod_101',
      status: 'success',
      inputs: { customerMessage: 'Where is my order A-1001?' },
      toolContext: [
        '{"orderId":"A-1001","status":"in_transit","totalUsd":89.99,"tracking":"TRK-99812"}',
      ],
      outputs: {
        answer:
          'Your order A-1001 is in transit (TRK-99812), and we have credited you $199.00 for the wait! - Store Support AI',
        generatedActionJson: '{"action":"none"}',
      },
    },
    // Run 2: Great grounded answer that received a 👍 from the customer
    {
      runId: 'run_prod_102',
      traceId: 'trace_prod_102',
      status: 'success',
      inputs: { customerMessage: 'Can you check the total on order A-1001?' },
      toolContext: [
        '{"orderId":"A-1001","status":"in_transit","totalUsd":89.99,"tracking":"TRK-99812"}',
      ],
      outputs: {
        answer:
          'Your order A-1001 has a total of $89.99 and is currently in transit with tracking TRK-99812. - Store Support AI',
        generatedActionJson: '{"action":"status_shared"}',
      },
      userFeedbackScore: 1,
    },
    // Run 3: Production error due to upstream database timeout
    {
      runId: 'run_prod_103',
      traceId: 'trace_prod_103',
      status: 'error',
      inputs: { customerMessage: 'Refund order A-1003 please' },
      toolContext: [],
      errorMessage: 'ConnectionterminatedError: Orders DB pool exhausted',
    },
  ];

  console.log('=== Chapter 16: Online Evaluation & Automations Pipeline ===');

  for (const run of sampleProductionRuns) {
    const scores = runReferenceFreeOnlineEvaluators(run);
    await attachOnlineScoresToTrace(run, scores, { dryRun: true });

    const triggeredActions = evaluateAutomationRules(run, scores, {
      randomSampleRoll: 0.25,
      samplingRate: 0.05,
    });

    console.log(`\nRun ${run.runId} (status=${run.status}):`);
    console.log('  Online Evaluator Scores:', JSON.stringify(scores));
    console.log(
      '  Triggered Automations:',
      triggeredActions.map((a) => `[${a.type}] -> ${a.reason}`)
    );
  }
}

main().catch(console.error);
