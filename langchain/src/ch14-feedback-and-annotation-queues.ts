import { randomUUID } from 'node:crypto';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { Client } from 'langsmith';
import { getCurrentRunTree, traceable } from 'langsmith/traceable';

try {
  process.loadEnvFile?.();
} catch {
  // Optional .env file in langchain/
}

/**
 * Chapter 14: User Feedback and Human Annotation Queues
 *
 * Demonstrates:
 * 1. Returning `runId`, `traceId`, and `startTime` alongside the agent's response so your UI
 *    and backend can attach feedback to the exact execution tree in SmithDB workspaces.
 * 2. Logging explicit feedback (`client.createFeedback({ runId, sessionId, ... })`) including
 *    thumbs up/down `score`, categorical `value` tags, `comment`, and `correction`.
 * 3. Logging implicit behavioral signals (e.g., user clicked "Talk to a human").
 * 4. Generating presigned feedback tokens (`createPresignedFeedbackToken`) for
 *    browser/mobile clients without exposing `LANGSMITH_API_KEY`.
 * 5. Routing problematic runs to a Human Annotation Queue idempotently using the modern
 *    SmithDB endpoint (`client.annotationQueues.items.create`).
 */

export interface AgentApiResponse {
  runId: string;
  traceId: string;
  startTime: string;
  answer: string;
}

export interface UserFeedbackPayload {
  runId: string;
  traceId: string;
  sessionId?: string;
  startTime?: string;
  thumbScore: 0 | 1; // 1 = 👍, 0 = 👎
  feedbackTag?: 'hallucinated_order' | 'wrong_policy' | 'too_slow' | 'helpful';
  comment?: string;
  suggestedCorrection?: string;
}

let cachedClient: Client | undefined;
function getLangSmithClient(): Client {
  cachedClient ??= new Client();
  return cachedClient;
}

const sessionIdCache = new Map<string, string>();
export async function resolveSessionId(projectName?: string): Promise<string> {
  const targetProject = projectName ?? process.env.LANGSMITH_PROJECT ?? 'default';
  const cached = sessionIdCache.get(targetProject);
  if (cached) return cached;

  const project = await getLangSmithClient().readProject({ projectName: targetProject });
  sessionIdCache.set(targetProject, project.id);
  return project.id;
}

/**
 * Step 1: Wrap the support agent entry point in `traceable` and return
 * the active `runId`, `traceId`, and `startTime` to the caller.
 */
export const handleSupportRequest = traceable(
  async (input: { userId: string; customerMessage: string }): Promise<AgentApiResponse> => {
    const runTree = getCurrentRunTree(true);
    const runId = runTree?.id ?? randomUUID();
    const traceId = runTree?.trace_id ?? runId;
    const startTime = new Date(runTree?.start_time ?? Date.now()).toISOString();

    if (runTree) {
      runTree.metadata = {
        ...runTree.metadata,
        user_id: input.userId,
        channel: 'web_chat_widget',
      };
    }

    // Simulated response where the agent gives an incomplete refund explanation
    const answer = input.customerMessage.includes('A-1002')
      ? 'Your order A-1002 was delivered 45 days ago. You can request a refund anytime in your account portal.'
      : 'Order A-1001 is currently in transit with tracking TRK-99812.';

    return {
      runId,
      traceId,
      startTime,
      answer,
    };
  },
  {
    name: 'supportAgent',
    run_type: 'chain',
  },
);

/**
 * Step 2: Record explicit user feedback (👍/👎, feedback category tag, comment, and correction)
 * using the modern object API with `sessionId` and `startTime`.
 */
export async function recordSupportFeedback(
  payload: UserFeedbackPayload,
  options: { dryRun?: boolean; projectName?: string } = {},
): Promise<void> {
  console.log(`\n=== Recording User Feedback for Run ${payload.runId} ===`);
  console.log(`- Thumb score (user_thumb): ${payload.thumbScore === 1 ? '👍 (1)' : '👎 (0)'}`);
  if (payload.feedbackTag) {
    console.log(`- Feedback tag (feedback_category): "${payload.feedbackTag}"`);
  }
  if (payload.comment) {
    console.log(`- User comment: "${payload.comment}"`);
  }

  if (options.dryRun || !process.env.LANGSMITH_API_KEY) {
    console.log(
      '[Dry-Run Mode] Skipping remote LangSmith API call (set LANGSMITH_API_KEY to send live feedback).',
    );
    return;
  }

  const client = getLangSmithClient();
  const sessionId = payload.sessionId ?? (await resolveSessionId(options.projectName));

  // 1. Binary thumb score (0 or 1) + free-text comment + optional human correction
  await client.createFeedback({
    runId: payload.runId,
    sessionId,
    traceId: payload.traceId,
    startTime: payload.startTime,
    key: 'user_thumb',
    score: payload.thumbScore,
    comment: payload.comment,
    correction: payload.suggestedCorrection
      ? { expectedAnswer: payload.suggestedCorrection }
      : undefined,
    feedbackSourceType: 'app',
  });

  // 2. Categorical feedback tag (e.g. "wrong_policy", "hallucinated_order")
  if (payload.feedbackTag) {
    await client.createFeedback({
      runId: payload.runId,
      sessionId,
      traceId: payload.traceId,
      startTime: payload.startTime,
      key: 'feedback_category',
      value: payload.feedbackTag,
      feedbackSourceType: 'app',
    });
  }
}

/**
 * Step 3: Record implicit user feedback (signals the user gives without clicking 👍/👎).
 */
