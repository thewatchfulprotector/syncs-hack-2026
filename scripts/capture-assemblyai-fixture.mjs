// Captures a real AssemblyAI diarized transcript as a test fixture.
// Run: node --env-file=.env.local scripts/capture-assemblyai-fixture.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const headers = {
  Authorization: process.env.ASSEMBLYAI_API_KEY,
  "Content-Type": "application/json",
};

const create = await fetch("https://api.assemblyai.com/v2/transcript", {
  method: "POST",
  headers,
  body: JSON.stringify({
    audio_url: "https://assembly.ai/wildfires.mp3",
    speaker_labels: true,
  }),
});
if (!create.ok) throw new Error(`${create.status} ${await create.text()}`);
const { id } = await create.json();

let transcript;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const res = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers });
  transcript = await res.json();
  if (transcript.status === "completed") break;
  if (transcript.status === "error") throw new Error(transcript.error);
}
if (transcript.status !== "completed") throw new Error("timed out");

// Keep only the fields our code consumes, but preserve their real shapes.
const fixture = {
  id: transcript.id,
  status: transcript.status,
  audio_duration: transcript.audio_duration,
  text: transcript.text,
  utterances: transcript.utterances,
};
mkdirSync("src/lib/fixtures", { recursive: true });
writeFileSync(
  "src/lib/fixtures/assemblyai-transcript.json",
  JSON.stringify(fixture, null, 2),
);
const speakers = [...new Set(fixture.utterances.map((u) => u.speaker))];
console.log(
  `saved fixture: ${fixture.utterances.length} utterances, speakers={${speakers}}, ${fixture.audio_duration}s audio`,
);
