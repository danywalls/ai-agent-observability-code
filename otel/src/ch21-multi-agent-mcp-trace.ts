import { fileURLToPath } from 'node:url';
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({ serviceName: 'support-multi-agent' });
sdk.start();

propagation.setGlobalPropagator(
  new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  })
);

const tracer = trace.getTracer('support-multi-agent', '1.0.0');
export const MAX_DELEGATION_DEPTH = 3;

export type CarrierHeaders = Record<string, string>;

export function getDelegationDepth(ctx = context.active()): number {
  const activeBaggage = propagation.getBaggage(ctx);
  const raw = activeBaggage?.getEntry('delegation.depth')?.value;
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function injectOutgoingCarrier(
  sessionId: string,
  nextDepth: number
): CarrierHeaders {
  const currentBaggage =
    propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  const updatedBaggage = currentBaggage
    .setEntry('session.id', { value: sessionId })
    .setEntry('delegation.depth', { value: String(nextDepth) });

  const ctxWithBaggage = propagation.setBaggage(context.active(), updatedBaggage);
  const carrier: CarrierHeaders = {};
  propagation.inject(ctxWithBaggage, carrier);
  return carrier;
}

export async function mcpInventoryServer(
  sku: string,
  incomingHeaders: CarrierHeaders
): Promise<{ inStock: boolean; warehouse: string; sessionId: string; depth: number }> {
  const extractedContext = propagation.extract(context.active(), incomingHeaders);
  const sessionId =
    propagation.getBaggage(extractedContext)?.getEntry('session.id')?.value ?? 'unknown';
  const depth = getDelegationDepth(extractedContext);

  return context.with(extractedContext, async () => {
    return tracer.startActiveSpan(
      'mcp.tool.check_stock',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.system': 'mcp',
          'gen_ai.tool.name': 'check_stock',
          'gen_ai.conversation.id': sessionId,
          'gen_ai.agent.delegation_depth': depth,
          'inventory.sku': sku,
        },
      },
      async (span) => {
        try {
          await new Promise((r) => setTimeout(r, 25));
          span.setStatus({ code: SpanStatusCode.OK });
          return { inStock: true, warehouse: 'EU-WEST-1', sessionId, depth };
        } finally {
          span.end();
        }
      }
    );
  });
}

export async function billingSubagent(
  orderId: string,
  incomingHeaders: CarrierHeaders
): Promise<{ creditApprovedUsd: number; sessionId: string; depth: number }> {
  const extractedContext = propagation.extract(context.active(), incomingHeaders);
  const sessionId =
    propagation.getBaggage(extractedContext)?.getEntry('session.id')?.value ?? 'unknown';
  const depth = getDelegationDepth(extractedContext);

  return context.with(extractedContext, async () => {
    return tracer.startActiveSpan(
      'billing_subagent.resolve',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.agent.name': 'billing-subagent',
          'gen_ai.conversation.id': sessionId,
          'gen_ai.agent.delegation_depth': depth,
          'order.id': orderId,
        },
      },
      async (span) => {
        try {
          if (depth > MAX_DELEGATION_DEPTH) {
            span.setAttribute('delegation.loop_blocked', true);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `Max delegation depth ${MAX_DELEGATION_DEPTH} exceeded`,
            });
            throw new Error(`Delegation loop blocked at depth ${depth} in billing-subagent`);
          }

          await new Promise((r) => setTimeout(r, 35));
          span.setStatus({ code: SpanStatusCode.OK });
          return { creditApprovedUsd: 15, sessionId, depth };
        } finally {
          span.end();
        }
      }
    );
  });
}

export async function orchestratorAgent(sessionId: string, orderId: string, sku: string) {
  return tracer.startActiveSpan(
    'orchestrator.handle_exchange',
    {
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'support-orchestrator',
        'gen_ai.conversation.id': sessionId,
      },
    },
    async (rootSpan) => {
      try {
        const currentDepth = getDelegationDepth();
        const carrier = injectOutgoingCarrier(sessionId, currentDepth + 1);

        const [stock, billing] = await Promise.all([
          mcpInventoryServer(sku, carrier),
          billingSubagent(orderId, carrier),
        ]);

        rootSpan.setStatus({ code: SpanStatusCode.OK });
        return {
          sessionId,
          orderId,
          stock,
          billing,
          traceparent: carrier.traceparent,
          baggage: carrier.baggage,
        };
      } catch (error) {
        rootSpan.recordException(error as Error);
        rootSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        rootSpan.end();
      }
    }
  );
}

async function main() {
  const result = await orchestratorAgent('sess-vip-902', 'A-1002', 'KB-MECH-01');
  console.log('Distributed multi-agent result:', JSON.stringify(result, null, 2));
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
