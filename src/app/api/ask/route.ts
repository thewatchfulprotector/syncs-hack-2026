import { askPersona } from "@/lib/ask";
import { extractSources } from "@/lib/citations";
import { DEFAULT_VOICE_ID, ttsSentence } from "@/lib/elevenlabs";
import { CHAT_MODEL } from "@/lib/openrouter";
import { getPersona } from "@/lib/personas";
import { capConversationHistory } from "@/lib/prompt";
import { SentenceSplitter } from "@/lib/sentences";

export const maxDuration = 60;

/**
 * POST { personaId, question } -> NDJSON stream:
 *   {type:"citations", chunks}   once, straight after retrieval
 *   {type:"token", text}         LLM tokens as they arrive
 *   {type:"audio_chunk", ...}    progressive base64 transport chunks
 *   {type:"generation_complete"} no more model tokens will arrive
 *   {type:"audio_complete"}      no more TTS packets will arrive
 *   {type:"sources", sources}    excerpt numbers the model cited
 *   {type:"done", timings}
 *   {type:"error", message}
 */
export async function POST(req: Request): Promise<Response> {
  const t0 = performance.now();
  const milestones: Array<{
    name: string;
    atMs: number;
    detail?: Record<string, unknown>;
  }> = [];
  const trace = (name: string, detail?: Record<string, unknown>) => {
    milestones.push({ name, atMs: performance.now() - t0, ...(detail ? { detail } : {}) });
  };
  trace("route_entry");
  const requestedCorrelationId = req.headers.get("x-correlation-id")?.trim();
  const correlationId =
    requestedCorrelationId && /^[A-Za-z0-9._:-]{8,128}$/.test(requestedCorrelationId)
      ? requestedCorrelationId
      : crypto.randomUUID();
  const { personaId, question, history } = await req.json().catch(() => ({}));
  if (typeof personaId !== "string" || typeof question !== "string" || !question.trim()) {
    return Response.json({ error: "personaId and question are required" }, { status: 400 });
  }
  const priorTurns = capConversationHistory(history);
  let persona;
  try {
    persona = getPersona(personaId);
  } catch {
    return Response.json({ error: `unknown persona: ${personaId}` }, { status: 404 });
  }

  const encoder = new TextEncoder();
  // aborted when the client disconnects, so upstream generation and TTS stop
  const upstream = new AbortController();
  const abortUpstream = () => upstream.abort(req.signal.reason);
  if (req.signal.aborted) abortUpstream();
  else req.signal.addEventListener("abort", abortUpstream, { once: true });
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (message: object) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(JSON.stringify({ ...message, correlationId }) + "\n"),
          );
        } catch {
          closed = true;
          upstream.abort();
        }
      };

      try {
        const { chunks, stream: tokens, timings } = await askPersona(
          personaId,
          question,
          priorTurns,
          upstream.signal,
          8,
          trace,
        );
        send({
          type: "citations",
          chunks: chunks.map((c) => ({ id: c.id, score: c.score, ...c.metadata })),
        });

        // TTS runs as a promise chain so token streaming never blocks on audio.
        // Each link catches its own failure: one bad sentence skips its audio
        // but never silences the rest or eats the sources/done messages.
        const voiceId = persona.voiceId ?? DEFAULT_VOICE_ID;
        const requestIds: string[] = [];
        let sentenceSeq = 0;
        let firstAudioPacketMs: number | undefined;
        let firstSentenceRecorded = false;
        let ttsChain = Promise.resolve();
        const speak = (fragment: string) => {
          const sentence = extractSources(fragment).answer.trim();
          if (!sentence) return;
          if (/^\s*SOURCES:/.test(sentence)) return;
          const currentSentenceSeq = sentenceSeq++;
          if (!firstSentenceRecorded) {
            firstSentenceRecorded = true;
            trace("llm_first_sentence", { characters: sentence.length });
          }
          ttsChain = ttsChain.then(async () => {
            if (closed) return;
            try {
              trace("tts_request_start", {
                sentenceSeq: currentSentenceSeq,
                voiceId,
              });
              const {
                stream,
                requestId,
                servingRegion,
                model,
                format = "pcm_s16le",
                sampleRate = 24_000,
                channels = 1,
              } = await ttsSentence(
                sentence,
                voiceId,
                requestIds,
                upstream.signal,
              );
              trace("tts_response_headers", {
                sentenceSeq: currentSentenceSeq,
                requestId,
                servingRegion,
                model,
                voiceId,
              });
              if (requestId) requestIds.push(requestId);
              const reader = stream.getReader();
              let chunkSeq = 0;
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (closed || value.byteLength === 0) continue;
                  firstAudioPacketMs ??= Math.round(performance.now() - t0);
                  if (chunkSeq === 0) {
                    trace("tts_first_byte", {
                      sentenceSeq: currentSentenceSeq,
                      bytes: value.byteLength,
                    });
                  }
                  send({
                    type: "audio_chunk",
                    sentenceSeq: currentSentenceSeq,
                    chunkSeq: chunkSeq++,
                    text: sentence,
                    format,
                    sampleRate,
                    channels,
                    audioBase64: Buffer.from(value).toString("base64"),
                  });
                }
              } finally {
                reader.releaseLock();
              }
              trace("tts_complete", {
                sentenceSeq: currentSentenceSeq,
                chunks: chunkSeq,
              });
              send({
                type: "audio_sentence_complete",
                sentenceSeq: currentSentenceSeq,
                text: sentence,
              });
            } catch (err) {
              trace(upstream.signal.aborted ? "tts_cancelled" : "tts_failed", {
                sentenceSeq: currentSentenceSeq,
                message: err instanceof Error ? err.message : String(err),
              });
              console.error(
                JSON.stringify({
                  correlationId,
                  event: "tts_sentence_failed",
                  sentenceSeq: currentSentenceSeq,
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          });
        };

        const splitter = new SentenceSplitter();
        let full = "";
        let firstTokenRecorded = false;
        trace("llm_request_start", { model: CHAT_MODEL });
        for await (const token of tokens) {
          if (closed) break;
          if (!firstTokenRecorded) {
            firstTokenRecorded = true;
            trace("llm_first_token", { model: CHAT_MODEL });
          }
          full += token;
          send({ type: "token", text: token });
          for (const sentence of splitter.push(token)) speak(sentence);
        }
        const rest = splitter.flush();
        if (rest) speak(rest);
        trace("generation_complete", { model: CHAT_MODEL });
        send({ type: "generation_complete" });

        const extracted = extractSources(full);
        send({
          type: "sources",
          sources: extracted.sources,
          hasSourcesLine: extracted.hasSourcesLine,
        });
        await ttsChain;
        trace("audio_complete");
        send({ type: "audio_complete" });
        const completedTrace = { correlationId, milestones };
        send({
          type: "done",
          timings: {
            ...timings,
            firstAudioPacketMs,
            totalMs: Math.round(performance.now() - t0),
          },
          trace: completedTrace,
        });
        if (process.env.NODE_ENV !== "test") {
          console.info(
            JSON.stringify({ correlationId, event: "turn_latency_trace", milestones }),
          );
        }
      } catch (err) {
        const wasCancelled = upstream.signal.aborted || req.signal.aborted;
        upstream.abort(err);
        trace(wasCancelled ? "turn_cancelled" : "turn_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          trace: { correlationId, milestones },
        });
      } finally {
        req.signal.removeEventListener("abort", abortUpstream);
        closed = true;
        try {
          controller.close();
        } catch {
          // stream already cancelled by the client
        }
      }
    },
    cancel() {
      closed = true;
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Correlation-Id": correlationId,
    },
  });
}
