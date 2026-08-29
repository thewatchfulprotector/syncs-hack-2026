// Shared ffmpeg glue for turning selected persona speech into one local audio
// file. Kept out of src/lib/ because it shells out (I/O) — the pure segment
// selection lives in src/lib/voiceSample.ts. Reused by ingest.ts and
// build-voice-sample.ts so the clipping logic exists in exactly one place.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SourceVoiceSegment } from "../src/lib/voiceSample";

export const OUT_DIR = "out";

export function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

export function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/** Concatenate selected segments from any number of sources into one sample. */
export function clipVoiceSample(segments: SourceVoiceSegment[], personaId: string): string {
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
