import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';
import { setCustomMetadataAttributes } from 'genkit/tracing';

/**
 * Chapter 17: Genkit Monitoring, Dashboards, and Alerts
 *
 * All code, variable names, and comments are in English.
 * Demonstrates:
 * 1. Enriching Genkit flows with custom production attributes (`setCustomMetadataAttributes`)
 *    for Firebase Genkit Monitoring, LangSmith Monitoring View, and Progress Observability.
 * 2. Computing the 4 Golden Signals for AI Agents in Production:
 *    - Latency Percentiles (P50, P95, P99) instead of misleading averages
 *    - Token & Cost Burn Rate (USD/hour by model and prompt version)
 *    - Error & Tool Failure Rate (%)
 *    - User Feedback & Online Evaluation Score Drift
 * 3. Evaluating SLO Alert Thresholds to detect silent regressions and cost spikes.
 */

// In production on Firebase / Google Cloud, enable telemetry export BEFORE defining flows:
// import { enableFirebaseTelemetry } from '@genkit-ai/firebase';
// enableFirebaseTelemetry({
//   forceDevExport: false,
//   metricExportIntervalMillis: 60_000,
// });

const ai = genkit({
  plugins: [googleAI()],
});

export const monitoredSupportFlow = ai.defineFlow(
  {
    name: 'monitoredSupportFlow',
    inputSchema: z.object({
      orderId: z.string(),
      customerTier: z.enum(['free', 'standard', 'vip']),
      promptVersion: z.string(),
      question: z.string(),
    }),
    outputSchema: z.object({
      answer: z.string(),
      traceMetadataAttached: z.boolean(),
    }),
  },
  async (input) => {
    // Attach custom business attributes to the current Genkit span so you can filter
    // and group dashboards in Firebase Genkit Monitoring and OpenTelemetry collectors
    setCustomMetadataAttributes({
      customer_tier: input.customerTier,
      prompt_version: input.promptVersion,
      order_id: input.orderId,
      feature_name: 'order_support_chat',
    });

    const stepResult = await ai.run('lookupOrderInDatabase', { orderId: input.orderId }, async () => {
      return {
        orderId: input.orderId,
        status: 'in_transit',
        carrier: 'DHL Express',
      };
    });

    return {
      answer: `Order ${stepResult.orderId} is currently ${stepResult.status} via ${stepResult.carrier}.`,
      traceMetadataAttached: true,
    };
  }
);

export interface ProductionWindowSample {
  traceId: string;
  latencyMs: number;
  ttftMs: number;
  totalTokens: number;
  costUsd: number;
  status: 'success' | 'error';
  model: string;
  promptVersion: string;
  userThumb?: 0 | 1;
  onlineGroundedness: 0 | 1;
}

export interface AgentDashboardSnapshot {
  totalRequests: number;
  latencyAvgMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  ttftP95Ms: number;
  errorRatePct: number;
  totalCostUsd: number;
  positiveThumbRatePct: number;
  groundednessRatePct: number;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  );
  return sortedValues[idx];
}

/**
 * Computes the 4 Golden Signals for an AI Agent monitoring dashboard.
 */
export function computeDashboardSnapshot(
  samples: ProductionWindowSample[]
): AgentDashboardSnapshot {
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const ttfts = samples.map((s) => s.ttftMs).sort((a, b) => a - b);
  const avgLatency =
    latencies.reduce((acc, v) => acc + v, 0) / Math.max(1, latencies.length);

  const errorCount = samples.filter((s) => s.status === 'error').length;
  const totalCostUsd = samples.reduce((acc, s) => acc + s.costUsd, 0);

  const ratedSamples = samples.filter((s) => s.userThumb !== undefined);
  const positiveThumbs = ratedSamples.filter((s) => s.userThumb === 1).length;

  const groundedCount = samples.filter((s) => s.onlineGroundedness === 1).length;

  return {
    totalRequests: samples.length,
    latencyAvgMs: Math.round(avgLatency),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyP99Ms: percentile(latencies, 99),
    ttftP95Ms: percentile(ttfts, 95),
    errorRatePct: Number(((errorCount / samples.length) * 100).toFixed(1)),
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    positiveThumbRatePct:
      ratedSamples.length > 0
        ? Number(((positiveThumbs / ratedSamples.length) * 100).toFixed(1))
        : 100,
    groundednessRatePct: Number(((groundedCount / samples.length) * 100).toFixed(1)),
  };
}

/**
 * Evaluates production SLO alert thresholds over the dashboard snapshot.
 */
export function evaluateSloAlerts(snapshot: AgentDashboardSnapshot): string[] {
  const alerts: string[] = [];

  if (snapshot.latencyP95Ms > 5000) {
    alerts.push(
      `[HIGH LATENCY SLO BREACH] P95 latency is ${snapshot.latencyP95Ms}ms (threshold: 5000ms). Note how average latency (${snapshot.latencyAvgMs}ms) hid the tail spike!`
    );
  }

  if (snapshot.errorRatePct > 2.0) {
    alerts.push(
      `[ERROR RATE SPIKE] Error rate is ${snapshot.errorRatePct}% (threshold: 2.0%). Check upstream tool and LLM 429 rate-limits.`
    );
  }

  if (snapshot.totalCostUsd > 0.05) {
    alerts.push(
      `[COST BURN ALERT] Window spend reached $${snapshot.totalCostUsd.toFixed(4)} (threshold: $0.0500). Check for runaway ReAct loops.`
    );
  }

  if (snapshot.groundednessRatePct < 90.0) {
    alerts.push(
      `[QUALITY DRIFT ALERT] Online groundedness dropped to ${snapshot.groundednessRatePct}% (threshold: 90.0%). Inspect latest prompt deployment.`
    );
  }

  return alerts;
}

async function main() {
  // 1. Run the instrumented Genkit flow locally
  const flowOutput = await monitoredSupportFlow({
    orderId: 'A-1001',
    customerTier: 'vip',
    promptVersion: 'v2.4',
    question: 'Where is my package?',
  });
  console.log('=== Instrumented Genkit Flow Result ===');
  console.log(JSON.stringify(flowOutput, null, 2));

  // 2. Simulate 20 production requests where 18 are fast (900ms) and 2 hit a runaway
  //    ReAct loop (9,200ms and 11,500ms) + 1 tool error
  const samples: ProductionWindowSample[] = Array.from({ length: 20 }, (_, i) => {
    const isTailSpike = i >= 18;
    const isError = i === 19;
    return {
      traceId: `trace_${i + 1}`,
      latencyMs: isTailSpike ? (i === 18 ? 9200 : 11500) : 850 + (i % 4) * 80,
      ttftMs: isTailSpike ? 1800 : 320,
      totalTokens: isTailSpike ? 8400 : 620,
      costUsd: isTailSpike ? 0.0185 : 0.0012,
      status: isError ? 'error' : 'success',
      model: 'gemini-2.5-flash',
      promptVersion: 'v2.4',
      userThumb: i % 5 === 0 ? (isTailSpike ? 0 : 1) : undefined,
      onlineGroundedness: i >= 17 ? 0 : 1,
    };
  });

  const snapshot = computeDashboardSnapshot(samples);
  console.log('\n=== Production Monitoring Dashboard Snapshot (Last 15m) ===');
  console.log(JSON.stringify(snapshot, null, 2));

  const activeAlerts = evaluateSloAlerts(snapshot);
  console.log('\n=== Triggered Production Alerts ===');
  for (const alert of activeAlerts) {
    console.log(`- ${alert}`);
  }
}

main().catch(console.error);
