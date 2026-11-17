# `langchain/` - LangChain & LangSmith Examples

TypeScript examples for **Chapters 2, 3, 4, 6, 7, 10, 11, 12, 13, 14, 15, 16, 18, and 20** using LangChain (`langchain`, `@langchain/core`) and the LangSmith SDK (`langsmith`).

## Setup

```bash
npm install
npx tsc --noEmit
```

All examples include local/offline execution paths. To stream traces, datasets, and experiments to LangSmith, sign up at [smith.langchain.com](https://smith.langchain.com) and export:

```bash
export LANGSMITH_TRACING="true"
export LANGSMITH_API_KEY="your_langsmith_key"
export LANGSMITH_PROJECT="ai-agent-observability"
```

## Available Scripts

- `npm run ch02` — `src/ch02-react-loop-agent.ts`
- `npm run ch03` — `src/ch03-logs-vs-traces.ts`
- `npm run ch04` — `src/ch04-tokens-cost-latency.ts`
- `npm run ch06` — `src/ch06-langsmith-first-trace.ts`
- `npm run ch07` — `src/ch07-trace-anatomy-and-threads.ts`
- `npm run ch10` — `src/ch10-datasets-langsmith.ts`
- `npm run ch11` — `src/ch11-evaluators-langsmith.ts`
- `npm run ch12` — `src/ch12-experiments-and-cicd.ts`
- `npm run ch13` — `src/ch13-trajectory-evaluators-langsmith.ts`
- `npm run ch14` — `src/ch14-feedback-and-annotation-queues.ts`
- `npm run ch15` — `src/ch15-filtering-production-traces.ts`
- `npm run ch16` — `src/ch16-online-eval-and-automations.ts`
- `npm run ch18` — `src/ch18-privacy-pii-and-hitl.ts`
- `npm run ch20` — `src/ch20-observable-agent-from-day-one.ts`
