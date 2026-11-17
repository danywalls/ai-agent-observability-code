# `otel/` - OpenTelemetry & Enterprise Observability Examples

TypeScript examples for **Chapters 8, 9, and 19** using the official OpenTelemetry Node.js SDK (`@opentelemetry/api`, `@opentelemetry/sdk-node`) and patterns for **Progress Observability Platform**.

## Setup

```bash
npm install
npx tsc --noEmit
```

All scripts run offline without external API keys. To forward OTLP spans to a local collector or enterprise backend, optionally set:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
```

## Available Scripts

- `npm run ch08` — `src/ch08-otel-genai-conventions.ts` (`gen_ai.*` spans & opt-in content)
- `npm run ch09` — `src/ch09-three-lenses-comparison.ts` (Genkit vs. LangSmith vs. OTel / Progress)
- `npm run ch19` — `src/ch19-production-architecture-blueprint.ts` (`BatchSpanProcessor` & stack selector)
