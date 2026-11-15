/**
 * Chapter 10: "'It Seems to Work' Is Not a Metric: Datasets" (LangSmith SDK version)
 *
 * Demonstrates the LangChain Academy "Datasets" module in TypeScript:
 *   1. Creating a versioned dataset in LangSmith (`client.createDataset`) with
 *      explicit JSON schemas for inputs and outputs.
 *   2. Adding examples (`client.createExamples`) from three sources:
 *        - Manually curated golden examples
 *        - Production traces (`source_run_id`)
 *        - Synthetic / edge-case examples assigned to specific `splits` (`smoke`, `regression`)
 *   3. Listing examples by split (`client.listExamples({ datasetName, splits: ['regression'] })`).
 *
 * Run in dry-run mode (no API key needed) or live against LangSmith:
 *   npx tsx src/ch10-datasets-langsmith.ts
 */
import { Client } from 'langsmith';

export interface DatasetSeedRow {
  id: string;
  inputs: {
    customerTier: 'free' | 'vip';
    question: string;
  };
  outputs: {
    expectedToolsCalled: string[];
    mustMentionFacts: string[];
    referenceAnswer: string;
  };
  split: 'smoke' | 'regression' | 'edge_case';
  source: 'manual_golden' | 'from_production_trace' | 'synthetic_edge_case';
}

export const INITIAL_DATASET_ROWS: DatasetSeedRow[] = [
  {
    id: 'row-01',
    inputs: { customerTier: 'free', question: 'Where is my order A-1001?' },
    outputs: {
      expectedToolsCalled: ['getOrder'],
      mustMentionFacts: ['A-1001', 'shipped', '59.9'],
      referenceAnswer: 'Your order A-1001 was shipped on 2026-11-10 and totals $59.90.',
    },
    split: 'smoke',
    source: 'manual_golden',
  },
  {
    id: 'row-02',
    inputs: {
      customerTier: 'vip',
      question: 'I bought order A-1002 74 days ago. As a VIP member, can I return it?',
    },
    outputs: {
      expectedToolsCalled: ['getOrderWithEligibility'],
      mustMentionFacts: ['90 days', 'eligible'],
      referenceAnswer: 'Yes, as a VIP customer you have a 90-day return window, so order A-1002 (74 days old) is eligible.',
    },
    split: 'regression',
    source: 'from_production_trace',
  },
  {
    id: 'row-03',
    inputs: { customerTier: 'free', question: 'Where is my order A-9999?' },
    outputs: {
      expectedToolsCalled: ['getOrder'],
      mustMentionFacts: ['not found'],
      referenceAnswer: 'I could not find an order with ID A-9999. Please double-check your order number.',
    },
    split: 'regression',
    source: 'from_production_trace',
  },
  {
    id: 'row-04',
    inputs: { customerTier: 'vip', question: 'Please apply promo code "vip50 " to my order A-1001.' },
    outputs: {
      expectedToolsCalled: ['applyPromoCode'],
      mustMentionFacts: ['50%', 'A-1001'],
      referenceAnswer: 'Promo code VIP50 (50% discount) has been applied to order A-1001.',
    },
    split: 'edge_case',
    source: 'synthetic_edge_case',
  },
];

export async function syncSupportDatasetToLangSmith(datasetName = 'store-support-golden-v1') {
  const client = new Client();

  // 1. Create (or fetch existing) dataset
  const existing = [];
  for await (const d of client.listDatasets({ datasetName })) {
    existing.push(d);
  }

  const dataset =
    existing[0] ??
    (await client.createDataset(datasetName, {
      description: 'Golden regression & smoke dataset for the online store support agent.',
      dataType: 'kv',
    }));

  // 2. Upload examples with splits and source metadata
  await client.createExamples(
    INITIAL_DATASET_ROWS.map((row) => ({
      dataset_id: dataset.id,
      inputs: row.inputs,
      outputs: row.outputs,
      split: row.split,
      metadata: { source: row.source },
    })),
  );

  return dataset;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== Golden Dataset Structure (Inputs, Reference Outputs & Splits) ===');
  console.table(
    INITIAL_DATASET_ROWS.map((r) => ({
      id: r.id,
      split: r.split,
      source: r.source,
      question: r.inputs.question.slice(0, 42) + (r.inputs.question.length > 42 ? '...' : ''),
      expectedTools: r.outputs.expectedToolsCalled.join(', '),
    })),
  );

  if (process.env.LANGSMITH_API_KEY) {
    const ds = await syncSupportDatasetToLangSmith();
    console.log(`Synced dataset "${ds.name}" (${ds.id}) to LangSmith.`);
  } else {
    console.log('\n(Tip: Set LANGSMITH_API_KEY to upload these examples to LangSmith live.)');
  }
}
