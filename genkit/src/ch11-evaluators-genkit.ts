/**
 * Chapter 11: "Evaluators: Code, LLM-as-a-Judge, and Their Traps" (Genkit version)
 *
 * Demonstrates registering two types of custom evaluators in Genkit using `ai.defineEvaluator`:
 *   1. Deterministic Code Evaluator (`mustMentionFactsEvaluator`): fast, free, 100% repeatable.
 *   2. LLM-as-a-Judge Evaluator (`semanticCorrectnessEvaluator`): uses a structured Zod rubric
 *      (`reasoning` BEFORE `passed`) to avoid the classic numeric-score trap.
 *
 * Run with Developer UI or CLI:
 *   export GEMINI_API_KEY=your_key
 *   npx tsx src/ch11-evaluators-genkit.ts
 */
import { genkit, z } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { supportGoldenDataset } from './ch10-golden-dataset.js';

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-2.5-flash'),
});

// ---------------------------------------------------------------------------
// 1. Deterministic Code Evaluator (zero LLM cost, instant, 100% reproducible)
// ---------------------------------------------------------------------------
export const mustMentionFactsEvaluator = ai.defineEvaluator(
  {
    name: 'support/mustMentionFacts',
    displayName: 'Must Mention Facts',
    definition: 'Checks that every mandatory fact in reference.mustMentionFacts appears in the output.',
    isBilled: false,
  },
  async (datapoint) => {
    const outputText = String(datapoint.output ?? '').toLowerCase();
    const reference = datapoint.reference as { mustMentionFacts?: string[] } | undefined;
    const requiredFacts = reference?.mustMentionFacts ?? [];

    const missing = requiredFacts.filter((fact) => !outputText.includes(fact.toLowerCase()));
    const passed = missing.length === 0;

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score: passed ? 1 : 0,
        status: passed ? 'PASS' : 'FAIL',
        details: {
          reasoning: passed
            ? `All ${requiredFacts.length} required facts were mentioned.`
            : `Missing required facts: ${missing.join(', ')}`,
        },
      },
    };
  },
);

// ---------------------------------------------------------------------------
// 2. LLM-as-a-Judge Evaluator (Structured Chain-of-Thought + Binary Pass/Fail)
// ---------------------------------------------------------------------------
const JudgeRubricSchema = z.object({
  // ⚠️ Best practice: always ask for step-by-step reasoning BEFORE the boolean verdict!
  reasoning: z
    .string()
    .describe('Brief explanation comparing the agent output against the reference facts and policy.'),
  passed: z
    .boolean()
    .describe('True ONLY if the agent output is factually consistent with the reference and does not contradict itself.'),
});

export const semanticCorrectnessEvaluator = ai.defineEvaluator(
  {
    name: 'support/semanticCorrectness',
    displayName: 'Semantic Policy Correctness (LLM Judge)',
    definition: 'Uses an LLM judge to verify factual consistency with the reference output.',
    isBilled: true,
  },
  async (datapoint) => {
    const { output } = await ai.generate({
      model: googleAI.model('gemini-2.5-flash'),
      config: { temperature: 0 }, // Always set temperature=0 on LLM judges!
      output: { schema: JudgeRubricSchema },
      prompt:
        'You are a strict QA grader evaluating a customer support agent.\n' +
        `Customer Input: ${JSON.stringify(datapoint.input)}\n` +
        `Reference Ground Truth: ${JSON.stringify(datapoint.reference)}\n` +
        `Agent Actual Output: ${String(datapoint.output)}\n\n` +
        'First write your reasoning, then set passed=true only if the agent output contains all reference facts and no contradictions.',
    });

    const passed = output?.passed ?? false;
    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score: passed ? 1 : 0,
        status: passed ? 'PASS' : 'FAIL',
        details: {
          reasoning: output?.reasoning ?? 'Judge failed to return structured output.',
        },
      },
    };
  },
);

if (import.meta.url === `file://${process.argv[1]}`) {
  // Run the deterministic code evaluator locally against two sample outputs
  const sampleEvalDataset = [
    {
      ...supportGoldenDataset[0],
      output: 'Your order A-1001 was shipped on Nov 10 and the total is $59.90.',
    },
    {
      ...supportGoldenDataset[1],
      // Contradictory VIP output from Chapter 3!
      output: 'You are VIP (90 days), but our system says order A-1002 is not eligible.',
    },
  ];

  const evalResults = await ai.evaluate({
    evaluator: mustMentionFactsEvaluator,
    dataset: sampleEvalDataset,
  });

  console.log('=== Genkit Deterministic Evaluator Results ===');
  for (const row of evalResults) {
    console.log(row.testCaseId, '->', row.evaluation);
  }
}
