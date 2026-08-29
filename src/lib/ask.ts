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

/** The whole ask loop: embed question -> retrieve persona chunks -> stream answer. */
export async function askPersona(
  personaId: string,
  question: string,
  history: ChatMessage[] = [],
  signal?: AbortSignal,
  topK = 8,
): Promise<AskResult> {
  const persona = getPersona(personaId);

  let t = performance.now();
  const [vector] = await embedTexts([question]);
  const embedMs = Math.round(performance.now() - t);

  t = performance.now();
  const response = await queryChunks(vector, personaId, topK);
  const queryMs = Math.round(performance.now() - t);

  const chunks = parseMatches(response);
  const messages = buildPersonaPrompt(persona, chunks, question, history);
  return { chunks, stream: streamChat(messages, signal), timings: { embedMs, queryMs } };
}
