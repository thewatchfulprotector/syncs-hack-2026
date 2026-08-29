// Alexandria ingestion CLI: media/docs -> transcript -> persona-only chunks -> Pinecone.
//
//   npm run ingest -- --persona steve interview.mp4 talk.mp3 essay.txt
//
// Flags:
//   --persona <id>     (required) persona the material belongs to
//   --speaker <label>  override the "persona = whoever talks most" heuristic (e.g. A)
//   --voice-sample     also clip the cleanest solo speech into out/voice-sample-<persona>.mp3
//
// Transcripts are cached in out/transcripts/ so re-runs don't re-transcribe.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { chunkUnits, textToUnits, type Chunk } from "../src/lib/chunker";
import {
  dominantSpeaker,
  filterPersonaUtterances,
  utterancesToUnits,
} from "../src/lib/diarization";
import { selectVoiceSampleSegments } from "../src/lib/voiceSample";
import { transcribeAudio, uploadMedia, type Transcript } from "../src/lib/assemblyai";
import { embedTexts } from "../src/lib/openrouter";
import { upsertChunks, type ChunkRecord, type MediaType } from "../src/lib/pineconeClient";

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"]);
const DOC_EXT = new Set([".txt", ".md"]);

const OUT_DIR = "out";
const TRANSCRIPT_CACHE_DIR = join(OUT_DIR, "transcripts");

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function mediaType(file: string): MediaType {
  const ext = extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (DOC_EXT.has(ext)) return "document";
  throw new Error(`unsupported file type: ${file}`);
}

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/** video -> mono 16kHz wav for transcription; audio passes through untouched. */
function extractAudio(file: string): string {
  if (mediaType(file) === "audio") return file;
  const out = join(OUT_DIR, "audio", `${slug(basename(file, extname(file)))}.wav`);
  mkdirSync(join(OUT_DIR, "audio"), { recursive: true });
  ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", "16000", out]);
  return out;
}

async function getTranscript(file: string): Promise<Transcript> {
  const cachePath = join(TRANSCRIPT_CACHE_DIR, `${slug(basename(file))}.json`);
  if (existsSync(cachePath)) {
    console.log(`  transcript cache hit: ${cachePath}`);
    return JSON.parse(readFileSync(cachePath, "utf8"));
  }
  const audioPath = extractAudio(file);
  console.log(`  uploading ${audioPath}...`);
  const audioUrl = await uploadMedia(readFileSync(audioPath));
  console.log(`  transcribing...`);
  const transcript = await transcribeAudio(audioUrl);
  mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(transcript, null, 2));
  return transcript;
}

/** Concatenate the persona's cleanest segments into one clip for voice cloning. */
function clipVoiceSample(
  sourceFile: string,
  segments: { startMs: number; endMs: number }[],
  personaId: string,
): string {
  const dir = join(OUT_DIR, "voice-segments");
  mkdirSync(dir, { recursive: true });
  const paths = segments.map((seg, i) => {
    const path = join(dir, `seg-${i}.mp3`);
    ffmpeg([
      "-ss", (seg.startMs / 1000).toFixed(3),
      "-to", (seg.endMs / 1000).toFixed(3),
      "-i", sourceFile,
      "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k",
      path,
    ]);
    return path;
  });
  const listPath = join(dir, "list.txt");
  writeFileSync(listPath, paths.map((p) => `file '${basename(p)}'`).join("\n"));
  const out = join(OUT_DIR, `voice-sample-${slug(personaId)}.mp3`);
  // re-encode: stream-copying independently encoded mp3 segments yields broken timestamps
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-ac", "1", "-ar", "44100", "-b:a", "128k", out]);
  return out;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      persona: { type: "string" },
      speaker: { type: "string" },
      "voice-sample": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const personaId = values.persona;
  if (!personaId || positionals.length === 0) {
    console.error("usage: npm run ingest -- --persona <id> [--speaker <label>] [--voice-sample] <files...>");
    process.exit(1);
  }

  const allRecordsMeta: { chunk: Chunk; file: string; type: MediaType; speaker: string }[] = [];

  for (const file of positionals) {
    if (!existsSync(file)) throw new Error(`no such file: ${file}`);
    const type = mediaType(file);
    console.log(`${file} (${type})`);

    if (type === "document") {
      const chunks = chunkUnits(textToUnits(readFileSync(file, "utf8")));
      console.log(`  ${chunks.length} chunks`);
      for (const chunk of chunks) allRecordsMeta.push({ chunk, file, type, speaker: "" });
      continue;
    }

    const transcript = await getTranscript(file);
    const speaker = values.speaker ?? dominantSpeaker(transcript.utterances);
    const persona = filterPersonaUtterances(transcript.utterances, speaker);
    const kept = persona.reduce((s, u) => s + (u.end - u.start), 0);
    console.log(
      `  persona speaker=${speaker}: kept ${persona.length}/${transcript.utterances.length} utterances (${Math.round(kept / 1000)}s of ${transcript.audio_duration}s)`,
    );

    const chunks = chunkUnits(utterancesToUnits(persona));
    console.log(`  ${chunks.length} chunks`);
    for (const chunk of chunks) allRecordsMeta.push({ chunk, file, type, speaker });

    if (values["voice-sample"]) {
      const segments = selectVoiceSampleSegments(persona);
      if (segments.length === 0) {
        console.log("  voice sample: no segment long enough, skipping");
      } else {
        const out = clipVoiceSample(file, segments, personaId);
        const total = segments.reduce((s, x) => s + (x.endMs - x.startMs), 0);
        console.log(`  voice sample: ${segments.length} segments, ${Math.round(total / 1000)}s -> ${out}`);
      }
    }
  }

  if (allRecordsMeta.length === 0) {
    console.log("nothing to index");
    return;
  }

  console.log(`embedding ${allRecordsMeta.length} chunks...`);
  const vectors = await embedTexts(allRecordsMeta.map((r) => r.chunk.text));

  const counters = new Map<string, number>();
  const records: ChunkRecord[] = allRecordsMeta.map((r, i) => {
    const source = basename(r.file);
    const n = counters.get(source) ?? 0;
    counters.set(source, n + 1);
    return {
      id: `${slug(personaId)}:${slug(source)}:${n}`,
      values: vectors[i],
      metadata: {
        persona_id: personaId,
        source_file: source,
        media_type: r.type,
        text: r.chunk.text,
        ...(r.speaker ? { speaker: r.speaker } : {}),
        ...(r.chunk.startMs !== undefined ? { start_ms: r.chunk.startMs } : {}),
        ...(r.chunk.endMs !== undefined ? { end_ms: r.chunk.endMs } : {}),
      },
    };
  });

  console.log(`upserting ${records.length} vectors to Pinecone...`);
  await upsertChunks(records);
  console.log(`done: ${records.length} chunks indexed for persona "${personaId}"`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
