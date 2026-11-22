import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunTree } from 'langsmith';

function loadLocalEnv(): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../.env', '../../.env']) {
    const envPath = resolve(currentDir, rel);
    if (existsSync(envPath)) {
      process.loadEnvFile?.(envPath);
    }
  }
}

loadLocalEnv();

export const MAX_DELEGATION_DEPTH = 3;

export async function handleBillingSubagent(
  headers: Record<string, string>,
  orderId: string,
  depth: number
) {
  if (depth > MAX_DELEGATION_DEPTH) {
    throw new Error(`Delegation depth exceeded (${depth} > ${MAX_DELEGATION_DEPTH})`);
  }

  const childRun = RunTree.fromHeaders(headers, {
    name: 'billing_subagent',
    run_type: 'chain',
    inputs: { orderId, depth },
  });

  if (!childRun) {
    throw new Error('Missing distributed trace headers for billing_subagent');
  }

  if (process.env.LANGSMITH_API_KEY) {
    await childRun.postRun();
  }
  await childRun.end({ outputs: { creditApprovedUsd: 15, status: 'approved' } });
  if (process.env.LANGSMITH_API_KEY) {
    await childRun.patchRun();
  }
  return { creditApprovedUsd: 15 };
}

async function main() {
  const rootRun = new RunTree({
    name: 'support_orchestrator',
    run_type: 'chain',
    inputs: { sessionId: 'sess-vip-902', orderId: 'A-1002' },
  });

  if (process.env.LANGSMITH_API_KEY) {
    await rootRun.postRun();
  }

  const headers = rootRun.toHeaders();
  const billingResult = await handleBillingSubagent(headers, 'A-1002', 1);
  await rootRun.end({ outputs: billingResult });

  if (process.env.LANGSMITH_API_KEY) {
    await rootRun.patchRun();
  }

  console.log('LangSmith distributed trace headers:', headers);
  console.log('Billing subagent output:', billingResult);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*\/src\//, '/src/'));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
