/**
 * Chapter 12: "Experiments: Changing the Prompt or Model Without Breaking Anything"
 *
 * Implements the LangChain Academy "Experiments & Analyzing Experiment Results" modules
 * in TypeScript using `evaluate()` from `langsmith/evaluation`:
 *   1. Running Agent v1 (baseline with the VIP 30-day bug and case-sensitive promo code)
 *      vs. Agent v2 (fixed VIP 90-day logic and normalized uppercase promo codes) over
 *      our Golden Dataset.
 *   2. Using `numRepetitions`, `maxConcurrency`, and `metadata` (prompt version, git SHA).
 *   3. Comparing side-by-side per-example regressions and enforcing a CI/CD quality gate.
 *
 * Works locally out of the box or syncs & uploads experiments live to LangSmith when
 * `LANGSMITH_API_KEY` is set.
 *
 * Run:
 *   npm run ch12
 */
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { evaluate } from 'langsmith/evaluation';
import { INITIAL_DATASET_ROWS, syncSupportDatasetToLangSmith } from './ch10-datasets-langsmith.js';
import {
  mustMentionFactsEvaluator,
  noHallucinatedOrderIdEvaluator,
} from './ch11-evaluators-langsmith.js';

try {
  process.loadEnvFile?.();
} catch {
  // Optional .env file in langchain/
}

export const GOLDEN_DATASET_NAME = 'store-support-golden-v1';

// ---------------------------------------------------------------------------
// Target 1: Agent v1 (Baseline: has the VIP 30-day bug & lowercase promo bug)
// ---------------------------------------------------------------------------
export async function runAgentV1Baseline(inputs: {
  customerTier: 'free' | 'vip';
  question: string;
}) {
  const q = inputs.question.toLowerCase();
  if (q.includes('a-1001') && q.includes('vip50')) {
    return {
      answer: 'Sorry, promo code "vip50 " is invalid.',
      toolsCalled: ['applyPromoCode'],
    };
  }
  if (q.includes('a-1001')) {
    return {
      answer: 'Your order A-1001 was shipped on 2026-11-10 and totals $59.90.',
      toolsCalled: ['getOrder'],
    };
  }
  if (q.includes('a-1002')) {
    // Bug from Chapter 3: rejects 74-day VIP return!
    return {
      answer: 'Your order A-1002 is 74 days old and past our 30-day window, so it cannot be returned.',
      toolsCalled: ['getOrderWithEligibility'],
    };
  }
  return {
    answer: 'I could not find that order (not found).',
    toolsCalled: ['getOrder'],
  };
}

// ---------------------------------------------------------------------------
// Target 2: Agent v2 (Candidate: fixes VIP 90-day rule & normalizes promo codes)
// ---------------------------------------------------------------------------
export async function runAgentV2Candidate(inputs: {
  customerTier: 'free' | 'vip';
  question: string;
}) {
  const q = inputs.question.toLowerCase();
  if (q.includes('a-1001') && q.includes('vip50')) {
    return {
      answer: 'Promo code VIP50 (50% discount) has been applied to your order A-1001!',
      toolsCalled: ['applyPromoCode'],
    };
  }
  if (q.includes('a-1001')) {
    return {
      answer: 'Your order A-1001 was shipped on 2026-11-10 and totals $59.90.',
      toolsCalled: ['getOrder'],
    };
  }
  if (q.includes('a-1002')) {
    return {
      answer: 'Because you are a VIP member with a 90 days return window, order A-1002 is eligible for a refund.',
      toolsCalled: ['getOrderWithEligibility'],
    };
  }
  return {
    answer: 'Order A-9999 was not found in our system.',
    toolsCalled: ['getOrder'],
  };
}

interface ExperimentRowSummary {
  exampleId: string;
  question: string;
  factsScore: number;
  noHallucinationScore: number;
}

