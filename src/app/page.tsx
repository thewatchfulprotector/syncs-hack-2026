"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioQueue } from "@/lib/audioQueue";
import { chunkSentence, tailWords } from "@/lib/captions";
import { extractSources } from "@/lib/citations";
import { isLikelyEcho } from "@/lib/echoGuard";
import { prefetchSttToken, startMicStream, type MicSession } from "@/lib/micStream";
import { capConversationHistory } from "@/lib/prompt";
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

type TraceMilestone = {
  name: string;
  atMs: number;
  detail?: Record<string, unknown>;
};

type ClientTurnTrace = {
  correlationId: string;
  startedAt: number;
  milestones: TraceMilestone[];
};

const DEFAULT_PERSONA_ID = "wildfire-expert";
type MicState = "idle" | "requesting-permission" | "capturing" | "ready";

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

function decodeBase64Chunk(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function joinAudioChunks(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function newCorrelationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

const MONO = "font-[family-name:var(--font-plex-mono)]";

export default function Home() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [caption, setCaption] = useState("");
  const [capVisible, setCapVisible] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "asking">("idle");
  const [speaking, setSpeaking] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  const [conversationMode, setConversationMode] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [timings, setTimings] = useState<string>("");
  // read after mount: the URL isn't known during server render
  const [personaId, setPersonaId] = useState(DEFAULT_PERSONA_ID);
  const debug =
    typeof window !== "undefined" && window.location.search.includes("debug");

  const queueRef = useRef<AudioQueue | null>(null);
  const micRef = useRef<MicSession | null>(null);
  const askingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const conversationModeRef = useRef(false);
  const turnEpochRef = useRef(0);
  const captureReadyRef = useRef(false);
  const transportReadyRef = useRef(false);
  const speakingRef = useRef(false);
  const askImplRef = useRef<(raw: string) => void>(() => {});
  const activeClientTraceRef = useRef<ClientTurnTrace | null>(null);
  const pulseRef = useRef<OrbPulse>({ kickAt: -9999, emph: 0.8 });
  // Per-segment playback times prevent a new sentence from making an old
  // phrase look recent again to the speaker-to-mic echo guard.
  const recentSpeechRef = useRef<Array<{ text: string; echoUntil: number }>>([]);
  const captionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const phase: OrbPhase = speaking
    ? "speaking"
    : status === "asking"
      ? "thinking"
      : micState === "ready"
        ? "listening"
        : "idle";

  useEffect(() => {
    const turnEpoch = turnEpochRef;
    const asking = askingRef;
    const activeAbort = abortRef;
    const mic = micRef;
    const queue = queueRef;
    const syncUrlState = setTimeout(() => {
      setPersonaId(personaFromUrl());
    }, 0);
    prefetchSttToken();
    const t = setTimeout(() => {
      setCaption("Tap the orb and say something.");
      setCapVisible(true);
    }, 420);
    return () => {
      clearTimeout(t);
      clearTimeout(syncUrlState);
      turnEpoch.current++;
      asking.current = false;
      activeAbort.current?.abort();
      activeAbort.current = null;
      mic.current?.stop();
      queue.current?.dispose();
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

  function recordClientMilestone(name: string, detail?: Record<string, unknown>) {
    const active = activeClientTraceRef.current;
    if (!active) return;
    const previous = active.milestones.at(-1)?.atMs ?? 0;
    const atMs = Math.max(previous, performance.now() - active.startedAt);
    active.milestones.push({ name, atMs, ...(detail ? { detail } : {}) });
  }

  function recordClientMilestoneOnce(name: string, detail?: Record<string, unknown>) {
    if (activeClientTraceRef.current?.milestones.some((event) => event.name === name)) return;
    recordClientMilestone(name, detail);
  }

  function beginClientTrace(): ClientTurnTrace {
    const trace = {
      correlationId: newCorrelationId(),
      startedAt: performance.now(),
      milestones: [],
    };
    activeClientTraceRef.current = trace;
    return trace;
  }

  function ensureQueue(): AudioQueue {
    if (!queueRef.current) {
      queueRef.current = new AudioQueue(
        (value) => {
          speakingRef.current = value;
          setSpeaking(value);
        },
        (sentence, durationSec) => {
          recentSpeechRef.current.push({
            text: sentence,
            echoUntil: performance.now() + durationSec * 1000 + 5000,
          });
          if (recentSpeechRef.current.length > 32) recentSpeechRef.current.shift();
          speakCaptions(sentence, durationSec);
        },
        () => recordClientMilestone("first_pcm_source_scheduled"),
      );
    }
    return queueRef.current;
  }

  function recentEchoText(): string {
    const now = performance.now();
    recentSpeechRef.current = recentSpeechRef.current.filter(
      (segment) => segment.echoUntil >= now,
    );
    return recentSpeechRef.current.map((segment) => segment.text).join(" ").slice(-2000);
  }

  function stopMic() {
    micRef.current?.stop();
    micRef.current = null;
    captureReadyRef.current = false;
    transportReadyRef.current = false;
    setMicState("idle");
  }

  function startListening() {
    if (micRef.current) return;
    captureReadyRef.current = false;
    transportReadyRef.current = false;
    setMicState("requesting-permission");
    setNotice("");
    const micTrace = activeClientTraceRef.current ?? beginClientTrace();
    micRef.current = startMicStream({
      correlationId: micTrace.correlationId,
      getCorrelationId: () => activeClientTraceRef.current?.correlationId,
      onTrace: (event) => recordClientMilestone(event.name, event.detail),
      onCaptureReady: () => {
        captureReadyRef.current = true;
        setMicState(transportReadyRef.current ? "ready" : "capturing");
      },
      onReady: () => {
        transportReadyRef.current = true;
        if (captureReadyRef.current) setMicState("ready");
      },
      onPartial: (text) => {
        // don't caption the persona's own voice leaking back through the mic
        if (isLikelyEcho(text, recentEchoText())) return;
        showCaption(tailWords(text, 10));
      },
      onTurnEnd: (text) => {
        // Played speech is tracked only when its source actually starts and is
        // bounded to the post-playback echo window.
        if (isLikelyEcho(text, recentEchoText())) {
          setCapVisible(false);
          return;
        }
        micRef.current?.setFrameForwarding(false);
        askImplRef.current(text);
      },
      onError: () => {
        stopMic();
        conversationModeRef.current = false;
        setConversationMode(false);
        setNotice("Microphone unavailable — check permissions and try again.");
      },
    });
  }

  /** Fully end the conversation: in-flight turn, playback, and capture. */
  function stopConversation() {
    conversationModeRef.current = false;
    setConversationMode(false);
    // invalidate the in-flight turn so its cleanup can't resume the mic
    turnEpochRef.current++;
    askingRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    queueRef.current?.stop();
    queueRef.current?.dispose();
    queueRef.current = null;
    clearCaptionTimers();
    stopMic();
    setStatus("idle");
    speakingRef.current = false;
    setSpeaking(false);
    setCapVisible(false);
    activeClientTraceRef.current = null;
  }

  /** Off enables capture immediately. During output, the same click is barge-in. */
  function toggleMicImpl() {
    if (conversationModeRef.current) {
      if (askingRef.current || speakingRef.current) {
        recordClientMilestone("manual_barge_in");
        turnEpochRef.current++;
        askingRef.current = false;
        abortRef.current?.abort();
        abortRef.current = null;
        queueRef.current?.stop();
        micRef.current?.setFrameForwarding(true);
        clearCaptionTimers();
        speakingRef.current = false;
        setStatus("idle");
        setSpeaking(false);
        setCapVisible(false);
        beginClientTrace();
        recordClientMilestone("turn_armed_after_interruption");
        return;
      }

      stopConversation();
      return;
    }

    conversationModeRef.current = true;
    setConversationMode(true);
    const clickTrace = beginClientTrace();
    recordClientMilestone("mic_click");
    const queue = ensureQueue();
    recordClientMilestone("playback_context_unlock_start");
    void queue.unlock().then(
      () => {
        if (activeClientTraceRef.current?.correlationId === clickTrace.correlationId) {
          recordClientMilestone("playback_context_running");
        }
      },
      (err) => setNotice(err instanceof Error ? err.message : String(err)),
    );
    // This synchronous call is part of the user gesture—there is no timer.
    startListening();
  }

  const toggleMic = toggleMicImpl;

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

  async function ask(raw: string) {
    const q = raw.trim();
    // ref, not state: state is stale inside mic callbacks, so a double-fired
    // end-of-turn would submit twice before React re-renders
    if (!q || askingRef.current) return;
    askingRef.current = true;
    const epoch = ++turnEpochRef.current;
    micRef.current?.setFrameForwarding(false);
    clearCaptionTimers();
    const queue = ensureQueue();
    queue.beginAnswer();
    const turnDrain = queue.queueDrained;
    const abort = new AbortController();
    abortRef.current = abort;

    const history = capConversationHistory(
      turns.map((t) => ({
        role: t.who === "You" ? ("user" as const) : ("assistant" as const),
        content: t.text,
      })),
    );
    setTurns((t) => [...t, { who: "You", text: q, sources: [] }]);
    setStatus("asking");
    setNotice("");
    // show the question exactly as heard while it thinks: live partials lag
    // behind short utterances, so this is the "it heard me" receipt
    showCaption(q);
    setTimings("");

    const t0 = performance.now();
    let clientTrace = activeClientTraceRef.current;
    if (
      !clientTrace ||
      clientTrace.milestones.some((milestone) => milestone.name === "ask_request_start")
    ) {
      clientTrace = beginClientTrace();
    }
    const correlationId = clientTrace.correlationId;
    recordClientMilestone("ask_request_start");
    let full = "";
    let citations: Citation[] = [];
    let answerSources: Citation[] = [];
    let audioComplete = false;
    let firstAudioPacketMs: number | undefined;
    let serverTimings: Record<string, unknown> = {};
    let serverTrace: unknown;
    const audioSentences = new Map<number, { text: string; chunks: Uint8Array[] }>();
    const observeAudioTask = (task: Promise<void>) => {
      void task.catch((error) => {
        if (epoch === turnEpochRef.current) {
          setNotice(`Audio playback skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    };

    const publishTrace = () => {
      if (epoch !== turnEpochRef.current) return;
      const clientTrace = activeClientTraceRef.current;
      setTimings(
        JSON.stringify({
          correlationId,
          ...serverTimings,
          clientFirstAudioPacketMs: firstAudioPacketMs,
          serverTrace,
          clientTrace:
            clientTrace?.correlationId === correlationId
              ? {
                  correlationId,
                  milestones: [...clientTrace.milestones],
                }
              : undefined,
        }),
      );
    };

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Correlation-Id": correlationId },
        signal: abort.signal,
        body: JSON.stringify({ personaId, question: q, history }),
      });
      if (!res.ok || !res.body) throw new Error(`ask failed: ${res.status}`);

      const reader = res.body.getReader();
      try {
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
            } else if (msg.type === "audio_chunk") {
              if (firstAudioPacketMs === undefined) {
                firstAudioPacketMs = Math.round(performance.now() - t0);
                recordClientMilestone("first_audio_packet");
              }
              const bytes = decodeBase64Chunk(msg.audioBase64);
              if (
                msg.format === "pcm_s16le" &&
                msg.channels === 1 &&
                Number.isFinite(Number(msg.sampleRate))
              ) {
                observeAudioTask(
                  queue.enqueuePcm16(
                    bytes,
                    Number(msg.chunkSeq) === 0 && typeof msg.text === "string"
                      ? msg.text
                      : "",
                    Number(msg.sampleRate),
                  ),
                );
                continue;
              }
              const sentenceSeq = Number(msg.sentenceSeq);
              const pending: { text: string; chunks: Uint8Array[] } = audioSentences.get(
                sentenceSeq,
              ) ?? {
                text: typeof msg.text === "string" ? msg.text : "",
                chunks: [],
              };
              pending.chunks.push(bytes);
              audioSentences.set(sentenceSeq, pending);
            } else if (msg.type === "audio_sentence_complete") {
              const sentenceSeq = Number(msg.sentenceSeq);
              const pending = audioSentences.get(sentenceSeq);
              if (pending && pending.chunks.length > 0) {
                observeAudioTask(
                  queue.enqueueBytes(joinAudioChunks(pending.chunks), pending.text),
                );
                audioSentences.delete(sentenceSeq);
              }
            } else if (msg.type === "audio") {
              // Transitional compatibility with an older deployed server.
              observeAudioTask(queue.enqueue(msg.mp3, msg.text));
            } else if (msg.type === "citations") {
              citations = msg.chunks;
            } else if (msg.type === "sources") {
              answerSources =
                msg.hasSourcesLine === true
                  ? (msg.sources as number[]).map((n) => citations[n - 1]).filter(Boolean)
                  : citations;
            } else if (msg.type === "generation_complete") {
              // Stay "thinking" until playback starts: the mic is held ready
              // across turns, so idling status before the first sentence is
              // scheduled flashes the orb back to green "listening".
            } else if (msg.type === "audio_complete") {
              if (epoch === turnEpochRef.current) {
                audioComplete = true;
                queue.markInputComplete();
              }
            } else if (msg.type === "done") {
              serverTimings = msg.timings ?? {};
              serverTrace = msg.trace;
              publishTrace();
            } else if (msg.type === "error") {
              throw new Error(msg.message);
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const answer = extractSources(full).answer;
      if (epoch === turnEpochRef.current) {
        setTurns((t) => [
          ...t,
          { who: personaName(personaId), text: answer, sources: answerSources },
        ]);
      }
    } catch (err) {
      const wasAborted = abort.signal.aborted;
      if (!wasAborted) abort.abort(err);
      if (epoch === turnEpochRef.current) setStatus("idle");
      if (epoch === turnEpochRef.current && !wasAborted) {
        setNotice(err instanceof Error ? err.message : String(err));
        setCapVisible(false);
      }
    } finally {
      if (epoch === turnEpochRef.current && !audioComplete) queue.markInputComplete();
      await turnDrain;
      if (epoch === turnEpochRef.current) {
        recordClientMilestone("playback_drained");
        askingRef.current = false;
        abortRef.current = null;
        setStatus("idle");
        if (conversationModeRef.current) {
          micRef.current?.setFrameForwarding(true);
          recordClientMilestoneOnce("mic_forwarding_resumed");
        }
        publishTrace();
        if (conversationModeRef.current) {
          beginClientTrace();
          recordClientMilestone("turn_armed");
        }
      }
    }
  }

  useEffect(() => {
    askImplRef.current = ask;
  });

  const sampleAmp = useCallback((): number | null => {
    if (micRef.current) return micRef.current.amplitude();
    if (queueRef.current) return queueRef.current.amplitude();
    return null;
  }, []);

  const stateLabel =
    micState === "requesting-permission"
      ? "Requesting microphone"
      : micState === "capturing"
        ? "Preparing audio · connecting"
        : phase === "listening"
          ? "Listening"
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
    <main className="app-height relative flex min-h-[480px] flex-col overflow-x-hidden overflow-y-auto bg-white text-[#0A0A0A] font-[family-name:var(--font-grotesk)]">
      <div className={`flex shrink-0 items-center justify-between gap-3 px-5 py-4 text-[10px] uppercase tracking-[0.16em] sm:px-[30px] sm:py-[26px] ${MONO}`}>
        <div className="flex min-w-0 items-center gap-[9px]">
          <span
            className="h-[5px] w-[5px] shrink-0 rounded-full transition-colors duration-300"
            style={{ background: dotColor, opacity: phase === "idle" && !conversationMode ? 0.6 : 1 }}
          />
          <span className="truncate">{stateLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-[9px]">
          <span className="opacity-60">{persona}</span>
          <span className="mx-[6px] h-[11px] w-px bg-[#E4E4E4]" />
          <button
            onClick={() => setPanelOpen((p) => !p)}
            className="touch-manipulation uppercase tracking-[0.16em] transition-opacity hover:opacity-60"
          >
            Transcript
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 sm:px-8">
        <Orb phase={phase} sampleAmp={sampleAmp} pulse={pulseRef} onClick={toggleMic} />
        <div
          onClick={() => setPanelOpen(true)}
          className="flex w-full max-w-[960px] cursor-pointer flex-col items-center gap-3 pt-4 text-center sm:gap-[18px] sm:pt-5"
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

      <div className="flex w-full shrink-0 flex-col items-center gap-[14px] px-5 pb-[max(clamp(20px,4vh,38px),env(safe-area-inset-bottom))] sm:px-8">
        <div className="flex w-full max-w-[480px] items-center justify-center gap-3 sm:gap-4">
          <button
            onClick={() => (conversationModeRef.current ? stopConversation() : toggleMic())}
            title={conversationMode ? "conversation on — click to stop" : "start a voice conversation"}
            data-mic-state={micState}
            data-conversation={conversationMode}
            className="flex h-[52px] w-[52px] shrink-0 touch-manipulation items-center justify-center rounded-full border transition-all hover:scale-105"
            style={{
              borderColor:
                phase === "listening" ? "#18A15C" : conversationMode ? "#1F3BE0" : "#E4E4E4",
            }}
          >
            {phase === "listening" || conversationMode ? (
              <span
                className={`h-[14px] w-[14px] ${phase === "listening" ? "animate-pulse rounded-full" : "rounded-[3px]"}`}
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
              // Start/resume playback inside the keyboard user activation so
              // type-only answers are not blocked by autoplay policy later.
              void ensureQueue()
                .unlock()
                .catch((err) => setNotice(err instanceof Error ? err.message : String(err)));
              ask(v);
            }}
            placeholder="or type here"
            className="min-w-0 max-w-[400px] flex-1 border-b border-[#EAEAEA] bg-transparent px-0.5 py-[11px] text-left text-base font-light outline-none placeholder:text-neutral-400 sm:text-sm"
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
        className="fixed bottom-0 right-0 top-0 z-20 flex w-[min(400px,88vw)] flex-col border-l border-[#EAEAEA] bg-white transition-transform duration-500"
        style={{
          transform: panelOpen ? "translateX(0)" : "translateX(101%)",
          transitionTimingFunction: "cubic-bezier(0.22,0.61,0.24,1)",
        }}
      >
        <div className={`flex items-center justify-between px-[26px] pb-[18px] pt-[26px] text-[10px] uppercase tracking-[0.16em] ${MONO}`}>
          <span>Transcript</span>
          <button onClick={() => setPanelOpen(false)} className="touch-manipulation text-xs tracking-[0.16em] hover:opacity-60">
            Close
          </button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-[26px] pb-[max(2rem,env(safe-area-inset-bottom))]">
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
