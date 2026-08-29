// Terminal end-to-end ask loop (Phase 3).
//   npm run ask -- --persona wildfire-expert "What is causing the smoke?"
import { parseArgs } from "node:util";
import { askPersona } from "../src/lib/ask";
import { extractSources } from "../src/lib/citations";
import { formatTimestamp } from "../src/lib/prompt";

async function main() {
  const { values, positionals } = parseArgs({
    options: { persona: { type: "string", default: "wildfire-expert" } },
    allowPositionals: true,
  });
  const question = positionals.join(" ");
  if (!question) {
    console.error('usage: npm run ask -- [--persona <id>] "your question"');
    process.exit(1);
  }

  const t0 = performance.now();
  const { chunks, stream, timings } = await askPersona(values.persona!, question);

  let full = "";
  let firstTokenMs: number | undefined;
  for await (const token of stream) {
    if (firstTokenMs === undefined) {
      firstTokenMs = Math.round(performance.now() - t0);
      process.stdout.write("\n");
    }
    full += token;
    process.stdout.write(token);
  }
  process.stdout.write("\n\n");

  const { sources } = extractSources(full);
  const cited = sources.length > 0 ? sources : chunks.map((_, i) => i + 1);
  console.log("citations:");
  for (const n of cited) {
    const chunk = chunks[n - 1];
    if (!chunk) continue;
    const { source_file, start_ms, end_ms } = chunk.metadata;
    const range =
      start_ms !== undefined
        ? ` @ ${formatTimestamp(start_ms)}–${formatTimestamp(end_ms ?? start_ms)}`
        : "";
    console.log(`  [${n}] ${source_file}${range} (score ${chunk.score.toFixed(3)})`);
  }
  console.log(
    `\ntimings: embed ${timings.embedMs}ms · pinecone ${timings.queryMs}ms · first token at ${firstTokenMs}ms · total ${Math.round(performance.now() - t0)}ms`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
