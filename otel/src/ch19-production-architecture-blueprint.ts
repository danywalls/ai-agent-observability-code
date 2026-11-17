import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';

/**
 * Chapter 19: Production Architecture and Choosing Your Stack
 *
 * All code, variable names, and comments are in English.
 * Demonstrates:
 * 1. Configuring a production-hardened OpenTelemetry pipeline (`BatchSpanProcessor`
 *    with bounded memory queues and timeouts) exporting to the Progress Observability
 *    OpenTelemetry Collector or any OTLP-compliant backend.
 * 2. Modeling the 3-Layer Progress Observability Platform Architecture:
 *    - Layer 1: Application SDKs (TypeScript / Python / .NET)
 *    - Layer 2: Purpose-built OpenTelemetry Collector (API key validation, USD cost
 *      enrichment, user attribution)
 *    - Layer 3: Web Platform (Cost breakdowns, Automated Evaluation Tasks, Datasets &
 *      Experiments, MCP Server, and Agent Memory)
 * 3. A deterministic Stack Decision Engine across our 4 pillars:
 *    - Firebase Genkit + Genkit Monitoring
 *    - LangChain v1 + LangSmith
 *    - OpenTelemetry (`gen_ai.*`) + Progress Observability Platform
 */

export interface ProductionOtelConfig {
  serviceName: string;
  environment: 'development' | 'staging' | 'production';
  collectorUrl: string;
  progressApiKey?: string;
  captureMessageContent: boolean;
}

/**
 * Creates a non-blocking, production-hardened OpenTelemetry SDK configuration.
 * Notice how `BatchSpanProcessor` caps `maxQueueSize` and `exportTimeoutMillis`
 * so a collector network blip never blocks or crashes the agent HTTP server.
 */
export function createProductionOtelSdk(config: ProductionOtelConfig): {
  sdk: NodeSDK;
  summary: Record<string, string | number | boolean>;
} {
  const exporter = new OTLPTraceExporter({
    url: `${config.collectorUrl.replace(/\/$/, '')}/v1/traces`,
    headers: config.progressApiKey
      ? { Authorization: `Bearer ${config.progressApiKey}` }
      : {},
  });

  const batchProcessor = new BatchSpanProcessor({
    exporter,
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 3000,
  });

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    spanProcessors: [batchProcessor],
  });

  return {
    sdk,
    summary: {
      serviceName: config.serviceName,
      environment: config.environment,
      endpoint: `${config.collectorUrl.replace(/\/$/, '')}/v1/traces`,
      captureMessageContent: config.captureMessageContent,
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
    },
  };
}

export interface TeamRequirements {
  primaryFramework: 'genkit' | 'langchain' | 'mixed_or_custom';
  hostsOnFirebaseOrGcp: boolean;
  hasMultiLanguageServices: boolean; // e.g. TypeScript + Python + .NET
  needsCentralizedUsdCostEnrichment: boolean;
  wantsMcpServerForCodingAssistant: boolean;
}

export interface StackRecommendation {
  primaryStack: string;
  instrumentationLayer: string;
  evaluationAndMonitoringLayer: string;
  rationale: string[];
}

/**
 * Decision engine that recommends the optimal combination of our 4 pillars
 * based on a team's real-world constraints.
 */
