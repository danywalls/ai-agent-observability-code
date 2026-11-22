# AI Agent Observability - Companion TypeScript Code

Source files for the book **AI Agent Observability** by **Dany Paredes** ([danywalls.com/book](https://danywalls.com/book)).

Canonical repository: https://github.com/danywalls/ai-agent-observability-code

> **Note on language:** All examples in this repository are written in **TypeScript** (`strict: true`), while the observability, tracing, evaluation, and privacy patterns apply equally to any other language (Python, Go, Java, or .NET).

---

## Repository Structure

```text
.
├── genkit/        # Firebase Genkit flows, tools, RAG, evaluators & Genkit Monitoring
├── langchain/     # LangChain + LangSmith ReAct agents, middlewares, datasets & privacy
├── otel/          # OpenTelemetry GenAI Semantic Conventions (gen_ai.*) & OTLP export
├── .env.example   # Environment variables for live LLM / LangSmith / OTLP runs
├── LICENSE        # MIT License
└── package.json   # Root workspace typecheck scripts
```

*(Note: Inside the book manuscript, these three folders live under `code/genkit/`, `code/langchain/`, and `code/otel/`.)*

---

## Source-Code Coverage

Chapter 0 covers environment setup and the four-pillar map. All code examples begin in Chapter 1:

| Chapter | Package & File(s) | API Key / Requirements | Run Command |
| :--- | :--- | :--- | :--- |
| **Ch. 01** | `genkit/src/ch01-support-agent.ts` | Requires `GEMINI_API_KEY` | `cd genkit && npx genkit start -- npx tsx --watch src/ch01-support-agent.ts` |
| **Ch. 02** | `genkit/src/ch02-react-loop-agent.ts`, `langchain/src/ch02-react-loop-agent.ts` | Genkit: `GEMINI_API_KEY`; LangChain: Offline | `cd genkit && npm run ch02` / `cd langchain && npm run ch02` |
| **Ch. 03** | `genkit/src/ch03-logs-vs-traces.ts`, `langchain/src/ch03-logs-vs-traces.ts` | Genkit: `GEMINI_API_KEY`; LangChain: `LANGSMITH_API_KEY` optional | `cd genkit && npm run ch03` / `cd langchain && npm run ch03` |
| **Ch. 04** | `genkit/src/ch04-tokens-cost-latency.ts`, `langchain/src/ch04-tokens-cost-latency.ts` | Genkit: `GEMINI_API_KEY`; LangChain: Offline | `cd genkit && npm run ch04` / `cd langchain && npm run ch04` |
| **Ch. 05** | `genkit/src/ch05-genkit-devtools-trace.ts` | Local simulation or `GEMINI_API_KEY` | `cd genkit && npm run ch05` |
| **Ch. 06** | `langchain/src/ch06-langsmith-first-trace.ts` | Local simulation or `LANGSMITH_API_KEY` | `cd langchain && npm run ch06` |
| **Ch. 07** | `langchain/src/ch07-trace-anatomy-and-threads.ts` | Offline or `LANGSMITH_API_KEY` optional | `cd langchain && npm run ch07` |
| **Ch. 08** | `otel/src/ch08-progress-observability.ts` | Offline preview or live `GOOGLE_API_KEY` + `OBSERVABILITY_API_KEY` (`ac_p_...`) | `cd otel && npm run ch08` |
| **Ch. 09** | `otel/src/ch09-otel-and-three-lenses.ts` | Offline / OTLP optional | `cd otel && npm run ch09` |
| **Ch. 10** | `genkit/src/ch10-golden-dataset.ts`, `langchain/src/ch10-datasets-langsmith.ts` | Genkit: Offline; LangChain: `LANGSMITH_API_KEY` optional | `cd genkit && npm run ch10` / `cd langchain && npm run ch10` |
| **Ch. 11** | `genkit/src/ch11-evaluators-genkit.ts`, `langchain/src/ch11-evaluators-langsmith.ts` | Genkit: `GEMINI_API_KEY`; LangChain: Offline | `cd genkit && npm run ch11` / `cd langchain && npm run ch11` |
| **Ch. 12** | `langchain/src/ch12-experiments-and-cicd.ts`, `langchain/src/ch12-eval-gate.ts`, `.github/workflows/agent-eval.yml` | Offline or `LANGSMITH_API_KEY` optional | `cd langchain && npm run ch12` / `npm run ch12:gate` |
| **Ch. 13** | `genkit/src/ch13-trajectory-evaluators-genkit.ts`, `genkit/src/ch13-multi-turn-simulator.ts`, `langchain/src/ch13-trajectory-evaluators-langsmith.ts` | Offline | `cd genkit && npm run ch13` / `npm run ch13:sim` / `cd langchain && npm run ch13` |
| **Ch. 14** | `langchain/src/ch14-feedback-and-annotation-queues.ts` | Local simulation or `LANGSMITH_API_KEY` | `cd langchain && npm run ch14` |
| **Ch. 15** | `langchain/src/ch15-filtering-production-traces.ts` | Offline or `LANGSMITH_API_KEY` optional | `cd langchain && npm run ch15` |
| **Ch. 16** | `langchain/src/ch16-online-eval-and-automations.ts` | Local simulation or `LANGSMITH_API_KEY` | `cd langchain && npm run ch16` |
| **Ch. 17** | `genkit/src/ch17-genkit-monitoring-and-alerts.ts` | Offline | `cd genkit && npm run ch17` |
| **Ch. 18** | `langchain/src/ch18-privacy-pii-and-hitl.ts` | Offline | `cd langchain && npm run ch18` |
| **Ch. 19** | `otel/src/ch19-production-architecture-blueprint.ts` | Offline | `cd otel && npm run ch19` |
| **Ch. 20** | `genkit/src/ch20-observable-agent-from-day-one.ts`, `langchain/src/ch20-observable-agent-from-day-one.ts` | Local simulation or live keys | `cd genkit && npm run ch20` / `cd langchain && npm run ch20` |
| **Ch. 21** | `otel/src/ch21-multi-agent-mcp-trace.ts`, `langchain/src/ch21-multi-agent-langsmith.ts` | Offline / W3C trace propagation | `cd otel && npm run ch21` / `cd langchain && npm run ch21` |
| **Ch. 22** | `otel/src/ch22-streaming-otel.ts`, `genkit/src/ch22-streaming-flow.ts` | Local simulation or `GEMINI_API_KEY` | `cd otel && npm run ch22` / `cd genkit && npm run ch22` |
| **Ch. 23** | `genkit/src/ch23-semantic-cache-guardrails.ts`, `langchain/src/ch23-semantic-cache-guardrails.ts`, `otel/src/ch23-resilience-otel.ts` | Offline | `cd genkit && npm run ch23` / `cd langchain && npm run ch23` / `cd otel && npm run ch23` |

---

## Before You Run a Chapter

- **Node.js 20+** and **npm** are required (`node -v`).
- Install dependencies inside the package(s) you plan to run:

```bash
cd genkit && npm install && cd ..
cd langchain && npm install && cd ..
cd otel && npm install && cd ..
```

- Copy `.env.example` into your local `.env` (or export variables in your shell) for chapters that call live models or cloud backends. **Never commit real API keys.**
  - **Gemini API Key (free tier):** [Google AI Studio](https://aistudio.google.com/apikey)
  - **LangSmith API Key (free developer tier):** [smith.langchain.com](https://smith.langchain.com)
  - **Progress Agent Observability:** [progress.com](https://www.progress.com) / [telerik.com](https://www.telerik.com)
- Verify TypeScript compilation across all three packages at any time:

```bash
npm run typecheck
```

---

## Errata and Support

If you find a bug in any example or run into setup issues, please open an issue at:
https://github.com/danywalls/ai-agent-observability-code/issues
