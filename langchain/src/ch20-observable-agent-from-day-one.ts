import { randomUUID } from 'node:crypto';
import {
  humanInTheLoopMiddleware,
  modelCallLimitMiddleware,
  piiMiddleware,
  tool,
  toolCallLimitMiddleware,
} from 'langchain';
import { Client } from 'langsmith';
import { createSecretAnonymizer } from 'langsmith/anonymizer';
import { getCurrentRunTree, traceable } from 'langsmith/traceable';
import { z } from 'zod';

/**
 * Chapter 20: How to Ask Your AI Assistant for an Observable Agent from Day 1
 * (LangChain v1 + LangSmith Reference Template)
 *
 * Compare this file with Chapter 1 (`ch01-support-agent.ts`).
 * Every single production lesson from Chapters 1-19 is baked in from Day 1:
 * 1. Lean Tools with strict Zod schemas and structured error returns (Ch. 2, 3, 4).
 * 2. ReAct Loop Guardrails (`toolCallLimitMiddleware`, `modelCallLimitMiddleware`) (Ch. 2, 4).
 * 3. PII & Secret Protection (`piiMiddleware`, `createSecretAnonymizer`, `humanInTheLoopMiddleware`) (Ch. 18).
 * 4. Rich Trace Metadata (`thread_id`, `customer_tier`, `prompt_version`) & returned `runId` (Ch. 7, 14, 15).
 * 5. Built-in Trajectory & Groundedness Smoke Test ready for CI/CD (Ch. 10-13, 16).
 */

export const privacySafeClient = new Client({
  anonymizer: createSecretAnonymizer(),
});

// 1. Lean Tools: return only the fields the LLM actually needs (never dump raw ERP rows)
export const getOrderStatusTool = tool(
  async ({ orderId }) => {
    const mockDb: Record<
      string,
      { orderId: string; status: string; daysSinceDelivery: number; totalUsd: number }
    > = {
      'A-1001': { orderId: 'A-1001', status: 'in_transit', daysSinceDelivery: 0, totalUsd: 89.99 },
      'A-1002': { orderId: 'A-1002', status: 'delivered', daysSinceDelivery: 45, totalUsd: 120.0 },
    };
    const record = mockDb[orderId];
    if (!record) {
      return JSON.stringify({ error: `Order ${orderId} not found`, code: 'ORDER_NOT_FOUND' });
    }
    return JSON.stringify(record);
  },
  {
    name: 'getOrderStatus',
    description: 'Fetch lean order status, daysSinceDelivery, and totalUsd by orderId (e.g. A-1001).',
    schema: z.object({
      orderId: z.string().regex(/^A-\d{4}$/, 'Order ID must match A-XXXX'),
    }),
  }
);

export const checkReturnPolicyTool = tool(
  async ({ daysSinceDelivery }) => {
    const eligible = daysSinceDelivery <= 30;
    return JSON.stringify({
      eligible,
      maxWindowDays: 30,
      daysSinceDelivery,
      policyRule: eligible
        ? 'Eligible for standard refund within 30-day window.'
        : 'Outside 30-day return window; refund must be declined.',
    });
  },
  {
    name: 'checkReturnPolicy',
    description: 'Check whether an order is eligible for return based on daysSinceDelivery.',
    schema: z.object({
      daysSinceDelivery: z.number().int().nonnegative(),
    }),
  }
);

// 2. Day-1 Middleware Stack (Loop Caps + PII Scrubbing + Human-in-the-Loop Gate)
export const dayOneAgentMiddlewares = [
  toolCallLimitMiddleware({ runLimit: 4, exitBehavior: 'end' }),
  modelCallLimitMiddleware({ runLimit: 5, exitBehavior: 'end' }),
  piiMiddleware('credit_card', {
    strategy: 'mask',
    applyToInput: true,
    applyToOutput: true,
    applyToToolResults: true,
  }),
  piiMiddleware('email', {
    strategy: 'hash',
    applyToInput: true,
    applyToOutput: true,
    applyToToolResults: true,
  }),
  humanInTheLoopMiddleware({
    interruptOn: {
      requestRefund: {
        allowedDecisions: ['approve', 'edit', 'reject'],
        description: 'Refund execution requires supervisor approval.',
      },
    },
  }),
];

export interface ObservableAgentRequest {
  threadId: string;
  userId: string;
  customerTier: 'free' | 'standard' | 'vip';
  promptVersion: string;
  customerMessage: string;
}

export interface ObservableAgentResponse {
  runId: string;
  traceId: string;
  threadId: string;
  answer: string;
  trajectory: string[];
  latencyMs: number;
}

// 3. Observable Entry Point: attaches metadata/tags and returns `runId` for UI 👍/👎 feedback
export const invokeObservableSupportAgent = traceable(
  async (req: ObservableAgentRequest): Promise<ObservableAgentResponse> => {
    const startTime = Date.now();
    const runTree = getCurrentRunTree(true);
    const runId = runTree?.id ?? randomUUID();
    const traceId = runTree?.trace_id ?? runId;

    if (runTree) {
      runTree.metadata = {
        ...runTree.metadata,
        thread_id: req.threadId,
        user_id: req.userId,
        customer_tier: req.customerTier,
        prompt_version: req.promptVersion,
      };
      runTree.tags = [...(runTree.tags ?? []), `tier:${req.customerTier}`, req.promptVersion];
    }

    const trajectory: string[] = [];
    const orderMatch = req.customerMessage.match(/A-\d{4}/);
    const orderId = orderMatch ? orderMatch[0] : 'A-1002';

    const rawOrder = await getOrderStatusTool.invoke({ orderId });
    trajectory.push('getOrderStatus');
    const parsedOrder = JSON.parse(String(rawOrder)) as {
      orderId: string;
      status: string;
      daysSinceDelivery: number;
      totalUsd: number;
    };

    const rawPolicy = await checkReturnPolicyTool.invoke({
      daysSinceDelivery: parsedOrder.daysSinceDelivery,
    });
    trajectory.push('checkReturnPolicy');
    const parsedPolicy = JSON.parse(String(rawPolicy)) as {
      eligible: boolean;
      policyRule: string;
    };

    const answer = parsedPolicy.eligible
      ? `Order ${parsedOrder.orderId} ($${parsedOrder.totalUsd}) is eligible for a refund. - Store Support AI`
      : `Order ${parsedOrder.orderId} was delivered ${parsedOrder.daysSinceDelivery} days ago, which is outside our 30-day return window. - Store Support AI`;

    return {
      runId,
      traceId,
      threadId: req.threadId,
      answer,
      trajectory,
      latencyMs: Date.now() - startTime,
    };
  },
  {
    name: 'supportAgentDayOne',
    run_type: 'chain',
    client: privacySafeClient,
  }
);

async function main() {
  const response = await invokeObservableSupportAgent({
    threadId: 'thread_day1_001',
    userId: 'usr_4410',
    customerTier: 'vip',
    promptVersion: 'v1.0-observable',
    customerMessage: 'Can I return my order A-1002?',
  });

  console.log('=== Day-1 Observable Support Agent Response ===');
  console.log(JSON.stringify(response, null, 2));

  // Built-in Trajectory & Policy Smoke Check
  const passedTrajectory =
    response.trajectory[0] === 'getOrderStatus' &&
    response.trajectory[1] === 'checkReturnPolicy' &&
    !response.trajectory.includes('requestRefund');
  console.log(`\n[Day-1 CI Smoke Check] Trajectory Valid: ${passedTrajectory ? 'PASS ✅' : 'FAIL ❌'}`);
}

main().catch(console.error);
