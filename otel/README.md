# `otel/` - OpenTelemetry & Enterprise Observability Examples

TypeScript examples for **Chapters 8, 9, and 19** using the official OpenTelemetry Node.js SDK (`@opentelemetry/api`, `@opentelemetry/sdk-node`) and patterns for **Progress Observability Platform**.

## Setup

```bash
npm install
cp .env.example .env   # Optional: required only for live Gemini + Progress exports in Ch. 08
npx tsc --noEmit
```

`ch09` through `ch23` run offline without external API keys (`ch08` also runs in offline preview mode if keys are omitted). To forward live OTLP spans from `ch09` / `ch19` to a custom collector, optionally set:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
```

## Available Scripts

- `npm run ch08` — `src/ch08-progress-observability.ts` (Progress Observability Platform live SDK, FinOps costs & tags)
- `npm run ch09` — `src/ch09-otel-and-three-lenses.ts` (OpenTelemetry `gen_ai.*` conventions & 3-lenses comparison)
- `npm run ch19` — `src/ch19-production-architecture-blueprint.ts` (`BatchSpanProcessor` & stack selector)
