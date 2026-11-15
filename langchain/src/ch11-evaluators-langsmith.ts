/**
 * Chapter 11: "Evaluators: Code, LLM-as-a-Judge, and Their Traps" (LangSmith version)
 *
 * Implements the LangChain Academy "Evaluators" module in TypeScript:
 *   An Evaluator calculates metrics based on:
 *     - `inputs`           (from the Dataset Example)
 *     - `referenceOutputs` (from the Dataset Example)
 *     - `outputs`          (from the actual Agent Run)
 *
 * Includes both:
 *   1. Deterministic Code Evaluators (`mustMentionFactsEvaluator`, `noHallucinatedOrderIdEvaluator`)
 *   2. LLM-as-a-Judge Evaluator (`conciseAndAccurateJudge`) designed to avoid verbosity bias
 *      and numeric 1-10 scale noise.
 *
 * Run:
 *   npx tsx src/ch11-evaluators-langsmith.ts
 */
import type { EvaluationResult } from 'langsmith/evaluation';
import { z } from 'zod';

export interface EvaluatorArgs {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Deterministic Evaluator #1: Checks required facts against referenceOutputs
// ---------------------------------------------------------------------------
export async function mustMentionFactsEvaluator(args: EvaluatorArgs): Promise<EvaluationResult> {
  const actualAnswer = String(args.outputs.answer ?? '').toLowerCase();
  const requiredFacts = (args.referenceOutputs?.mustMentionFacts as string[] | undefined) ?? [];

  const missing = requiredFacts.filter((f) => !actualAnswer.includes(f.toLowerCase()));
  const score = requiredFacts.length === 0 ? 1 : (requiredFacts.length - missing.length) / requiredFacts.length;

  return {
    key: 'must_mention_facts',
    score: Number(score.toFixed(2)),
    comment:
      missing.length === 0
        ? 'All required reference facts present.'
        : `Missing facts: ${missing.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// 2. Deterministic Evaluator #2: Regex check for hallucinated order IDs
// ---------------------------------------------------------------------------
export async function noHallucinatedOrderIdEvaluator(args: EvaluatorArgs): Promise<EvaluationResult> {
  const userQuestion = String(args.inputs.question ?? '');
  const actualAnswer = String(args.outputs.answer ?? '');

  const inputOrderIds = new Set(userQuestion.match(/A-\d{4}/g) ?? []);
  const outputOrderIds = actualAnswer.match(/A-\d{4}/g) ?? [];

  const hallucinatedIds = outputOrderIds.filter((id) => !inputOrderIds.has(id));
  const passed = hallucinatedIds.length === 0;

  return {
    key: 'no_hallucinated_order_id',
    score: passed ? 1 : 0,
    comment: passed
      ? 'No invented order IDs detected.'
      : `Agent invented order IDs not in input: ${hallucinatedIds.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// 3. LLM-as-a-Judge Rubric Schema (avoids the 3 classic traps of LLM judges)
// ---------------------------------------------------------------------------
export const LlmJudgeGradeSchema = z.object({
  // Trap #1 fix: always generate reasoning BEFORE the verdict (Chain-of-Thought)
  stepByStepReasoning: z.string(),
  // Trap #2 fix: explicitly penalize contradictions and bloated filler text (verbosity bias)
  containsSelfContradiction: z.boolean(),
  // Trap #3 fix: use binary/boolean or 3-point rubric instead of noisy 1-10 scales
  matchesReferenceSemantics: z.boolean(),
});

export function scoreFromJudgeRubric(grade: z.infer<typeof LlmJudgeGradeSchema>): EvaluationResult {
  const passed = grade.matchesReferenceSemantics && !grade.containsSelfContradiction;
  return {
    key: 'semantic_accuracy_judge',
    score: passed ? 1 : 0,
    comment: grade.stepByStepReasoning,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sampleArgs: EvaluatorArgs = {
    inputs: { customerTier: 'vip', question: 'Where is my order A-1001?' },
    outputs: {
      answer: 'Your order A-1001 was shipped on 2026-11-10 ($59.9). Also check order A-7777!',
    },
    referenceOutputs: {
      mustMentionFacts: ['A-1001', 'shipped', '59.9'],
      referenceAnswer: 'Order A-1001 shipped on 2026-11-10 and totals $59.90.',
    },
  };

  console.log('Fact check:', await mustMentionFactsEvaluator(sampleArgs));
  console.log('Hallucination check:', await noHallucinatedOrderIdEvaluator(sampleArgs));
}
