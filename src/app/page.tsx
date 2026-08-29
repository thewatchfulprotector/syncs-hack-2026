"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioQueue } from "@/lib/audioQueue";
import { chunkSentence, tailWords } from "@/lib/captions";
import { extractSources } from "@/lib/citations";
import { isLikelyEcho } from "@/lib/echoGuard";
import { startMicStream, type MicSession } from "@/lib/micStream";
import { Orb, type OrbPhase, type OrbPulse } from "./orb";

type Citation = {
  id: string;
  score: number;
  source_file: string;
  media_type: string;
  text: string;
  start_ms?: number;
  end_ms?: number;
};

type Turn = {
  who: string;
  text: string;
  sources: Citation[];
};

const DEFAULT_PERSONA_ID = "wildfire-expert";

function personaFromUrl(): string {
  if (typeof window === "undefined") return DEFAULT_PERSONA_ID;
  return new URLSearchParams(window.location.search).get("persona") ?? DEFAULT_PERSONA_ID;
}

function personaName(id: string): string {
  return id
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function formatTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const MONO = "font-[family-name:var(--font-plex-mono)]";

export default function Home() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [caption, setCaption] = useState("");
  const [capVisible, setCapVisible] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "asking">("idle");
  const [speaking, setSpeaking] = useState(false);
  const [micState, setMicState] = useState<"idle" | "connecting" | "listening">("idle");
  const [conversationMode, setConversationMode] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [timings, setTimings] = useState<string>("");
  // read after mount: the URL isn't known during server render
  const [personaId, setPersonaId] = useState(DEFAULT_PERSONA_ID);
  const [debug, setDebug] = useState(false);

  const queueRef = useRef<AudioQueue | null>(null);
  const micRef = useRef<MicSession | null>(null);
  const askingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pulseRef = useRef<OrbPulse>({ kickAt: -9999, emph: 0.8 });
  // everything recently played aloud, for the speaker-to-mic echo guard
  const recentSpeechRef = useRef("");
  const captionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const phase: OrbPhase = speaking
    ? "speaking"
    : status === "asking"
      ? "thinking"
      : micState !== "idle"
        ? "listening"
        : "idle";

  useEffect(() => {
    setPersonaId(personaFromUrl());
    setDebug(window.location.search.includes("debug"));
    fetch("/api/warmup", { method: "POST" }).catch(() => {});
    const t = setTimeout(() => {
      setCaption("Tap the orb and say something.");
      setCapVisible(true);
    }, 420);
    return () => {
      clearTimeout(t);
      micRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, panelOpen]);

  function showCaption(text: string) {
    setCaption(text);
    setCapVisible(true);
  }

  function clearCaptionTimers() {
    for (const t of captionTimers.current) clearTimeout(t);
    captionTimers.current = [];
  }

  function stopMic() {
    micRef.current?.stop();
    micRef.current = null;
    setMicState("idle");
  }

  function startListening() {
    if (micRef.current) return;
    setMicState("connecting");
    setNotice("");
    micRef.current = startMicStream({
      onReady: () => setMicState("listening"),
      onPartial: (text) => {
        // don't caption the persona's own voice leaking back through the mic
        if (isLikelyEcho(text, recentSpeechRef.current)) return;
        showCaption(tailWords(text, 10));
      },
      onTurnEnd: (text) => {
        stopMic();
        // his own voice coming back through the speakers is not a question —
        // drop it and let conversation mode re-open the mic
        if (isLikelyEcho(text, recentSpeechRef.current)) {
          setCapVisible(false);
          return;
        }
        ask(text);
      },
      onError: () => {
        stopMic();
        setConversationMode(false);
        setNotice("Microphone unavailable — check permissions and try again.");
      },
    });
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

  /** Orb / mic click: a hard toggle. Off → arm the conversation; anything else → stop it all. */
  const toggleMic = useCallback(() => {
    const active =
      conversationMode || micState !== "idle" || phase === "speaking" || phase === "thinking";
    if (active) {
      setConversationMode(false);
      abortRef.current?.abort();
      queueRef.current?.stop();
      clearCaptionTimers();
      stopMic();
      setStatus("idle");
      setSpeaking(false);
      setCapVisible(false);
      return;
    }
    setConversationMode(true);
    // the re-arm effect starts the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, micState, conversationMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggleMic();
      }
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMic]);

  function speakCaptions(sentence: string, durationSec: number) {
    const chunks = chunkSentence(sentence);
    const per = (durationSec * 1000) / chunks.length;
    chunks.forEach((chunk, i) => {
      captionTimers.current.push(
        setTimeout(() => {
          showCaption(chunk);
          pulseRef.current = { kickAt: performance.now(), emph: 0.55 + Math.random() * 0.45 };
        }, i * per),
      );
    });
  }

  async function ask(raw: string) {
    const q = raw.trim();
    // ref, not state: state is stale inside mic callbacks, so a double-fired
    // end-of-turn would submit twice before React re-renders
    if (!q || askingRef.current) return;
    askingRef.current = true;

    if (micRef.current) stopMic();
    queueRef.current?.stop();
    clearCaptionTimers();
    const queue = new AudioQueue(setSpeaking, speakCaptions);
    queueRef.current = queue;
    const abort = new AbortController();
    abortRef.current = abort;

    const history = turns.map((t) => ({
      role: t.who === "You" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    }));
    setTurns((t) => [...t, { who: "You", text: q, sources: [] }]);
    setStatus("asking");
    setNotice("");
    // show the question exactly as heard while it thinks: live partials lag
    // behind short utterances, so this is the "it heard me" receipt
    showCaption(q);
    setTimings("");

    const t0 = performance.now();
    let full = "";
    let citations: Citation[] = [];
    let answerSources: Citation[] = [];

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ personaId, question: q, history }),
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
          } else if (msg.type === "audio") {
            recentSpeechRef.current = (recentSpeechRef.current + " " + msg.text).slice(-2000);
            queue.enqueue(msg.mp3, msg.text);
          } else if (msg.type === "citations") {
            citations = msg.chunks;
          } else if (msg.type === "sources") {
            answerSources =
              msg.hasSourcesLine === true
                ? (msg.sources as number[]).map((n) => citations[n - 1]).filter(Boolean)
                : citations;
          } else if (msg.type === "done") {
            setTimings(JSON.stringify(msg.timings));
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        }
      }
      const answer = extractSources(full).answer;
      setTurns((t) => [...t, { who: personaName(personaId), text: answer, sources: answerSources }]);
      setStatus("idle");
    } catch (err) {
      setStatus("idle");
      if (!abort.signal.aborted) {
        setNotice(err instanceof Error ? err.message : String(err));
        setCapVisible(false);
      }
    } finally {
      askingRef.current = false;
    }
  }

  const sampleAmp = useCallback((): number | null => {
    if (micRef.current) return micRef.current.amplitude();
    if (queueRef.current) return queueRef.current.amplitude();
    return null;
  }, []);

  const stateLabel =
    phase === "listening"
      ? micState === "connecting"
        ? "Connecting"
        : "Listening"
      : phase === "thinking"
        ? "Thinking"
        : phase === "speaking"
          ? "Speaking"
          : conversationMode
            ? "Armed"
            : "Idle";
  const dotColor =
    phase === "listening" ? "#18A15C" : phase === "idle" && !conversationMode ? "#C9C9C9" : "#1F3BE0";
  const persona = personaName(personaId);

  return (
    <main className="relative flex h-screen min-h-[480px] flex-col overflow-hidden bg-white text-[#0A0A0A] font-[family-name:var(--font-grotesk)]">
      <div className={`flex items-center justify-between px-[30px] py-[26px] text-[10px] uppercase tracking-[0.16em] ${MONO}`}>
        <div className="flex items-center gap-[9px]">
          <span
            className="h-[5px] w-[5px] rounded-full transition-colors duration-300"
            style={{ background: dotColor, opacity: phase === "idle" && !conversationMode ? 0.6 : 1 }}
          />
          <span>{stateLabel}</span>
        </div>
        <div className="flex items-center gap-[9px]">
          <span className="opacity-60">{persona}</span>
          <span className="mx-[6px] h-[11px] w-px bg-[#E4E4E4]" />
          <button
            onClick={() => setPanelOpen((p) => !p)}
            className="uppercase tracking-[0.16em] transition-opacity hover:opacity-60"
          >
            Transcript
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8">
        <Orb phase={phase} sampleAmp={sampleAmp} pulse={pulseRef} onClick={toggleMic} />
        <div
          onClick={() => setPanelOpen(true)}
          className="flex w-full max-w-[960px] cursor-pointer flex-col items-center gap-[18px] pt-5 text-center"
        >
          <div
            className="min-h-[1.4em] max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[clamp(16px,1.85vw,26px)] font-light leading-[1.4] tracking-[-0.01em] transition-all duration-500"
            style={{ opacity: capVisible ? 1 : 0, transform: capVisible ? "none" : "translateY(6px)" }}
          >
            {caption}
          </div>
          <div
            className={`text-[9px] uppercase tracking-[0.18em] transition-opacity ${MONO}`}
            style={{ opacity: turns.length > 0 && !panelOpen ? 0.45 : 0 }}
          >
            Open transcript
          </div>
        </div>
      </div>

      <div className="flex flex-col items-center gap-[14px] px-8 pb-[clamp(20px,4vh,38px)]">
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={toggleMic}
            title={conversationMode ? "conversation on — click to stop" : "start a voice conversation"}
            data-mic-state={micState}
            data-conversation={conversationMode}
            className="flex h-[52px] w-[52px] items-center justify-center rounded-full border transition-all hover:scale-105"
            style={{
              borderColor:
                phase === "listening" ? "#18A15C" : conversationMode ? "#1F3BE0" : "#E4E4E4",
            }}
          >
            {phase === "listening" || conversationMode ? (
              <span
                className={`h-[15px] w-[15px] rounded-full ${phase === "listening" ? "animate-pulse" : ""}`}
                style={{ background: phase === "listening" ? "#18A15C" : "#1F3BE0" }}
              />
            ) : (
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#0A0A0A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9.25" y="3" width="5.5" height="10.5" rx="2.75" />
                <path d="M5.5 11.2a6.5 6.5 0 0 0 13 0" />
                <path d="M12 17.7v3.1" />
              </svg>
            )}
          </button>
          <input
            id="question"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = draft.trim();
              if (!v) return;
              setDraft("");
              ask(v);
            }}
            placeholder="or type here"
            className="w-[min(400px,66vw)] border-b border-[#EAEAEA] bg-transparent px-0.5 py-[11px] text-left text-sm font-light outline-none placeholder:text-neutral-400"
          />
        </div>
        {notice && (
          <div className={`max-w-[420px] text-center text-[9px] uppercase leading-[1.7] tracking-[0.14em] text-[#9A9A9A] ${MONO}`}>
            {notice}
          </div>
        )}
        {debug && timings && (
          <pre id="timings" className={`text-[9px] text-[#C9C9C9] ${MONO}`}>{timings}</pre>
        )}
      </div>

      <div
        className="absolute bottom-0 right-0 top-0 flex w-[min(400px,88vw)] flex-col border-l border-[#EAEAEA] bg-white transition-transform duration-500"
        style={{
          transform: panelOpen ? "translateX(0)" : "translateX(101%)",
          transitionTimingFunction: "cubic-bezier(0.22,0.61,0.24,1)",
        }}
      >
        <div className={`flex items-center justify-between px-[26px] pb-[18px] pt-[26px] text-[10px] uppercase tracking-[0.16em] ${MONO}`}>
          <span>Transcript</span>
          <button onClick={() => setPanelOpen(false)} className="text-xs tracking-[0.16em] hover:opacity-60">
            Close
          </button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-[26px] pb-8">
          {turns.length === 0 && (
            <div className="pt-1.5 text-sm font-light leading-relaxed text-[#9A9A9A]">Nothing said yet.</div>
          )}
          {turns.map((turn, i) => {
            const isUser = turn.who === "You";
            return (
              <div
                key={i}
                className={`flex flex-col border-t border-[#F1F1F1] py-5 first:border-t-0 ${isUser ? "items-end text-right" : "items-start text-left"}`}
              >
                <div className={`mb-[9px] text-[9px] uppercase tracking-[0.18em] text-[#9A9A9A] ${MONO}`}>
                  {turn.who}
                </div>
                <div
                  className={`${isUser ? "max-w-[80%]" : "max-w-[88%]"} text-[15px] font-light leading-[1.58]`}
                  style={{ color: isUser ? "#6E6E6E" : "#0A0A0A", textWrap: "pretty" }}
                >
                  {turn.text}
                </div>
                {turn.sources.length > 0 && (
                  <div className={`mt-[13px] flex flex-wrap gap-1.5 ${isUser ? "justify-end" : ""}`}>
                    {turn.sources.map((c) => (
                      <span
                        key={c.id}
                        title={c.text}
                        className={`inline-flex items-center whitespace-nowrap rounded-[2px] border border-[#E4E4E4] px-2 py-[5px] text-[9px] uppercase tracking-[0.12em] transition-colors hover:border-[#0A0A0A] ${MONO}`}
                      >
                        {c.source_file.replace(/\.[a-z0-9]+$/i, "").slice(0, 32)}
                        {c.start_ms !== undefined && ` · ${formatTimestamp(c.start_ms)}`}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
