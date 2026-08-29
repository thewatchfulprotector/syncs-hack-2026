import { getPersona } from "./personas";
import { buildPersonaPrompt, type ChatMessage } from "./prompt";
import { embedTexts, streamChat } from "./openrouter";
import { queryChunks } from "./pineconeClient";
import { parseMatches, type RetrievedChunk } from "./retrieval";

export type AskResult = {
  chunks: RetrievedChunk[];
  /** Token stream of the answer (ends with the SOURCES metadata line). */
  stream: AsyncGenerator<string>;
  timings: { embedMs: number; queryMs: number };
};

export type AskTraceSink = (name: string, detail?: Record<string, unknown>) => void;

const SMALL_TALK_PATTERNS = [
  /^(?:hi|hello|hey|hiya|g[’']?day)(?:\s+there)?[!.]*$/i,
  /^(?:thanks|thank\s+you|cheers)(?:\s+(?:so|very)\s+much)?[!.]*$/i,
  /^(?:bye|goodbye|see\s+you|talk\s+to\s+you\s+later)[!.]*$/i,
];

/** Only skip retrieval for closed-form social turns with no factual intent. */
export function isUnambiguousSmallTalk(question: string): boolean {
  const normalized = question.trim().replace(/\s+/g, " ");
  return SMALL_TALK_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** The whole ask loop: embed question -> retrieve persona chunks -> stream answer. */
export async function askPersona(
  personaId: string,
  question: string,
  history: ChatMessage[] = [],
  signal?: AbortSignal,
  topK = 8,
  onTrace?: AskTraceSink,
): Promise<AskResult> {
  const persona = getPersona(personaId);

  if (isUnambiguousSmallTalk(question)) {
    const messages = buildPersonaPrompt(persona, [], question, history);
    return {
      chunks: [],
      stream: streamChat(messages, signal),
      timings: { embedMs: 0, queryMs: 0 },
    };
  }

  let t = performance.now();
  let embeddingProvider: string | undefined;
  onTrace?.("embedding_start");
  let vector: number[];
  try {
    [vector] = onTrace
      ? await embedTexts([question], signal, (provider) => {
          embeddingProvider = provider;
        })
      : await embedTexts([question], signal);
  } catch (error) {
    onTrace?.(signal?.aborted ? "embedding_cancelled" : "embedding_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const embedMs = Math.round(performance.now() - t);
  onTrace?.("embedding_complete", { provider: embeddingProvider, durationMs: embedMs });

  t = performance.now();
  onTrace?.("pinecone_start", { hostResolution: false, topK });
  let response;
  try {
    response = await queryChunks(vector, personaId, topK, signal);
  } catch (error) {
    onTrace?.("pinecone_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const queryMs = Math.round(performance.now() - t);
  onTrace?.("pinecone_complete", {
    durationMs: queryMs,
    matchCount: response.matches?.length ?? 0,
    hostResolution: false,
  });

  const chunks = parseMatches(response);
  const messages = buildPersonaPrompt(persona, chunks, question, history);
  return { chunks, stream: streamChat(messages, signal), timings: { embedMs, queryMs } };
}
