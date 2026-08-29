"use client";

import { useEffect, useRef, useState } from "react";
import { AudioQueue } from "@/lib/audioQueue";
import { extractSources } from "@/lib/citations";

type Citation = {
  id: string;
  score: number;
  source_file: string;
  media_type: string;
  text: string;
  start_ms?: number;
  end_ms?: number;
};

type Timings = Record<string, number | undefined>;

const PERSONA_ID = "wildfire-expert";

function formatTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [sources, setSources] = useState<number[]>([]);
  const [status, setStatus] = useState<"idle" | "asking" | "error">("idle");
  const [speaking, setSpeaking] = useState(false);
  const [timings, setTimings] = useState<Timings | null>(null);
  const queueRef = useRef<AudioQueue | null>(null);

  useEffect(() => {
    fetch("/api/warmup", { method: "POST" }).catch(() => {});
  }, []);

  async function ask() {
    const q = question.trim();
    if (!q || status === "asking") return;

    queueRef.current?.stop();
    const queue = new AudioQueue(setSpeaking);
    queueRef.current = queue;

    setStatus("asking");
    setAnswer("");
    setCitations([]);
    setSources([]);
    setTimings(null);

    const t0 = performance.now();
    let clientFirstAudioMs: number | undefined;
    let full = "";

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: PERSONA_ID, question: q }),
      });
      if (!res.ok || !res.body) throw new Error(`ask failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === "token") {
            full += msg.text;
            setAnswer(full);
          } else if (msg.type === "audio") {
            queue.enqueue(msg.mp3).then(() => {
              clientFirstAudioMs ??= Math.round(performance.now() - t0);
            });
          } else if (msg.type === "citations") {
            setCitations(msg.chunks);
          } else if (msg.type === "sources") {
            setSources(msg.sources);
            setAnswer(extractSources(full).answer);
          } else if (msg.type === "done") {
            setTimings({ ...msg.timings, clientFirstAudioMs });
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        }
      }
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setAnswer(err instanceof Error ? err.message : String(err));
    }
  }

  const shownCitations =
    sources.length > 0 ? sources.map((n) => citations[n - 1]).filter(Boolean) : citations;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center gap-4">
        <div
          data-testid="avatar"
          className={`h-16 w-16 rounded-full bg-gradient-to-br from-amber-600 to-red-700 transition-transform ${speaking ? "animate-pulse scale-105" : ""}`}
        />
        <div>
          <h1 className="text-xl font-semibold">Alexandria</h1>
          <p className="text-sm text-neutral-500">Ask the air quality expert</p>
        </div>
      </header>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question…"
          className="flex-1 rounded-lg border border-neutral-300 px-4 py-2"
        />
        <button
          id="ask"
          type="submit"
          disabled={status === "asking"}
          className="rounded-lg bg-neutral-900 px-5 py-2 text-white disabled:opacity-40"
        >
          {status === "asking" ? "…" : "Ask"}
        </button>
      </form>

      <div id="answer" data-status={status} data-speaking={speaking} className="min-h-24 whitespace-pre-wrap leading-relaxed">
        {answer}
      </div>

      {shownCitations.length > 0 && (
        <div id="citations" className="flex flex-wrap gap-2">
          {shownCitations.map((c) => (
            <span
              key={c.id}
              title={c.text}
              className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600"
            >
              {c.source_file}
              {c.start_ms !== undefined && ` @ ${formatTimestamp(c.start_ms)}`}
            </span>
          ))}
        </div>
      )}

      {timings && (
        <pre id="timings" className="text-xs text-neutral-400">
          {JSON.stringify(timings)}
        </pre>
      )}
    </main>
  );
}
