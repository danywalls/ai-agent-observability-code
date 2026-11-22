import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { traceable } from 'langsmith/traceable';

try {
  process.loadEnvFile?.();
} catch {
  // Optional .env file in langchain/
}

export interface EvalCaseResult {
  id: string;
  baselineScore: number;
  candidateScore: number;
  latencyMs: number;
  costUsd: number;
}

export interface GateThresholds {
  minAvgQuality: number;
  maxRegressionPerExample: number;
  maxP95LatencyMs: number;
  maxAvgCostUsd: number;
}

export const THRESHOLDS: GateThresholds = {
  minAvgQuality: 0.85,
  maxRegressionPerExample: 0.15,
  maxP95LatencyMs: 2500,
  maxAvgCostUsd: 0.012,
};

export function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

export const runCandidateEvaluation = traceable(
  async (promptVersion: string): Promise<EvalCaseResult[]> => {
    // Simulated deterministic evaluation dataset aligned with Chapter 12 CI/CD gate
    const baseCases: EvalCaseResult[] = [
      { id: 'vip-refund-90d', baselineScore: 0.94, candidateScore: 0.96, latencyMs: 1120, costUsd: 0.0042 },
      { id: 'damaged-item-photo', baselineScore: 0.91, candidateScore: 0.93, latencyMs: 1480, costUsd: 0.0051 },
      { id: 'expired-window-polite', baselineScore: 0.88, candidateScore: 0.90, latencyMs: 980, costUsd: 0.0038 },
      { id: 'prompt-injection-guard', baselineScore: 0.98, candidateScore: 0.99, latencyMs: 840, costUsd: 0.0031 },
      { id: 'multi-item-partial-credit', baselineScore: 0.87, candidateScore: 0.89, latencyMs: 1890, costUsd: 0.0064 },
    ];

    if (promptVersion === 'regress') {
      baseCases[2].candidateScore = 0.61;
      baseCases[4].latencyMs = 3150;
    }

    return baseCases;
  },
  { name: 'ci_eval_gate_runner', run_type: 'chain' },
);

export async function main() {
  const promptVersion = process.env.PROMPT_VERSION ?? 'v2';
  const results = await runCandidateEvaluation(promptVersion);

  const avgBaseline = results.reduce((sum, r) => sum + r.baselineScore, 0) / results.length;
  const avgCandidate = results.reduce((sum, r) => sum + r.candidateScore, 0) / results.length;
  const p95LatencyMs = percentile95(results.map((r) => r.latencyMs));
  const avgCostUsd = results.reduce((sum, r) => sum + r.costUsd, 0) / results.length;
  const regressions = results.filter(
    (r) => r.baselineScore - r.candidateScore > THRESHOLDS.maxRegressionPerExample,
  );

  const passed =
    avgCandidate >= THRESHOLDS.minAvgQuality &&
    regressions.length === 0 &&
    p95LatencyMs <= THRESHOLDS.maxP95LatencyMs &&
    avgCostUsd <= THRESHOLDS.maxAvgCostUsd;

  const summaryLines = [
    '### Agent Evaluation Gate Summary',
    '',
    '| Metric | Baseline | Candidate | Threshold | Status |',
    '|---|---:|---:|---:|---|',
    `| Avg Quality | ${avgBaseline.toFixed(3)} | ${avgCandidate.toFixed(3)} | >= ${THRESHOLDS.minAvgQuality.toFixed(2)} | ${avgCandidate >= THRESHOLDS.minAvgQuality ? 'PASS' : 'FAIL'} |`,
    `| P95 Latency | - | ${p95LatencyMs} ms | <= ${THRESHOLDS.maxP95LatencyMs} ms | ${p95LatencyMs <= THRESHOLDS.maxP95LatencyMs ? 'PASS' : 'FAIL'} |`,
    `| Avg Cost / Run | - | $${avgCostUsd.toFixed(4)} | <= $${THRESHOLDS.maxAvgCostUsd.toFixed(4)} | ${avgCostUsd <= THRESHOLDS.maxAvgCostUsd ? 'PASS' : 'FAIL'} |`,
    `| Per-Example Regressions | 0 | ${regressions.length} | 0 | ${regressions.length === 0 ? 'PASS' : 'FAIL'} |`,
  ];

  console.log(summaryLines.join('\n'));
  await awaitAllCallbacks();

  if (!passed) {
    console.error('\nGate failed: regression or budget breach detected.');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error('Chapter 12 CI gate failed:', err);
    process.exit(1);
  });
}
