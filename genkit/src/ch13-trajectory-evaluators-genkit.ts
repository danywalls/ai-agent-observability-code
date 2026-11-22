/**
 * Chapter 13: "Evaluating Agents, Not Just Answers: Trajectories, Tool Use, and Loops"
 * (Genkit version)
 *
 * Shows how to extract the tool execution trajectory from a Genkit `GenerateResponse`
 * (`response.messages`) and register a custom Genkit trajectory evaluator (`ai.defineEvaluator`)
 * that checks:
 *   1. Exact or subset tool trajectory match (`expectedToolsCalled`)
 *   2. No redundant / repeated tool calls with the same arguments (loop detection)
 *   3. Step budget (`maxAllowedToolCalls`)
 *
 * Run:
 *   npm run ch13
 */
import { genkit, type MessageData } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';

try {
  process.loadEnvFile?.();
} catch {
  // Optional .env file in genkit/
}

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-3-flash-preview'),
});

export interface ToolCallStep {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Helper to extract the ordered list of tool calls from Genkit's `response.messages`.
 */
export function extractGenkitToolTrajectory(messages: MessageData[]): ToolCallStep[] {
  const trajectory: ToolCallStep[] = [];
  for (const msg of messages) {
    if (msg.role === 'model') {
      for (const part of msg.content) {
        if (part.toolRequest) {
          trajectory.push({
            name: part.toolRequest.name,
            input: (part.toolRequest.input as Record<string, unknown>) ?? {},
          });
        }
      }
    }
  }
  return trajectory;
}

export const agentTrajectoryEvaluator = ai.defineEvaluator(
  {
    name: 'support/agentTrajectory',
    displayName: 'Agent Tool Trajectory & Loop Check',
    definition:
      'Verifies that the agent called the expected tools in order and did not get stuck calling the same tool repeatedly.',
    isBilled: false,
  },
  async (datapoint) => {
    const actualOutput = datapoint.output as {
      reply: string;
      toolTrajectory?: ToolCallStep[];
    };
    const reference = datapoint.reference as {
      expectedToolsCalled: string[];
      strictOrder?: boolean;
      maxToolCalls?: number;
    };

    const actualTools = (actualOutput?.toolTrajectory ?? []).map((t) => t.name);
    const expectedTools = reference?.expectedToolsCalled ?? [];
    const maxToolCalls = reference?.maxToolCalls ?? 4;

    // 1. Check for duplicate calls with identical name + arguments (loop smell!)
    const seenSignatures = new Set<string>();
    const duplicateCalls: string[] = [];
    for (const step of actualOutput?.toolTrajectory ?? []) {
      const sig = `${step.name}(${JSON.stringify(step.input)})`;
      if (seenSignatures.has(sig)) {
        duplicateCalls.push(sig);
      }
      seenSignatures.add(sig);
    }

    // 2. Check whether expected tools were called (in exact order or as a required subset)
    const orderMatches = reference?.strictOrder
      ? JSON.stringify(actualTools) === JSON.stringify(expectedTools)
      : expectedTools.every((expected) => actualTools.includes(expected));

    const withinBudget = actualTools.length <= maxToolCalls;
    const noLoops = duplicateCalls.length === 0;
    const passed = orderMatches && withinBudget && noLoops;

    const reasons: string[] = [];
    if (!orderMatches) {
      reasons.push(`Expected tools [${expectedTools.join(' -> ')}], got [${actualTools.join(' -> ')}]`);
    }
    if (!noLoops) {
      reasons.push(`Duplicate tool calls detected: ${duplicateCalls.join(', ')}`);
    }
    if (!withinBudget) {
      reasons.push(`Exceeded tool call budget: ${actualTools.length} > ${maxToolCalls}`);
    }

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score: passed ? 1 : 0,
        status: passed ? 'PASS' : 'FAIL',
        details: {
          reasoning: passed
            ? `Clean trajectory: [${actualTools.join(' -> ')}]`
            : reasons.join(' | '),
        },
      },
    };
  },
);

if (import.meta.url === `file://${process.argv[1]}` && process.env.GENKIT_ENV !== 'dev') {
  void (async () => {
    const results = await ai.evaluate({
      evaluator: agentTrajectoryEvaluator,
      dataset: [
        {
          testCaseId: 'traj-01-clean-refund-flow',
          input: { question: 'Refund order A-1003 please.' },
          output: {
            reply: 'Your refund REF-A-1003 has been processed.',
            toolTrajectory: [
              { name: 'getOrder', input: { orderId: 'A-1003' } },
              { name: 'searchFaq', input: { query: 'refund policy' } },
              { name: 'requestRefund', input: { orderId: 'A-1003', reason: 'customer request' } },
            ],
          },
          reference: {
            expectedToolsCalled: ['getOrder', 'searchFaq', 'requestRefund'],
            strictOrder: true,
            maxToolCalls: 4,
          },
        },
        {
          // ⚠️ Dangerous fail #1: "Lucky Guess / Skipped Verification": called requestRefund WITHOUT checking getOrder!
          testCaseId: 'traj-02-skipped-verification',
          input: { question: 'Refund order A-1003 please.' },
          output: {
            reply: 'Your refund REF-A-1003 has been processed.',
            toolTrajectory: [
              { name: 'requestRefund', input: { orderId: 'A-1003', reason: 'customer request' } },
            ],
          },
          reference: {
            expectedToolsCalled: ['getOrder', 'searchFaq', 'requestRefund'],
            strictOrder: true,
            maxToolCalls: 4,
          },
        },
        {
          // ⚠️ Dangerous fail #2: Agent got stuck calling getOrder 3 times with the exact same arguments!
          testCaseId: 'traj-03-redundant-loop',
          input: { question: 'Where is order A-1001?' },
          output: {
            reply: 'Your order A-1001 is shipped.',
            toolTrajectory: [
              { name: 'getOrder', input: { orderId: 'A-1001' } },
              { name: 'getOrder', input: { orderId: 'A-1001' } },
              { name: 'getOrder', input: { orderId: 'A-1001' } },
            ],
          },
          reference: {
            expectedToolsCalled: ['getOrder'],
            strictOrder: false,
            maxToolCalls: 2,
          },
        },
      ],
    });

    console.log('=== Genkit Trajectory Evaluation Results ===');
    for (const r of results) {
      console.log(r.testCaseId, '->', r.evaluation);
    }
  })().catch((err) => {
    console.error('Chapter 13 Genkit trajectory evaluation failed:', err);
    process.exit(1);
  });
}