// Run an experiment with `evaluate()` in LangSmith (or cleanly offline when no API key is set)
export async function runExperiment(
  experimentPrefix: string,
  targetFn: typeof runAgentV1Baseline,
  promptVersion: string,
) {
  const rows: ExperimentRowSummary[] = [];

  if (process.env.LANGSMITH_API_KEY) {
    await syncSupportDatasetToLangSmith(GOLDEN_DATASET_NAME);

    const results = await evaluate(targetFn, {
      data: GOLDEN_DATASET_NAME,
      evaluators: [mustMentionFactsEvaluator, noHallucinatedOrderIdEvaluator],
      experimentPrefix,
      numRepetitions: 1,
      maxConcurrency: 4,
      uploadRuns: true,
      metadata: {
        prompt_version: promptVersion,
        model: 'gemini-3-flash-preview',
        git_sha: process.env.GIT_SHA ?? 'local-dev',
      },
    });

    for (const row of results.results) {
      const evals = row.evaluationResults.results;
      const question = String(row.example.inputs.question);
      const matchedSeed = INITIAL_DATASET_ROWS.find((r) => r.inputs.question === question);
      rows.push({
        exampleId: matchedSeed?.id ?? row.example.id.slice(-4),
        question: question.slice(0, 38),
        factsScore: Number(evals.find((e) => e.key === 'must_mention_facts')?.score ?? 0),
        noHallucinationScore: Number(evals.find((e) => e.key === 'no_hallucinated_order_id')?.score ?? 0),
      });
    }
  } else {
    // Offline fallback: evaluate directly against INITIAL_DATASET_ROWS without uninitialized RunTree warnings
    for (const row of INITIAL_DATASET_ROWS) {
      const outputs = await targetFn(row.inputs);
      const args = { inputs: row.inputs, outputs, referenceOutputs: row.outputs };
      const factsEval = await mustMentionFactsEvaluator(args);
      const hallucinationEval = await noHallucinatedOrderIdEvaluator(args);
      rows.push({
        exampleId: row.id,
        question: row.inputs.question.slice(0, 38),
        factsScore: Number(factsEval.score ?? 0),
        noHallucinationScore: Number(hallucinationEval.score ?? 0),
      });
    }
  }

  rows.sort((a, b) => a.exampleId.localeCompare(b.exampleId));
  const avgFacts = rows.reduce((sum, r) => sum + r.factsScore, 0) / rows.length;
  return { rows, avgFacts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const expV1 = await runExperiment('support-agent-v1', runAgentV1Baseline, 'v1.0');
    const expV2 = await runExperiment('support-agent-v2', runAgentV2Candidate, 'v2.0');

    const sideBySide = expV1.rows.map((r1, idx) => {
      const r2 = expV2.rows[idx];
      const delta = r2.factsScore - r1.factsScore;
      return {
        example: r1.exampleId,
        question: r1.question,
        v1_facts: r1.factsScore,
        v2_facts: r2.factsScore,
        change: delta > 0 ? `+${delta} (IMPROVED)` : delta < 0 ? `${delta} (REGRESSED!)` : '0 (same)',
      };
    });

    console.log('=== Side-by-Side Experiment Comparison (v1 vs v2) ===');
    console.table(sideBySide);
    console.log(
      `Average Facts Score: v1=${(expV1.avgFacts * 100).toFixed(0)}% -> v2=${(expV2.avgFacts * 100).toFixed(0)}%`,
    );

    await awaitAllCallbacks();

    // CI/CD Quality Gate: fail the build if any example regressed or average < 95%
    const hasRegression = expV1.rows.some((r1, i) => expV2.rows[i].factsScore < r1.factsScore);
    if (hasRegression || expV2.avgFacts < 0.95) {
      console.error('❌ CI Quality Gate FAILED: regression detected or score below threshold.');
      process.exit(1);
    }
    console.log('✅ CI Quality Gate PASSED: ready to deploy v2 to production with confidence!');
  })().catch((err) => {
    console.error('Chapter 12 experiment failed:', err);
    process.exit(1);
  });
}
