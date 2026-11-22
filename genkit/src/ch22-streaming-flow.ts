import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';

function loadLocalEnv(): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../.env', '../../.env']) {
    const envPath = resolve(currentDir, rel);
    if (existsSync(envPath)) {
      process.loadEnvFile?.(envPath);
    }
  }
  if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
    process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
  }
}

loadLocalEnv();

const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);

const ai = genkit({
  plugins: hasGeminiKey ? [googleAI()] : [],
});

export const supportStreamFlow = ai.defineFlow(
  {
    name: 'supportStreamFlow',
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.string(),
    streamSchema: z.string(),
  },
  async ({ question }, { sendChunk }) => {
    const startMs = performance.now();
    let firstChunkLogged = false;

    if (!process.env.GEMINI_API_KEY) {
      const simulated = ['Checking ', 'your support ', 'request: ', question];
      for (const token of simulated) {
        await new Promise((r) => setTimeout(r, 25));
        if (!firstChunkLogged) {
          console.log(`[TTFT] ${Math.round(performance.now() - startMs)} ms`);
          firstChunkLogged = true;
        }
        sendChunk(token);
      }
      return simulated.join('');
    }

    const { stream, response } = ai.generateStream({
      model: googleAI.model('gemini-3-flash-preview'),
      prompt: question,
    });

    for await (const chunk of stream) {
      if (chunk.text) {
        if (!firstChunkLogged) {
          console.log(`[TTFT] ${Math.round(performance.now() - startMs)} ms`);
          firstChunkLogged = true;
        }
        sendChunk(chunk.text);
      }
    }

    const final = await response;
    return final.text;
  }
);

async function main() {
  const { stream, output } = supportStreamFlow.stream({
    question: 'What is the VIP return window for keyboards?',
  });

  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const finalOutput = await output;
  console.log('Streamed chunks:', chunks.length, '| Final:', finalOutput);
}

const isMain =
  process.env.GENKIT_ENV !== 'dev' &&
  Boolean(
    process.argv[1] &&
      fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*\/src\//, '/src/'))
  );

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
