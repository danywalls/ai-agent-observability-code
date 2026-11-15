# AI Agent Observability - Companion TypeScript Code

Official TypeScript companion repository for the book **AI Agent Observability** by **Dany Paredes** ([danywalls.com/book](https://danywalls.com/book)).

Every chapter example is self-contained, strictly typed in TypeScript, and includes deterministic local simulation fallbacks so you can run and study every trace, guardrail, and evaluation without paid API keys.

## Repository Structure

```text
.
├── genkit/        # Firebase Genkit flows, tools, RAG, evaluators & Genkit Monitoring (Ch. 1, 2, 3-5, 11-12, 17, 20)
├── langchain/     # LangChain + LangSmith ReAct agents, middlewares, datasets & privacy (Ch. 2, 6-8, 11-16, 18, 20)
├── otel/          # OpenTelemetry GenAI Semantic Conventions (gen_ai.*) & OTLP export (Ch. 9-10, 19)
├── .env.example   # Optional environment variables for live LLM / LangSmith / OTLP runs
└── package.json   # Root workspace typecheck scripts
```

## Quick Start

1. **Install dependencies** in the package(s) you want to run:

```bash
cd genkit && npm install && cd ..
cd langchain && npm install && cd ..
cd otel && npm install && cd ..
```

2. **(Optional) Configure live API keys:**

```bash
cp .env.example .env
```

All examples work out of the box in **local simulation mode** when API keys are omitted.

3. **Run TypeScript type-checking across all 3 packages:**

```bash
npm run typecheck
```

4. **Run any chapter script** (for example):

```bash
# Firebase Genkit (Chapters 1, 2, 3, 4, 5, 11, 12, 17, 20)
cd genkit
npm run ch03

# LangChain & LangSmith (Chapters 2, 6, 7, 8, 11-16, 18, 20)
cd ../langchain
npm run ch06

# OpenTelemetry & OTLP / Progress Observability Platform (Chapters 9, 10, 19)
cd ../otel
npm run ch09
```
