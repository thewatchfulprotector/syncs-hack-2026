import { Pinecone, type Index } from "@pinecone-database/pinecone";
import { Agent, fetch as undiciFetch } from "undici";

export type MediaType = "video" | "audio" | "document";

/** Metadata carried on every vector so citations can link back to the exact source moment. */
export type ChunkMetadata = {
  persona_id: string;
  source_file: string;
  media_type: MediaType;
  text: string;
  speaker?: string;
  start_ms?: number;
  end_ms?: number;
};

export type ChunkRecord = {
  id: string;
  values: number[];
  metadata: ChunkMetadata;
};

const UPSERT_BATCH_SIZE = 100;

let index: Index<ChunkMetadata> | undefined;

export function personaIndex(): Index<ChunkMetadata> {
  if (!index) {
    const apiKey = process.env.PINECONE_API_KEY;
    const host = process.env.PINECONE_HOST;
    if (!apiKey) throw new Error("missing env var PINECONE_API_KEY");
    if (!host) throw new Error("missing env var PINECONE_HOST");
    // Supplying the data-plane host avoids a control-plane describeIndex()
    // lookup on a cold ask. Keep PINECONE_INDEX for administrative scripts.
    //
    // The SDK otherwise uses global fetch, whose agent drops idle sockets
    // after 4s — shorter than the gap between conversational turns — so every
    // query paid a fresh cross-region TLS handshake and slow-started the
    // ~80KB vector upload. One long keep-alive agent lets consecutive turns
    // reuse the connection.
    const dataPlaneAgent = new Agent({ keepAliveTimeout: 60_000 });
    const keepAliveFetch = ((
      input: Parameters<typeof undiciFetch>[0],
      init?: Parameters<typeof undiciFetch>[1],
    ) => undiciFetch(input, { ...init, dispatcher: dataPlaneAgent })) as unknown as typeof fetch;
    index = new Pinecone({ apiKey, fetchApi: keepAliveFetch }).index<ChunkMetadata>({ host });
  }
  return index;
}

/** Top-k similarity search scoped to one persona. */
export async function queryChunks(
  vector: number[],
  personaId: string,
  topK = 8,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const query = personaIndex().query({
    vector,
    topK,
    filter: { persona_id: personaId },
    includeMetadata: true,
  });
  if (!signal) return query;

  // Pinecone's public SDK query does not currently expose transport
  // cancellation. Stop awaiting it immediately so an interrupted turn cannot
  // hold the route open; attach handlers so its eventual settlement is safe.
  return new Promise<Awaited<typeof query>>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    query.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function upsertChunks(records: ChunkRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    await personaIndex().upsert({ records: records.slice(i, i + UPSERT_BATCH_SIZE) });
  }
}
