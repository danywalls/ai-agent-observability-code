/**
 * Chapter 13: "Evaluating Agents, Not Just Answers: Trajectories, Tool Use, and Loops"
 * (LangChain v1 + LangSmith version)
 *
 * Shows how to evaluate the internal trajectory of a LangChain v1 (`createAgent`) run:
 *   1. Extracting `tool_calls` from `AIMessage` objects in the run's message history.
 *   2. Grading three trajectory modes:
 *        - Exact Order (`strict_order`): e.g. must call `getOrder` BEFORE `requestRefund`
 *        - Required Subset (`subset`): must have called at least the required tools
 *        - Tool Argument Accuracy: did it pass the right `orderId`?
 *   3. Detecting redundant loops (calling the same tool with identical args twice).
 *
 * Run:
 *   npx tsx src/ch13-trajectory-evaluators-langsmith.ts
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { EvaluationResult } from 'langsmith/evaluation';

export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Extracts every tool call requested by the model across a LangChain message state.
 */
export function extractLangChainToolCalls(messages: BaseMessage[]): RecordedToolCall[] {
  const calls: RecordedToolCall[] = [];
  for (const msg of messages) {
    if (msg instanceof AIMessage && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        calls.push({
          name: tc.name,
          args: (tc.args as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return calls;
}

/**
 * LangSmith multi-metric trajectory evaluator: returns 3 scores in one pass:
 *   - `trajectory_required_tools`: Did the agent call all required tools in the right order?
 *   - `trajectory_arg_accuracy`:   Did the first tool call use the expected `orderId`?
 *   - `trajectory_no_loops`:       Did the agent avoid repeating identical tool calls?
 */
export async function evaluateAgentTrajectory(args: {
  inputs: Record<string, unknown>;
  outputs: { messages?: BaseMessage[]; toolCalls?: RecordedToolCall[]; answer?: string };
  referenceOutputs?: {
    expectedToolsCalled?: string[];
    expectedOrderIdArg?: string;
    requireStrictOrder?: boolean;
  };
}): Promise<{ results: EvaluationResult[] }> {
  const recordedCalls =
    args.outputs.toolCalls ??
    (args.outputs.messages ? extractLangChainToolCalls(args.outputs.messages) : []);

  const actualToolNames = recordedCalls.map((c) => c.name);
  const expectedTools = args.referenceOutputs?.expectedToolsCalled ?? [];

  // Metric 1: Tool selection & ordering
  const toolsMatched = args.referenceOutputs?.requireStrictOrder
    ? JSON.stringify(actualToolNames) === JSON.stringify(expectedTools)
    : expectedTools.every((t) => actualToolNames.includes(t));

  // Metric 2: Tool argument accuracy (did it pass the right orderId?)
  const expectedOrderId = args.referenceOutputs?.expectedOrderIdArg;
  const argMatched = expectedOrderId
    ? recordedCalls.some((c) => c.args.orderId === expectedOrderId)
    : true;

  // Metric 3: Loop / duplicate call check
  const signatures = recordedCalls.map((c) => `${c.name}:${JSON.stringify(c.args)}`);
  const uniqueSignatures = new Set(signatures);
  const noDuplicateLoops = signatures.length === uniqueSignatures.size;

  return {
    results: [
      {
        key: 'trajectory_required_tools',
        score: toolsMatched ? 1 : 0,
        comment: `Expected [${expectedTools.join(' -> ')}], actual [${actualToolNames.join(' -> ')}]`,
      },
      {
        key: 'trajectory_arg_accuracy',
        score: argMatched ? 1 : 0,
        comment: expectedOrderId
          ? `Checked for orderId="${expectedOrderId}" in tool args`
          : 'No orderId arg check required',
      },
      {
        key: 'trajectory_no_loops',
        score: noDuplicateLoops ? 1 : 0,
        comment: noDuplicateLoops
          ? `No duplicate tool calls (${signatures.length} total)`
          : `Detected ${signatures.length - uniqueSignatures.size} duplicate tool call(s)`,
      },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Simulate a LangChain message state where the agent skipped `getOrder` and went straight to `requestRefund`
  const unsafeRefundMessages: BaseMessage[] = [
    new HumanMessage('Refund order A-1003 right now!'),
    new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'requestRefund', args: { orderId: 'A-1003', reason: 'requested' } },
      ],
    }),
    new ToolMessage({
      tool_call_id: 'call_1',
      content: '{"refundId":"REF-A-1003","approved":true}',
    }),
    new AIMessage('Your refund REF-A-1003 has been processed!'),
  ];

  const evalReport = await evaluateAgentTrajectory({
    inputs: { question: 'Refund order A-1003 right now!' },
    outputs: {
      messages: unsafeRefundMessages,
      answer: 'Your refund REF-A-1003 has been processed!',
    },
    referenceOutputs: {
      expectedToolsCalled: ['getOrder', 'searchFaq', 'requestRefund'],
      expectedOrderIdArg: 'A-1003',
      requireStrictOrder: true,
    },
  });

  console.log('=== LangSmith Trajectory Evaluation Report ===');
  console.table(evalReport.results);
}
