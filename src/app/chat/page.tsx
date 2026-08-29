"use client";

import { useEffect, useRef, useState } from "react";
import { extractSources, stripStreamingSourcesTail } from "@/lib/citations";
import { DEFAULT_PERSONA_ID, personas, personaTitle } from "@/lib/personas";
import { capConversationHistory } from "@/lib/prompt";

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

function personaFromUrl(): string {
  if (typeof window === "undefined") return DEFAULT_PERSONA_ID;
  return new URLSearchParams(window.location.search).get("persona") ?? DEFAULT_PERSONA_ID;
}

function formatTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const MONO = "font-[family-name:var(--font-plex-mono)]";

function SourceChips({ sources, alignEnd }: { sources: Citation[]; alignEnd: boolean }) {
  if (sources.length === 0) return null;
  return (
    <div className={`mt-[13px] flex flex-wrap gap-1.5 ${alignEnd ? "justify-end" : ""}`}>
      {sources.map((c) => (
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
  );
}

export default function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamText, setStreamText] = useState("");
  const [status, setStatus] = useState<"idle" | "asking">("idle");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  // read after mount: the URL isn't known during server render
  const [personaId, setPersonaId] = useState(DEFAULT_PERSONA_ID);

  const askingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const turnEpochRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const epoch = turnEpochRef;
    const asking = askingRef;
    const activeAbort = abortRef;
    const syncUrlState = setTimeout(() => setPersonaId(personaFromUrl()), 0);
    return () => {
      clearTimeout(syncUrlState);
      epoch.current++;
      asking.current = false;
      activeAbort.current?.abort();
      activeAbort.current = null;
    };
  }, []);

  // Follow the stream only when the reader is already near the bottom, so
  // scrolling up to reread an earlier answer is never fought.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns, streamText]);

  function stopAnswer() {
    abortRef.current?.abort();
  }

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q || askingRef.current) return;
    askingRef.current = true;
    const epoch = ++turnEpochRef.current;
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
    setStreamText("");
    setNotice("");

    let full = "";
    let citations: Citation[] = [];
    let answerSources: Citation[] = [];
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ personaId, question: q, history, voice: false }),
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
              if (epoch === turnEpochRef.current) {
                setStreamText(stripStreamingSourcesTail(full));
              }
            } else if (msg.type === "citations") {
              citations = msg.chunks;
            } else if (msg.type === "sources") {
              answerSources =
                msg.hasSourcesLine === true
                  ? (msg.sources as number[]).map((n) => citations[n - 1]).filter(Boolean)
                  : citations;
            } else if (msg.type === "error") {
              throw new Error(msg.message);
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (epoch === turnEpochRef.current) {
        setTurns((t) => [
          ...t,
          { who: personaTitle(personaId), text: extractSources(full).answer, sources: answerSources },
        ]);
      }
    } catch (err) {
      if (epoch !== turnEpochRef.current) return;
      if (abort.signal.aborted) {
        // stopped mid-answer: keep whatever was already said
        const partial = stripStreamingSourcesTail(full);
        if (partial) {
          setTurns((t) => [...t, { who: personaTitle(personaId), text: partial, sources: [] }]);
        }
      } else {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (epoch === turnEpochRef.current) {
        askingRef.current = false;
        abortRef.current = null;
        setStreamText("");
        setStatus("idle");
      }
    }
  }

  function submitDraft() {
    const v = draft.trim();
    if (!v || askingRef.current) return;
    setDraft("");
    void ask(v);
  }

  const persona = personas[personaId];
  const personaName = personaTitle(personaId);
  const stateLabel = streamText ? "Writing" : "Thinking";

  return (
    // h-full: the notch shell's viewport owns the height, not the raw viewport
    <main className="relative flex h-full min-h-[480px] flex-col overflow-hidden bg-white text-[#0A0A0A] font-[family-name:var(--font-grotesk)]">
      <div className={`flex shrink-0 items-center justify-between gap-3 px-5 py-4 text-[10px] uppercase tracking-[0.16em] sm:px-[30px] sm:py-[26px] ${MONO}`}>
        {/* no resting state on a text page: the indicator exists only mid-turn */}
        <div
          aria-hidden={status === "idle"}
          className="flex min-w-0 items-center gap-[9px] transition-opacity duration-300"
          style={{ opacity: status === "asking" ? 1 : 0 }}
        >
          <span
            className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full"
            style={{ background: "#1F3BE0" }}
          />
          <span className="truncate">{stateLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-[9px]">
          <span className="opacity-60">{personaName}</span>
          <span className="mx-[6px] h-[11px] w-px bg-[#E4E4E4]" />
          <span className="text-[#9A9A9A]">Text only</span>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-8">
        <div className="mx-auto flex w-full max-w-[680px] flex-col pb-8">
          {turns.length === 0 && !streamText && (
            <div className="flex flex-col items-center pt-[10vh] text-center">
              <div className={`text-[9px] uppercase tracking-[0.18em] text-[#9A9A9A] ${MONO}`}>
                {personaId} · text only
              </div>
              <h1 className="mt-4 text-[clamp(26px,4vw,40px)] font-light leading-tight tracking-[-0.02em]">
                {personaName}
              </h1>
              {persona && (
                <>
                  <p className="mt-4 max-w-[480px] text-[14px] font-light leading-[1.7] text-[#6E6E6E]">
                    Ask anything. {personaName.split(" ")[0]} answers in writing, grounded
                    in what they actually said.
                  </p>
                  <p className="mt-6 max-w-[440px] border-l border-[#E4E4E4] pl-3 text-left text-[12.5px] font-light italic leading-[1.6] text-[#9A9A9A]">
                    &ldquo;{persona.quotes[0]}&rdquo;
                  </p>
                </>
              )}
            </div>
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
                  className={`${isUser ? "max-w-[80%]" : "max-w-[88%]"} whitespace-pre-wrap text-[15px] font-light leading-[1.58]`}
                  style={{ color: isUser ? "#6E6E6E" : "#0A0A0A", textWrap: "pretty" }}
                >
                  {turn.text}
                </div>
                <SourceChips sources={turn.sources} alignEnd={isUser} />
              </div>
            );
          })}

          {status === "asking" && (
            <div className="flex flex-col items-start border-t border-[#F1F1F1] py-5 text-left first:border-t-0">
              <div className={`mb-[9px] text-[9px] uppercase tracking-[0.18em] text-[#9A9A9A] ${MONO}`}>
                {personaName}
              </div>
              <div
                className="max-w-[88%] whitespace-pre-wrap text-[15px] font-light leading-[1.58]"
                style={{ textWrap: "pretty" }}
              >
                {streamText}
                <span className="ml-[2px] inline-block h-[13px] w-[7px] animate-pulse bg-[#1F3BE0] align-baseline" />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex w-full shrink-0 flex-col items-center gap-[10px] px-5 pb-[max(clamp(16px,3vh,30px),env(safe-area-inset-bottom))] pt-2 sm:px-8">
        <div className="mx-auto flex w-full max-w-[680px] items-center gap-3">
          <input
            id="question"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitDraft();
            }}
            placeholder={`Ask ${personaName} anything`}
            className="min-w-0 flex-1 border-b border-[#EAEAEA] bg-transparent px-0.5 py-[11px] text-base font-light outline-none placeholder:text-neutral-400 sm:text-sm"
          />
          <button
            onClick={() => (status === "asking" ? stopAnswer() : submitDraft())}
            title={status === "asking" ? "stop the answer" : "send"}
            className="flex h-[40px] w-[40px] shrink-0 touch-manipulation items-center justify-center rounded-full border transition-all hover:scale-105"
            style={{ borderColor: status === "asking" ? "#1F3BE0" : "#E4E4E4" }}
          >
            {status === "asking" ? (
              <span className="h-[11px] w-[11px] rounded-[3px]" style={{ background: "#1F3BE0" }} />
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0A0A0A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5" />
                <path d="M6 11l6-6 6 6" />
              </svg>
            )}
          </button>
        </div>
        {notice && (
          <div className={`max-w-[420px] text-center text-[9px] uppercase leading-[1.7] tracking-[0.14em] text-[#9A9A9A] ${MONO}`}>
            {notice}
          </div>
        )}
      </div>
    </main>
  );
}