export async function recordImplicitEscalation(
  runId: string,
  traceId: string,
  escalatedToHuman: boolean,
  options: { dryRun?: boolean; sessionId?: string; startTime?: string; projectName?: string } = {},
): Promise<void> {
  const retentionScore = escalatedToHuman ? 0 : 1; // 1 = resolved by AI, 0 = user demanded human agent
  console.log(
    `\n=== Recording Implicit Signal for Run ${runId}: resolved_without_human = ${retentionScore} ===`,
  );

  if (options.dryRun || !process.env.LANGSMITH_API_KEY) {
    return;
  }

  const sessionId = options.sessionId ?? (await resolveSessionId(options.projectName));
  await getLangSmithClient().createFeedback({
    runId,
    sessionId,
    traceId,
    startTime: options.startTime,
    key: 'resolved_without_human',
    score: retentionScore,
    comment: escalatedToHuman
      ? 'Customer clicked "Talk to a human agent" within 30 seconds of the AI reply.'
      : 'Conversation closed without human escalation.',
    feedbackSourceType: 'app',
  });
}

/**
 * Step 4: Generate a presigned feedback token on the backend so a frontend widget
 * can submit feedback directly without exposing LANGSMITH_API_KEY.
 */
export async function generateFrontendFeedbackToken(
  runId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ tokenUrl: string }> {
  if (options.dryRun || !process.env.LANGSMITH_API_KEY) {
    return {
      tokenUrl: `https://api.smith.langchain.com/feedback-tokens/mock-presigned-token-for-${runId}`,
    };
  }

  const token = await getLangSmithClient().createPresignedFeedbackToken(runId, 'user_thumb');
  return { tokenUrl: token.url };
}

/**
 * Step 5: Route negative-feedback runs into a Human Annotation Queue idempotently using
 * the modern SmithDB endpoint (`client.annotationQueues.items.create`).
 */
export async function enqueueRunForHumanReview(
  queueName: string,
  run: { runId: string; sessionId?: string; startTime: string },
  options: { dryRun?: boolean; projectName?: string } = {},
): Promise<void> {
  console.log(`\n=== Routing Run ${run.runId} to Annotation Queue "${queueName}" ===`);

  if (options.dryRun || !process.env.LANGSMITH_API_KEY) {
    console.log(
      '[Dry-Run Mode] Run queued locally for human review. In LangSmith UI, reviewers will see:\n' +
        '  1. Full input, tool trajectory, and final answer.\n' +
        '  2. Rubric checklists (policy_accuracy, tone, groundedness).\n' +
        '  3. "Add to Dataset" button to promote corrected answers into the Golden Dataset.',
    );
    return;
  }

  const client = getLangSmithClient();
  let queueId: string | undefined;
  for await (const existing of client.listAnnotationQueues({ name: queueName })) {
    if (existing.name === queueName) {
      queueId = existing.id;
      break;
    }
  }

  if (!queueId) {
    const created = await client.createAnnotationQueue({
      name: queueName,
      description: 'Production support traces that received a 👎 or escalated to a human agent.',
      rubricInstructions:
        'Verify whether the agent checked the 30-day return policy before promising or executing a refund. Write the ideal response in the Correction field and add edge cases to store-support-golden-v1.',
    });
    queueId = created.id;
  }

  const projectId = run.sessionId ?? (await resolveSessionId(options.projectName));

  // SmithDB indexes newly ingested traces asynchronously (eventual consistency), so retrying 404
  // handles immediate calls right after a CLI turn completes.
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.annotationQueues.items.create(queueId, {
        items: [
          {
            item_type: 'RUN',
            run_id: run.runId,
            project_id: projectId,
            start_time: run.startTime,
          },
        ],
      });
      break;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 404 && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw err;
    }
  }
  console.log(`Queued run ${run.runId} in LangSmith Annotation Queue "${queueName}" (${queueId}).`);
}

export async function main() {
  const dryRun = !process.env.LANGSMITH_API_KEY;

  // 1. Execute agent and capture runId + traceId + startTime
  const response = await handleSupportRequest({
    userId: 'usr_9941',
    customerMessage: 'My order A-1002 arrived 45 days ago. Can I still get a refund?',
  });

  console.log('=== Agent Response Sent to Frontend ===');
  console.log(JSON.stringify(response, null, 2));

  let sessionId: string | undefined;
  if (!dryRun) {
    await awaitAllCallbacks();
    sessionId = await resolveSessionId();
  }

  // 2. Generate a presigned token so the browser can submit 👍/👎 safely
  const presigned = await generateFrontendFeedbackToken(response.runId, { dryRun });
  console.log(`\nPresigned Feedback URL for Browser UI: ${presigned.tokenUrl}`);

  // 3. Simulate the user clicking 👎 ("wrong_policy") because the portal rejected their 45-day refund
  await recordSupportFeedback(
    {
      runId: response.runId,
      traceId: response.traceId,
      sessionId,
      startTime: response.startTime,
      thumbScore: 0,
      feedbackTag: 'wrong_policy',
      comment: 'The bot told me I could get a refund anytime, but my order is 45 days old!',
      suggestedCorrection:
        'Order A-1002 was delivered 45 days ago, which is outside our 30-day return window.',
    },
    { dryRun },
  );

  // 4. Simulate implicit signal: user immediately clicked "Talk to a human"
  await recordImplicitEscalation(response.runId, response.traceId, true, {
    dryRun,
    sessionId,
    startTime: response.startTime,
  });

  // 5. Enqueue the bad run into a Human Annotation Queue
  await enqueueRunForHumanReview(
    'support-negative-feedback-review',
    { runId: response.runId, sessionId, startTime: response.startTime },
    { dryRun },
  );

  if (!dryRun) {
    await awaitAllCallbacks();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error('Chapter 14 execution failed:', err);
    process.exit(1);
  });
}
