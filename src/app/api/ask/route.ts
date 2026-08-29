import { askPersona } from "@/lib/ask";
import { extractSources } from "@/lib/citations";
import { DEFAULT_VOICE_ID, ttsSentence } from "@/lib/elevenlabs";
import { getPersona } from "@/lib/personas";
import { SentenceSplitter } from "@/lib/sentences";

export const maxDuration = 60;

/**
 * POST { personaId, question } -> NDJSON stream:
 *   {type:"citations", chunks}   once, straight after retrieval
 *   {type:"token", text}         LLM tokens as they arrive
 *   {type:"audio", seq, mp3}     one base64 mp3 per spoken sentence, in order
 *   {type:"sources", sources}    excerpt numbers the model cited
 *   {type:"done", timings}
 *   {type:"error", message}
 */
export async function POST(req: Request): Promise<Response> {
  const { personaId, question, history } = await req.json().catch(() => ({}));
  if (typeof personaId !== "string" || typeof question !== "string" || !question.trim()) {
    return Response.json({ error: "personaId and question are required" }, { status: 400 });
  }
  const priorTurns = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string",
        )
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    : [];
  let persona;
  try {
    persona = getPersona(personaId);
  } catch {
    return Response.json({ error: `unknown persona: ${personaId}` }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const t0 = performance.now();

  // aborted when the client disconnects, so upstream generation and TTS stop
  const upstream = new AbortController();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (message: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
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
        let seq = 0;
        let firstAudioMs: number | undefined;
        let ttsChain = Promise.resolve();
        const speak = (sentence: string) => {
          if (/^\s*SOURCES:/.test(sentence)) return;
          ttsChain = ttsChain.then(async () => {
            if (closed) return;
            try {
              const { mp3, requestId } = await ttsSentence(
                sentence,
                voiceId,
                requestIds,
                upstream.signal,
              );
              if (requestId) requestIds.push(requestId);
              firstAudioMs ??= Math.round(performance.now() - t0);
              send({ type: "audio", seq: seq++, mp3: mp3.toString("base64") });
            } catch (err) {
              console.error("tts failed for sentence, skipping its audio:", err);
            }
          });
        };

        const splitter = new SentenceSplitter();
        let full = "";
        for await (const token of tokens) {
          if (closed) break;
          full += token;
          send({ type: "token", text: token });
          for (const sentence of splitter.push(token)) speak(sentence);
        }
        const rest = splitter.flush();
        if (rest) speak(rest);
        await ttsChain;

        const extracted = extractSources(full);
        send({
          type: "sources",
          sources: extracted.sources,
          hasSourcesLine: extracted.hasSourcesLine,
        });
        send({
          type: "done",
          timings: { ...timings, firstAudioMs, totalMs: Math.round(performance.now() - t0) },
        });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
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
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
