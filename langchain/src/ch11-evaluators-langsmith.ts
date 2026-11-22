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
 *   2. LLM-as-a-Judge Evaluator (`semanticAccuracyJudge`) designed to avoid verbosity bias
 *      and numeric 1-10 scale noise.
 *
 * Run:
 *   npm run ch11   # Set GOOGLE_API_KEY or GEMINI_API_KEY to also run the live LLM judge
 */
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { EvaluationResult } from 'langsmith/evaluation';
import { z } from 'zod';

try {
  process.loadEnvFile?.();
} catch {
  // Optional .env file in langchain/
}

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

export async function semanticAccuracyJudge(args: EvaluatorArgs): Promise<EvaluationResult> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required to run semanticAccuracyJudge.');
  }

  const judgeModel = new ChatGoogleGenerativeAI({
    apiKey,
    model: 'gemini-3-flash-preview',
    temperature: 0,
  }).withStructuredOutput(LlmJudgeGradeSchema);

  const grade = await judgeModel.invoke(
    'You are a strict QA grader evaluating a customer support agent. Ignore length or politeness; grade strictly on factual alignment.\n' +
      `Customer Input: ${JSON.stringify(args.inputs)}\n` +
      `Reference Outputs: ${JSON.stringify(args.referenceOutputs ?? {})}\n` +
      `Agent Actual Output: ${JSON.stringify(args.outputs)}`,
  );

  return scoreFromJudgeRubric(grade);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
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

    console.log('Fact check (ex-01):', await mustMentionFactsEvaluator(sampleArgs));
    console.log('Hallucination check (ex-01):', await noHallucinatedOrderIdEvaluator(sampleArgs));

    // Contradictory VIP output from Chapter 3 ("90 days" + "eligible" substrings exist, yet meaning contradicts reference!)
    const contradictoryVipArgs: EvaluatorArgs = {
      inputs: {
        customerTier: 'vip',
        question: 'I bought order A-1002 74 days ago. As a VIP member, can I return it?',
      },
      outputs: {
        answer: 'You are VIP (90 days), but our system says order A-1002 is not eligible.',
      },
      referenceOutputs: {
        mustMentionFacts: ['90 days', 'eligible'],
        referenceAnswer:
          'Yes, as a VIP customer you have a 90-day return window, so order A-1002 (74 days old) is eligible.',
      },
    };

    console.log(
      '\nDeterministic fact check on contradictory VIP reply:',
      await mustMentionFactsEvaluator(contradictoryVipArgs),
    );

    if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
      console.log('Live LLM Judge on contradictory VIP reply:', await semanticAccuracyJudge(contradictoryVipArgs));
    } else {
      const simulatedJudge = scoreFromJudgeRubric({
        stepByStepReasoning:
          'Output mentions the 90-day VIP window yet rejects the 74-day order as not eligible, contradicting both itself and the reference.',
        containsSelfContradiction: true,
        matchesReferenceSemantics: false,
      });
      console.log('Offline LLM Judge rubric demo on contradictory VIP reply:', simulatedJudge);
    }
  })().catch((err) => {
    console.error('Chapter 11 LangSmith evaluation failed:', err);
    process.exit(1);
  });
}
