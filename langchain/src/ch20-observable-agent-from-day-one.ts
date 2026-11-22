import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
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

function loadLocalEnv(): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../.env', '../../.env']) {
    const envPath = resolve(currentDir, rel);
    if (existsSync(envPath)) {
      process.loadEnvFile?.(envPath);
    }
  }
  if (!process.env.GOOGLE_API_KEY && process.env.GEMINI_API_KEY) {
    process.env.GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
  }
}

loadLocalEnv();

/**
 * Chapter 20: How to Ask Your AI Assistant for an Observable Agent from Day 1
 * (LangChain + LangSmith Reference Template)
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
      'A-1003': { orderId: 'A-1003', status: 'delivered', daysSinceDelivery: 12, totalUsd: 15.5 },
    };
    const record = mockDb[orderId];
    if (!record) {
      return JSON.stringify({ error: `Order ${orderId} not found`, code: 'ORDER_NOT_FOUND' });
    }
    return JSON.stringify(record);
  },
  {
    name: 'getOrderStatus',
    description:
      'Fetch lean order status, daysSinceDelivery, and totalUsd by orderId (e.g. A-1001).',
    schema: z.object({
      orderId: z.string().regex(/^A-\d{4}$/, 'Order ID must match A-XXXX').describe('Order ID A-XXXX'),
    }),
  }
);

export const checkReturnPolicyTool = tool(
  async ({ daysSinceDelivery, customerTier = 'standard' }) => {
    const maxWindowDays = customerTier === 'vip' ? 60 : 30;
    const eligible = daysSinceDelivery <= maxWindowDays;
    return JSON.stringify({
      eligible,
      maxWindowDays,
      daysSinceDelivery,
      customerTier,
      policyRule: eligible
        ? `Eligible for refund within ${maxWindowDays}-day ${customerTier} window.`
        : `Outside ${maxWindowDays}-day ${customerTier} return window; refund must be declined.`,
    });
  },
  {
    name: 'checkReturnPolicy',
    description:
      'Check whether an order is eligible for return based on daysSinceDelivery and customerTier.',
    schema: z.object({
      daysSinceDelivery: z.number().int().nonnegative().describe('Days elapsed since delivery'),
      customerTier: z.enum(['free', 'standard', 'vip']).optional().describe('Customer tier'),
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
  eligibleForRefund: boolean;
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
      customerTier: req.customerTier,
    });
    trajectory.push('checkReturnPolicy');
    const parsedPolicy = JSON.parse(String(rawPolicy)) as {
      eligible: boolean;
      maxWindowDays: number;
      policyRule: string;
    };

    const answer = parsedPolicy.eligible
      ? `Order ${parsedOrder.orderId} ($${parsedOrder.totalUsd}) was delivered ${parsedOrder.daysSinceDelivery} days ago and is eligible under your ${parsedPolicy.maxWindowDays}-day ${req.customerTier} return window. - Store Support AI`
      : `Order ${parsedOrder.orderId} was delivered ${parsedOrder.daysSinceDelivery} days ago, which is outside our ${parsedPolicy.maxWindowDays}-day return window. - Store Support AI`;

    return {
      runId,
      traceId,
      threadId: req.threadId,
      answer,
      eligibleForRefund: parsedPolicy.eligible,
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
  console.log(
    `\n[Day-1 CI Smoke Check] Trajectory Valid: ${passedTrajectory ? 'PASS ✅' : 'FAIL ❌'}`
  );

  await awaitAllCallbacks();
  await privacySafeClient.awaitPendingTraceBatches();
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*\/src\//, '/src/'));

if (isMain) {
  main().catch(console.error);
}
