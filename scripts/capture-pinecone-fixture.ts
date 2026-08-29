// Captures a real Pinecone query response as a test fixture.
// Run: node --env-file=.env.local --import tsx scripts/capture-pinecone-fixture.ts [persona] [question]
import { writeFileSync } from "node:fs";
import { embedTexts } from "../src/lib/openrouter";
import { personaIndex } from "../src/lib/pineconeClient";

async function main() {
  const personaId = process.argv[2] ?? "wildfire-expert";
  const question = process.argv[3] ?? "What is causing the poor air quality?";

  const [vector] = await embedTexts([question]);
  const response = await personaIndex().query({
    vector,
    topK: 8,
    filter: { persona_id: personaId },
    includeMetadata: true,
  });

  // strip the bulky query vector from nothing — the response holds no vectors
  // unless includeValues is set, so it is fixture-sized as-is
  writeFileSync(
    "src/lib/fixtures/pinecone-query.json",
    JSON.stringify(response, null, 2),
  );
  console.log(
    `saved fixture: ${response.matches?.length ?? 0} matches for "${question}" (persona ${personaId})`,
  );
}
main();
