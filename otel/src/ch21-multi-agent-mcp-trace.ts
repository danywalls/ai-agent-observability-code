import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({ serviceName: 'support-multi-agent' });
sdk.start();

const tracer = trace.getTracer('support-multi-agent', '1.0.0');
const MAX_DELEGATION_DEPTH = 3;

interface CarrierHeaders {
  traceparent?: string;
  baggage?: string;
}

async function mcpInventoryServer(
  sku: string,
  incomingHeaders: CarrierHeaders
): Promise<{ inStock: boolean; warehouse: string }> {
  const extractedContext = propagation.extract(context.active(), incomingHeaders);

  return context.with(extractedContext, async () => {
    return tracer.startActiveSpan('mcp.tool.check_stock', async (span) => {
      try {
        span.setAttribute('gen_ai.system', 'mcp');
        span.setAttribute('gen_ai.tool.name', 'check_stock');
        span.setAttribute('inventory.sku', sku);
        await new Promise((r) => setTimeout(r, 25));
        span.setStatus({ code: SpanStatusCode.OK });
        return { inStock: true, warehouse: 'EU-WEST-1' };
      } finally {
        span.end();
      }
    });
  });
}

async function billingSubagent(
  orderId: string,
  depth: number,
  incomingHeaders: CarrierHeaders
): Promise<{ creditApprovedUsd: number }> {
  const extractedContext = propagation.extract(context.active(), incomingHeaders);

  return context.with(extractedContext, async () => {
    return tracer.startActiveSpan('billing_subagent.resolve', async (span) => {
      try {
        span.setAttribute('gen_ai.agent.name', 'billing-subagent');
        span.setAttribute('agent.delegation_depth', depth);
        span.setAttribute('order.id', orderId);

        if (depth > MAX_DELEGATION_DEPTH) {
          throw new Error(`Delegation loop detected at depth ${depth}`);
        }

        await new Promise((r) => setTimeout(r, 35));
        span.setStatus({ code: SpanStatusCode.OK });
        return { creditApprovedUsd: 15 };
      } finally {
        span.end();
      }
    });
  });
}

async function orchestratorAgent(sessionId: string, orderId: string, sku: string) {
  return tracer.startActiveSpan('orchestrator.handle_exchange', async (rootSpan) => {
    try {
      rootSpan.setAttribute('gen_ai.agent.name', 'support-orchestrator');
      rootSpan.setAttribute('gen_ai.conversation.id', sessionId);

      const carrier: CarrierHeaders = {};
      propagation.inject(context.active(), carrier);

      const [stock, billing] = await Promise.all([
        mcpInventoryServer(sku, carrier),
        billingSubagent(orderId, 1, carrier),
      ]);

      rootSpan.setStatus({ code: SpanStatusCode.OK });
      return { sessionId, orderId, stock, billing, traceparent: carrier.traceparent };
    } catch (error) {
      rootSpan.recordException(error as Error);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      rootSpan.end();
    }
  });
}

async function main() {
  const result = await orchestratorAgent('sess-vip-902', 'A-1002', 'KB-MECH-01');
  console.log('Distributed multi-agent result:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
