// Alexandria ingestion CLI: media/docs -> transcript -> persona-only chunks -> Pinecone.
//
//   npm run ingest -- --persona steve interview.mp4 talk.mp3 essay.txt
//
// Flags:
//   --persona <id>            (required) persona the material belongs to
//   --review-speakers         inspect cached transcripts and print speaker excerpts; do not index
//   --transcribe-missing      with --review-speakers, explicitly allow paid missing transcriptions
//   --speaker <label>         use one explicit speaker label for every media file
//   --speaker-for <file=A>    repeatable per-file speaker mapping (path or basename)
//   --auto-speaker            explicitly opt into the dominant-speaker heuristic
//   --voice-sample            aggregate clean selected speech into one local sample
//
// Transcripts are cached in out/transcripts/ so re-runs don't re-transcribe.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { chunkUnits, textToUnits, type Chunk } from "../src/lib/chunker";
import { filterPersonaUtterances, utterancesToUnits } from "../src/lib/diarization";
import {
  parseSpeakerAssignments,
  selectSpeakerForFile,
  summarizeSpeakers,
} from "../src/lib/ingestSpeakers";
import {
  selectVoiceSampleSegmentsAcrossSources,
  type SourceVoiceSegment,
  type VoiceSampleSource,
} from "../src/lib/voiceSample";
import {
  parseTranscript,
  transcribeAudio,
  uploadMedia,
  type Transcript,
} from "../src/lib/assemblyai";
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

function transcriptCachePath(file: string): string {
  return join(TRANSCRIPT_CACHE_DIR, `${slug(basename(file))}.json`);
}

