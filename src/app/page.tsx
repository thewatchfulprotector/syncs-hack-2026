"use client";

import { useEffect, useRef, useState } from "react";
import { AudioQueue } from "@/lib/audioQueue";
import { extractSources } from "@/lib/citations";
import { startMicStream, type MicSession } from "@/lib/micStream";

type Citation = {
  id: string;
  score: number;
  source_file: string;
  media_type: string;
  text: string;
  start_ms?: number;
  end_ms?: number;
};

type Turn = { role: "user" | "assistant"; content: string };
type Timings = Record<string, number | undefined>;
type MicState = "idle" | "connecting" | "listening";

const DEFAULT_PERSONA_ID = "wildfire-expert";

function personaFromUrl(): string {
  if (typeof window === "undefined") return DEFAULT_PERSONA_ID;
  return new URLSearchParams(window.location.search).get("persona") ?? DEFAULT_PERSONA_ID;
}

function formatTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [sources, setSources] = useState<number[]>([]);
  const [citedOnly, setCitedOnly] = useState(false);
  const [status, setStatus] = useState<"idle" | "asking" | "error">("idle");
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  // conversation mode: mic re-arms after each answer until the user clicks it off
  const [conversationMode, setConversationMode] = useState(false);
  const [timings, setTimings] = useState<Timings | null>(null);
  const queueRef = useRef<AudioQueue | null>(null);
  const micRef = useRef<MicSession | null>(null);
  const askingRef = useRef(false);

  useEffect(() => {
    fetch("/api/warmup", { method: "POST" }).catch(() => {});
    return () => micRef.current?.stop();
  }, []);

  function stopMic() {
    micRef.current?.stop();
    micRef.current = null;
    setMicState("idle");
  }

  function startListening() {
    if (micRef.current) return;
    setMicState("connecting");
    micRef.current = startMicStream({
      onReady: () => setMicState("listening"),
      onPartial: (text) => setQuestion(text),
      onTurnEnd: (text) => {
        stopMic();
        setQuestion(text);
        ask(text);
      },
      onError: () => {
        stopMic();
        setConversationMode(false);
        setError("microphone error — try again");
        setStatus("error");
      },
    });
  }

  function toggleMic() {
    if (conversationMode || micState !== "idle") {
      setConversationMode(false);
      stopMic();
      return;
    }
    setConversationMode(true);
    // the re-arm effect below starts the actual session
  }

  // (re)arm the mic whenever conversation mode is on and he's done talking.
  // The short delay rides out the moment between audio sentences where
  // `speaking` can flicker false before the next buffer is scheduled.
  useEffect(() => {
    if (!conversationMode || micState !== "idle" || status === "asking" || speaking) return;
    const timer = setTimeout(startListening, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationMode, micState, status, speaking]);

  async function ask(raw?: string) {
    const q = (raw ?? question).trim();
    // ref, not state: state is stale inside mic callbacks, so a double-fired
    // end-of-turn would submit twice before React re-renders
    if (!q || askingRef.current) return;
    askingRef.current = true;

    // a manual submit while the mic is live pauses the session; conversation
    // mode re-arms it after the answer
    if (micRef.current) stopMic();

    const history = [...turns];
    queueRef.current?.stop();
    const queue = new AudioQueue(setSpeaking);
    queueRef.current = queue;

    setTurns((t) => [...t, { role: "user", content: q }]);
    setQuestion("");
    setStatus("asking");
    setError("");
    setStreamingAnswer("");
    setCitations([]);
    setSources([]);
    setCitedOnly(false);
    setTimings(null);

    const t0 = performance.now();
    let clientFirstAudioMs: number | undefined;
    let full = "";

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: personaFromUrl(), question: q, history }),
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
            setStreamingAnswer(extractSources(full).answer);
          } else if (msg.type === "audio") {
            queue.enqueue(msg.mp3).then(() => {
              clientFirstAudioMs ??= Math.round(performance.now() - t0);
            });
          } else if (msg.type === "citations") {
            setCitations(msg.chunks);
          } else if (msg.type === "sources") {
            setSources(msg.sources);
            setCitedOnly(msg.hasSourcesLine === true);
          } else if (msg.type === "done") {
            setTimings({ ...msg.timings, clientFirstAudioMs });
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        }
      }
      const answer = extractSources(full).answer;
      setTurns((t) => [...t, { role: "assistant", content: answer }]);
      setStreamingAnswer("");
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      askingRef.current = false;
    }
  }

  // an explicit SOURCES line is authoritative (even when empty — small talk
  // cites nothing); only a missing line falls back to showing all retrieved
  const shownCitations = citedOnly
    ? sources.map((n) => citations[n - 1]).filter(Boolean)
    : citations;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center gap-4">
        <div
          data-testid="avatar"
          className={`h-16 w-16 rounded-full bg-gradient-to-br from-amber-600 to-red-700 transition-transform ${speaking ? "animate-pulse scale-105" : ""}`}
        />
        <div>
          <h1 className="text-xl font-semibold">Alexandria</h1>
          <p className="text-sm text-neutral-500">
            {speaking
              ? "speaking…"
              : status === "asking"
                ? "thinking…"
                : micState === "listening"
                  ? "listening…"
                  : micState === "connecting"
                    ? "connecting mic…"
                    : "ask a question"}
          </p>
        </div>
      </header>

      <div id="thread" className="flex flex-col gap-4">
        {turns.map((turn, i) => (
          <div
            key={i}
            className={
              turn.role === "user"
                ? "self-end rounded-2xl bg-neutral-900 px-4 py-2 text-white"
                : "leading-relaxed"
            }
          >
            {turn.content}
          </div>
        ))}
        {streamingAnswer && (
          <div id="answer" className="leading-relaxed">
            {streamingAnswer}
          </div>
        )}
        {status === "error" && <div className="text-sm text-red-600">{error}</div>}
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

      <form
        className="mt-auto flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <button
          id="mic"
          type="button"
          onClick={toggleMic}
          data-mic-state={micState}
          data-conversation={conversationMode}
          className={`rounded-lg border px-4 py-2 transition-colors ${
            micState === "listening"
              ? "border-red-500 bg-red-50 text-red-600 animate-pulse"
              : micState === "connecting"
                ? "border-amber-500 bg-amber-50 text-amber-600"
                : conversationMode
                  ? "border-red-500 bg-red-50 text-red-400"
                  : "border-neutral-300"
          }`}
          title={
            conversationMode || micState !== "idle"
              ? "conversation mode on — click to turn off"
              : "start a voice conversation"
          }
        >
          {micState === "listening" ? (
            "●"
          ) : micState === "connecting" ? (
            <span className="inline-block animate-spin">◌</span>
          ) : conversationMode ? (
            "●"
          ) : (
            "🎤"
          )}
        </button>
        <input
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            micState === "listening"
              ? "listening — just talk…"
              : micState === "connecting"
                ? "connecting mic…"
                : conversationMode
                  ? "conversation mode — mic resumes after he speaks…"
                  : "Ask a question…"
          }
          className="flex-1 rounded-lg border border-neutral-300 px-4 py-2"
        />
        <button
          id="ask"
          type="submit"
          disabled={status === "asking"}
          data-status={status}
          className="rounded-lg bg-neutral-900 px-5 py-2 text-white disabled:opacity-40"
        >
          {status === "asking" ? "…" : "Ask"}
        </button>
      </form>

      {timings && (
        <pre id="timings" className="text-xs text-neutral-400">
          {JSON.stringify(timings)}
        </pre>
      )}
    </main>
  );
}
