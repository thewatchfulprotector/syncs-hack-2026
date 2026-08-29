// Create an ElevenLabs Instant Voice Clone from sample audio.
//   npm run clone-voice -- --name "Steve Jobs" out/voice-sample-steve-jobs.mp3 [more.mp3...]
// Prints the voice id; set it on the persona in src/lib/personas.ts.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { createVoiceClone } from "../src/lib/elevenlabs";

async function main() {
  const { values, positionals } = parseArgs({
    options: { name: { type: "string" } },
    allowPositionals: true,
  });
  if (!values.name || positionals.length === 0) {
    console.error('usage: npm run clone-voice -- --name "Persona Name" <sample.mp3...>');
    process.exit(1);
  }
  const samples = positionals.map((p) => ({ filename: basename(p), data: readFileSync(p) }));
  const voiceId = await createVoiceClone(values.name, samples);
  console.log(`voice created: ${voiceId}`);
  console.log(`set voiceId: "${voiceId}" on the persona in src/lib/personas.ts`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
