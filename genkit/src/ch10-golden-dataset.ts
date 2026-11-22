/**
 * Chapter 10: "'It Seems to Work' Is Not a Metric: Datasets" (Genkit version)
 *
 * Shows how to structure a Golden Dataset for Genkit (`BaseDataPoint` / `Dataset`)
 * combining:
 *   1. Happy-path examples
 *   2. Real bugs captured from production traces (e.g., VIP 90-day return window,
 *      lowercase promo codes, missing order IDs)
 *   3. Adversarial / edge-case examples
 *
 * Each example includes `testCaseId`, `input`, optional `reference` (expected ground truth
 * including both the expected tool trajectory and key facts), and `context`.
 *
 * Run to validate the dataset schema and print a split summary:
 *   npm run ch10
 */
import { z, BaseDataPointSchema } from 'genkit';

// Typed schema for our Support Agent dataset examples
export const SupportExampleInputSchema = z.object({
  customerTier: z.enum(['free', 'vip']),
  question: z.string(),
});

export const SupportExampleReferenceSchema = z.object({
  expectedToolsCalled: z.array(z.string()),
  mustMentionFacts: z.array(z.string()),
  mustNotAllowRefund: z.boolean().optional(),
  split: z.enum(['smoke', 'regression', 'edge_case']),
});

export interface SupportDatasetExample {
  testCaseId: string;
  input: z.infer<typeof SupportExampleInputSchema>;
  reference: z.infer<typeof SupportExampleReferenceSchema>;
  context?: string[];
}

export const supportGoldenDataset: SupportDatasetExample[] = [
  {
    testCaseId: 'ex-01-shipped-order-status',
    input: {
      customerTier: 'free',
      question: 'Where is my order A-1001?',
    },
    reference: {
      expectedToolsCalled: ['getOrder'],
      mustMentionFacts: ['A-1001', 'shipped', '59.9'],
      split: 'smoke',
    },
  },
  {
    // Captured from Chapter 3 production trace bug!
    testCaseId: 'ex-02-vip-74-days-return',
    input: {
      customerTier: 'vip',
      question: 'I bought order A-1002 74 days ago. As a VIP member, can I return it?',
    },
    reference: {
      expectedToolsCalled: ['getOrderWithEligibility'],
      mustMentionFacts: ['90 days', 'eligible'],
      mustNotAllowRefund: false,
      split: 'regression',
    },
  },
  {
    // Captured from Chapter 1 hallucination trace!
    testCaseId: 'ex-03-non-existent-order',
    input: {
      customerTier: 'free',
      question: 'Where is my order A-9999?',
    },
    reference: {
      expectedToolsCalled: ['getOrder'],
      mustMentionFacts: ['not found'],
      mustNotAllowRefund: true,
      split: 'regression',
    },
  },
  {
    // Captured from Chapter 9 lowercase promo code trace!
    testCaseId: 'ex-04-lowercase-promo-code',
    input: {
      customerTier: 'vip',
      question: 'Please apply promo code "vip50 " to my order A-1001.',
    },
    reference: {
      expectedToolsCalled: ['applyPromoCode'],
      mustMentionFacts: ['50%', 'A-1001'],
      split: 'edge_case',
    },
  },
];

// Validate every example against Genkit's BaseDataPointSchema
export function validateGenkitDataset(examples: SupportDatasetExample[]) {
  return examples.map((ex) => BaseDataPointSchema.parse(ex));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const validated = validateGenkitDataset(supportGoldenDataset);
  console.log(`Validated ${validated.length} Genkit dataset examples.`);
  console.table(
    supportGoldenDataset.map((ex) => ({
      testCaseId: ex.testCaseId,
      tier: ex.input.customerTier,
      split: ex.reference.split,
      expectedTools: ex.reference.expectedToolsCalled.join(', '),
    })),
  );
}
