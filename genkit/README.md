# `genkit/` - Firebase Genkit Examples

TypeScript examples for **Chapters 1, 2, 3, 4, 5, 10, 11, 13, 17, and 20** using Firebase Genkit (`genkit`, `@genkit-ai/google-genai`).

## Setup

```bash
npm install
npx tsc --noEmit
```

Chapters 1 to 4 and 11 call Gemini live and require a free `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey):

```bash
export GEMINI_API_KEY="your_google_ai_studio_key"
```

## Available Scripts

- `npx genkit start -- npx tsx --watch src/ch01-support-agent.ts` — Launch Ch. 1 agent with Genkit Developer UI (`http://localhost:4000`)
- `npm run ch01` — Run `src/ch01-support-agent.ts`
- `npm run ch02` — Run `src/ch02-react-loop-agent.ts`
- `npm run ch03` — Run `src/ch03-logs-vs-traces.ts`
- `npm run ch04` — Run `src/ch04-tokens-cost-latency.ts`
- `npm run ch05` — Run `src/ch05-genkit-devtools-trace.ts` (supports local mock mode)
- `npm run ch10` — Run `src/ch10-golden-dataset.ts` (offline)
- `npm run ch11` — Run `src/ch11-evaluators-genkit.ts`
- `npm run ch13` — Run `src/ch13-trajectory-evaluators-genkit.ts` (offline)
- `npm run ch17` — Run `src/ch17-genkit-monitoring-and-alerts.ts` (offline)
- `npm run ch20` — Run `src/ch20-observable-agent-from-day-one.ts`