export function recommendObservabilityStack(
  req: TeamRequirements
): StackRecommendation {
  // Scenario A: Multi-language or vendor-neutral OpenTelemetry + Progress Observability Platform
  if (
    req.hasMultiLanguageServices ||
    req.needsCentralizedUsdCostEnrichment ||
    req.wantsMcpServerForCodingAssistant
  ) {
    return {
      primaryStack: 'OpenTelemetry (gen_ai.*) + Progress Observability Platform',
      instrumentationLayer:
        'Genkit / LangChain / Custom TS, Python & .NET emitting OTel gen_ai.* spans to Progress OTel Collector',
      evaluationAndMonitoringLayer:
        'Progress Observability Web Platform (USD Cost Enrichment, Automated LLM-as-a-Judge Tasks, Datasets & MCP Server)',
      rationale: [
        'Progress OpenTelemetry Collector validates API keys and enriches every span with real-time USD cost and user attribution.',
        'Unifies TypeScript, Python, and .NET agents under a single OpenTelemetry gen_ai.* standard.',
        'Built-in MCP Server allows your AI coding assistant to query live production traces and cost bottlenecks directly from the IDE.',
      ],
    };
  }

  // Scenario B: Firebase / Google Cloud TypeScript team building with Genkit
  if (req.primaryFramework === 'genkit' && req.hostsOnFirebaseOrGcp) {
    return {
      primaryStack: 'Firebase Genkit + Firebase Genkit Monitoring',
      instrumentationLayer:
        'ai.defineFlow, ai.defineTool, ai.run + enableFirebaseTelemetry()',
      evaluationAndMonitoringLayer:
        'Genkit Developer UI (localhost:4000) in dev + Firebase Genkit Monitoring in prod',
      rationale: [
        'Zero-config local debugging with Genkit Developer UI and `ai.evaluate()` before deployment.',
        'Native export to Firebase Genkit Monitoring on Google Cloud with P50/P95 latency, token metrics, and step-level trace inspection.',
      ],
    };
  }

  // Scenario C: LangChain v1 TypeScript team needing deep agent workflows, HITL & Annotation Queues
  return {
    primaryStack: 'LangChain v1 + LangSmith',
    instrumentationLayer:
      'createAgent + middlewares (toolCallLimit, piiMiddleware, humanInTheLoop) + traceable()',
    evaluationAndMonitoringLayer:
      'LangSmith (Datasets, Side-by-Side Experiments, Annotation Queues, Online Evaluators & Automations)',
    rationale: [
      'Turnkey tracing for LangChain v1 `createAgent` ReAct loops, threads, and built-in security middlewares.',
      'Best-in-class Annotation Queues, hierarchical trace filters (`traceFilter` / `treeFilter`), and Chained Automations.',
    ],
  };
}

async function main() {
  // 1. Verify our production-hardened OTel SDK configuration
  const prodOtel = createProductionOtelSdk({
    serviceName: 'store-support-agent-ts',
    environment: 'production',
    collectorUrl: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    progressApiKey: 'prog_live_demo_key',
    captureMessageContent: false, // Privacy by default in production
  });

  console.log('=== 1. Production OpenTelemetry Batch Pipeline Config ===');
  console.log(JSON.stringify(prodOtel.summary, null, 2));

  // 2. Evaluate 3 real-world team profiles
  const profiles: Array<{ label: string; req: TeamRequirements }> = [
    {
      label: 'Profile 1: Full-Stack TS Team on Firebase using Genkit',
      req: {
        primaryFramework: 'genkit',
        hostsOnFirebaseOrGcp: true,
        hasMultiLanguageServices: false,
        needsCentralizedUsdCostEnrichment: false,
        wantsMcpServerForCodingAssistant: false,
      },
    },
    {
      label: 'Profile 2: Product AI Team using LangChain v1 with Human Review Queues',
      req: {
        primaryFramework: 'langchain',
        hostsOnFirebaseOrGcp: false,
        hasMultiLanguageServices: false,
        needsCentralizedUsdCostEnrichment: false,
        wantsMcpServerForCodingAssistant: false,
      },
    },
    {
      label: 'Profile 3: Enterprise Polyglot Team (TS + .NET + Python) with FinOps & MCP',
      req: {
        primaryFramework: 'mixed_or_custom',
        hostsOnFirebaseOrGcp: false,
        hasMultiLanguageServices: true,
        needsCentralizedUsdCostEnrichment: true,
        wantsMcpServerForCodingAssistant: true,
      },
    },
  ];

  console.log('\n=== 2. Stack Recommendations Across Our 4 Core Pillars ===');
  for (const profile of profiles) {
    const rec = recommendObservabilityStack(profile.req);
    console.log(`\n[${profile.label}]`);
    console.log(`  -> Recommended Stack: ${rec.primaryStack}`);
    console.log(`  -> Instrumentation : ${rec.instrumentationLayer}`);
    console.log(`  -> Monitoring/Eval : ${rec.evaluationAndMonitoringLayer}`);
    for (const reason of rec.rationale) {
      console.log(`     * ${reason}`);
    }
  }
}

main().catch(console.error);
