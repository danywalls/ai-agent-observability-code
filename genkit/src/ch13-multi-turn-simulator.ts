type PersonaId = 'impatient-vip' | 'ambiguous-order' | 'mind-changer';

interface TurnStep {
  turn: number;
  userMessage: string;
  toolsCalled: Array<{ name: string; argsKey: string; failedTransient?: boolean }>;
  assistantReply: string;
}

interface TrajectoryEfficiencyReport {
  persona: PersonaId;
  optimalSteps: number;
  actualSteps: number;
  redundantCalls: number;
  recoveredFromError: boolean;
  trajectoryEfficiency: number;
}

function evaluateTrajectoryEfficiency(
  persona: PersonaId,
  turns: TurnStep[],
  optimalSteps: number
): TrajectoryEfficiencyReport {
  const seenSuccess = new Set<string>();
  let actualSteps = 0;
  let redundantCalls = 0;
  let sawTransientError = false;
  let recoveredFromError = false;

  for (const turn of turns) {
    for (const call of turn.toolsCalled) {
      actualSteps += 1;
      const signature = `${call.name}:${call.argsKey}`;

      if (call.failedTransient) {
        sawTransientError = true;
        continue;
      }

      if (sawTransientError) {
        recoveredFromError = true;
      }

      if (seenSuccess.has(signature)) {
        redundantCalls += 1;
      } else {
        seenSuccess.add(signature);
      }
    }
  }

  const penalty = redundantCalls * 0.15;
  const baseRatio = actualSteps === 0 ? 0 : Math.min(1, optimalSteps / actualSteps);
  const trajectoryEfficiency = Number(Math.max(0, baseRatio - penalty).toFixed(2));

  return {
    persona,
    optimalSteps,
    actualSteps,
    redundantCalls,
    recoveredFromError,
    trajectoryEfficiency,
  };
}

async function runMultiTurnSimulation(persona: PersonaId): Promise<TrajectoryEfficiencyReport> {
  const simulations: Record<PersonaId, { optimalSteps: number; turns: TurnStep[] }> = {
    'impatient-vip': {
      optimalSteps: 2,
      turns: [
        {
          turn: 1,
          userMessage: 'My VIP keyboard order A-1002 arrived broken. Fix this now.',
          toolsCalled: [
            { name: 'lookupOrder', argsKey: 'A-1002', failedTransient: true },
            { name: 'lookupOrder', argsKey: 'A-1002' },
          ],
          assistantReply: 'Found order A-1002. You qualify for a 90-day VIP replacement.',
        },
        {
          turn: 2,
          userMessage: 'Just ship the replacement instead of refunding.',
          toolsCalled: [{ name: 'createReplacement', argsKey: 'A-1002' }],
          assistantReply: 'Replacement shipment scheduled for order A-1002.',
        },
      ],
    },
    'ambiguous-order': {
      optimalSteps: 2,
      turns: [
        {
          turn: 1,
          userMessage: 'I want to return my keyboard.',
          toolsCalled: [],
          assistantReply: 'Could you share your order ID or account email?',
        },
        {
          turn: 2,
          userMessage: 'It is A-1002.',
          toolsCalled: [{ name: 'lookupOrder', argsKey: 'A-1002' }],
          assistantReply: 'Order A-1002 is eligible for return. Confirm to proceed.',
        },
        {
          turn: 3,
          userMessage: 'Yes, refund it.',
          toolsCalled: [{ name: 'requestRefund', argsKey: 'A-1002' }],
          assistantReply: 'Refund submitted for A-1002.',
        },
      ],
    },
    'mind-changer': {
      optimalSteps: 3,
      turns: [
        {
          turn: 1,
          userMessage: 'Check order A-1002 and start a refund.',
          toolsCalled: [{ name: 'lookupOrder', argsKey: 'A-1002' }],
          assistantReply: 'Order A-1002 is eligible. Shall I issue the refund?',
        },
        {
          turn: 2,
          userMessage: 'Actually, send a replacement and add store credit instead.',
          toolsCalled: [
            { name: 'lookupOrder', argsKey: 'A-1002' },
            { name: 'createReplacement', argsKey: 'A-1002' },
            { name: 'issueCredit', argsKey: 'A-1002' },
          ],
          assistantReply: 'Replacement and credit processed for A-1002.',
        },
      ],
    },
  };

  const sim = simulations[persona];
  return evaluateTrajectoryEfficiency(persona, sim.turns, sim.optimalSteps);
}

async function main() {
  const personas: PersonaId[] = ['impatient-vip', 'ambiguous-order', 'mind-changer'];
  const reports = await Promise.all(personas.map((p) => runMultiTurnSimulation(p)));
  console.table(reports);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
