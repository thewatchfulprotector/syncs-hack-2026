// Build the local ElevenLabs voice-clone sample from already-cached transcripts,
// without re-embedding or writing to Pinecone. Same speaker selection and
// segment picking as `ingest --voice-sample`, just the audio half.
//
//   npm run build-voice-sample -- --persona elon-musk \
//     --speaker-for "file.mp3=B" media/elon-musk/file.mp3 ...
//
// Requires the transcripts to already be cached in out/transcripts/ (produce
// them with `ingest --review-speakers --transcribe-missing`). Runs fully
// offline: reads cached JSON and shells out to ffmpeg. Prints the sample path
// to hand to `clone-voice`.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { parseTranscript } from "../src/lib/assemblyai";
import { filterPersonaUtterances } from "../src/lib/diarization";
import {
  parseSpeakerAssignments,
  selectSpeakerForFile,
} from "../src/lib/ingestSpeakers";
import {
  selectVoiceSampleSegmentsAcrossSources,
  type VoiceSampleSource,
} from "../src/lib/voiceSample";
import { OUT_DIR, clipVoiceSample, slug } from "./voiceClip";

const TRANSCRIPT_CACHE_DIR = join(OUT_DIR, "transcripts");

function cachedTranscript(file: string) {
  const path = join(TRANSCRIPT_CACHE_DIR, `${slug(basename(file))}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `missing cached transcript for ${file} (${path}); run ingest --review-speakers --transcribe-missing first`,
    );
  }
  return parseTranscript(JSON.parse(readFileSync(path, "utf8")));
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      persona: { type: "string" },
      speaker: { type: "string" },
      "speaker-for": { type: "string", multiple: true, default: [] },
      "auto-speaker": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const personaId = values.persona;
  if (!personaId || positionals.length === 0) {
    console.error(
      'usage: npm run build-voice-sample -- --persona <id> [--speaker <label>] [--speaker-for <file=label> ...] [--auto-speaker] <files...>',
    );
    process.exit(1);
  }

  for (const file of positionals) {
    if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  }

  const assignments = parseSpeakerAssignments(values["speaker-for"]);
  const voiceSources: VoiceSampleSource[] = [];
  for (const file of positionals) {
    const transcript = cachedTranscript(file);
    const selection = selectSpeakerForFile(file, transcript.utterances, {
      assignments,
      speaker: values.speaker,
      allowDominant: values["auto-speaker"],
    });
    const persona = filterPersonaUtterances(transcript.utterances, selection.speaker);
    const seconds = Math.round(persona.reduce((s, u) => s + (u.end - u.start), 0) / 1000);
    console.log(
      `${basename(file)}: speaker=${selection.speaker} (${selection.source}), ${persona.length} utterances, ${seconds}s`,
    );
    voiceSources.push({ sourceFile: file, utterances: persona });
  }

  const segments = selectVoiceSampleSegmentsAcrossSources(voiceSources);
  if (segments.length === 0) {
    console.error("no selected-speaker segment was long enough for a clean sample");
    process.exit(1);
  }
  const out = clipVoiceSample(segments, personaId);
  const total = segments.reduce((sum, seg) => sum + seg.endMs - seg.startMs, 0);
  const sources = new Set(segments.map((seg) => seg.sourceFile)).size;
  console.log(
    `voice sample: ${segments.length} segments from ${sources} source(s), ${Math.round(total / 1000)}s -> ${out}`,
  );
  console.log(`next: npm run clone-voice -- --name "<Persona Name>" ${out}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