async function getTranscript(file: string, allowTranscription = true): Promise<Transcript> {
  const cachePath = transcriptCachePath(file);
  if (existsSync(cachePath)) {
    console.log(`  transcript cache hit: ${cachePath}`);
    try {
      return parseTranscript(JSON.parse(readFileSync(cachePath, "utf8")));
    } catch (err) {
      throw new Error(
        `invalid transcript cache ${cachePath} — delete it to re-transcribe (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
  if (!allowTranscription) {
    throw new Error(`missing transcript cache for ${file}`);
  }
  const audioPath = extractAudio(file);
  console.log(`  uploading ${audioPath}...`);
  const audioUrl = await uploadMedia(readFileSync(audioPath));
  console.log(`  transcribing...`);
  // Long-form podcasts can exceed the default window during provider load.
  // Keep polling the same submitted job instead of encouraging a costly retry.
  const transcript = await transcribeAudio(audioUrl, { timeoutMs: 60 * 60 * 1000 });
  mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(transcript, null, 2));
  return transcript;
}

/** Concatenate selected segments from any number of sources into one sample. */
function clipVoiceSample(
  segments: SourceVoiceSegment[],
  personaId: string,
): string {
  const dir = join(OUT_DIR, "voice-segments", slug(personaId));
  mkdirSync(dir, { recursive: true });
  const paths = segments.map((seg, i) => {
    const path = join(dir, `seg-${String(i).padStart(4, "0")}.mp3`);
    const durationSeconds = (seg.endMs - seg.startMs) / 1000;
    ffmpeg([
      "-ss", (seg.startMs / 1000).toFixed(3),
      "-i", seg.sourceFile,
      "-t", durationSeconds.toFixed(3),
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
  writeFileSync(join(dir, "segments.json"), JSON.stringify(segments, null, 2));
  return out;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function excerpt(text: string, maxLength = 220): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function printSpeakerReview(file: string, transcript: Transcript): void {
  console.log(`  speaker review (${transcript.utterances.length} utterances):`);
  for (const summary of summarizeSpeakers(transcript.utterances)) {
    const seconds = Math.round(summary.durationMs / 1000);
    console.log(
      `    ${summary.speaker}: ${summary.utteranceCount} utterances, ${seconds}s, ${(summary.share * 100).toFixed(1)}% of speech`,
    );
    for (const item of summary.excerpts) {
      console.log(
        `      [${formatTimestamp(item.startMs)}-${formatTimestamp(item.endMs)}] ${excerpt(item.text)}`,
      );
    }
  }
  console.log(`    choose with: --speaker-for ${JSON.stringify(`${basename(file)}=<label>`)}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      persona: { type: "string" },
      speaker: { type: "string" },
      "speaker-for": { type: "string", multiple: true, default: [] },
      "review-speakers": { type: "boolean", default: false },
      "transcribe-missing": { type: "boolean", default: false },
      "auto-speaker": { type: "boolean", default: false },
      "voice-sample": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const personaId = values.persona;
  if (!personaId || positionals.length === 0) {
    console.error(
      "usage: npm run ingest -- --persona <id> [--review-speakers --transcribe-missing] [--speaker <label>] [--speaker-for <file=label> ...] [--auto-speaker] [--voice-sample] <files...>",
    );
    process.exit(1);
  }

  const assignments = parseSpeakerAssignments(values["speaker-for"]);
  const allRecordsMeta: { chunk: Chunk; file: string; type: MediaType; speaker: string }[] = [];
  const voiceSources: VoiceSampleSource[] = [];
  const speakerReviews: Array<{
    sourceFile: string;
    sourceSizeBytes: number;
    sourceMtimeMs: number;
    transcriptId: string;
    audioDurationSeconds: number;
    speakers: ReturnType<typeof summarizeSpeakers>;
  }> = [];

  // Resolve every path and media type before the first upload or external API call.
  for (const file of positionals) {
    if (!existsSync(file)) throw new Error(`no such file: ${file}`);
    mediaType(file);
  }

  if (values["review-speakers"] && !values["transcribe-missing"]) {
    const missing = positionals.filter(
      (file) => mediaType(file) !== "document" && !existsSync(transcriptCachePath(file)),
    );
    if (missing.length > 0) {
      throw new Error(
        `missing ${missing.length} transcript cache(s):\n${missing.map((file) => `  ${file}`).join("\n")}\nrerun with --transcribe-missing to authorize transcription`,
      );
    }
  }

  for (const file of positionals) {
    const type = mediaType(file);
    console.log(`${file} (${type})`);

    if (type === "document") {
      if (values["review-speakers"]) {
        console.log("  document: no speakers to review");
        continue;
      }
      const chunks = chunkUnits(textToUnits(readFileSync(file, "utf8")));
      console.log(`  ${chunks.length} chunks`);
      for (const chunk of chunks) allRecordsMeta.push({ chunk, file, type, speaker: "" });
      continue;
    }

    const transcript = await getTranscript(
      file,
      !values["review-speakers"] || values["transcribe-missing"],
    );
    if (values["review-speakers"]) {
      printSpeakerReview(file, transcript);
      const source = statSync(file);
      speakerReviews.push({
        sourceFile: file,
        sourceSizeBytes: source.size,
        sourceMtimeMs: source.mtimeMs,
        transcriptId: transcript.id,
        audioDurationSeconds: transcript.audio_duration,
        speakers: summarizeSpeakers(transcript.utterances),
      });
      continue;
    }

    const selection = selectSpeakerForFile(file, transcript.utterances, {
      assignments,
      speaker: values.speaker,
      allowDominant: values["auto-speaker"],
    });
    const speaker = selection.speaker;
    const persona = filterPersonaUtterances(transcript.utterances, speaker);
    const kept = persona.reduce((s, u) => s + (u.end - u.start), 0);
    console.log(
      `  persona speaker=${speaker} (${selection.source}): kept ${persona.length}/${transcript.utterances.length} utterances (${Math.round(kept / 1000)}s of ${transcript.audio_duration}s)`,
    );

    const chunks = chunkUnits(utterancesToUnits(persona));
    console.log(`  ${chunks.length} chunks`);
    for (const chunk of chunks) allRecordsMeta.push({ chunk, file, type, speaker });
    voiceSources.push({ sourceFile: file, utterances: persona });
  }

  if (values["review-speakers"]) {
    const reviewDir = join(OUT_DIR, "speaker-reviews");
    const reviewPath = join(reviewDir, `${slug(personaId)}.json`);
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      reviewPath,
      JSON.stringify(
        {
          personaId,
          generatedAt: new Date().toISOString(),
          files: speakerReviews,
        },
        null,
        2,
      ),
    );
    console.log(
      `speaker review complete: ${reviewPath}; no embeddings, Pinecone writes, or audio clips were performed`,
    );
    return;
  }

  if (values["voice-sample"]) {
    const segments = selectVoiceSampleSegmentsAcrossSources(voiceSources);
    if (segments.length === 0) {
      console.log("voice sample: no selected-speaker segment was long enough, skipping");
    } else {
      const out = clipVoiceSample(segments, personaId);
      const total = segments.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
      console.log(
        `voice sample: ${segments.length} segments from ${new Set(segments.map((segment) => segment.sourceFile)).size} source(s), ${Math.round(total / 1000)}s -> ${out}`,
      );
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
