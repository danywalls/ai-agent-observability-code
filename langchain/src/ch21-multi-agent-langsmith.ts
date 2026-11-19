import { RunTree } from 'langsmith';

const MAX_DELEGATION_DEPTH = 3;

async function handleBillingSubagent(
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

  await childRun.end({ outputs: { creditApprovedUsd: 15, status: 'approved' } });
  return { creditApprovedUsd: 15 };
}

async function main() {
  const rootRun = new RunTree({
    name: 'support_orchestrator',
    run_type: 'chain',
    inputs: { sessionId: 'sess-vip-902', orderId: 'A-1002' },
  });

  const headers = rootRun.toHeaders();
  const billingResult = await handleBillingSubagent(headers, 'A-1002', 1);
  await rootRun.end({ outputs: billingResult });

  console.log('LangSmith distributed trace headers:', headers);
  console.log('Billing subagent output:', billingResult);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
