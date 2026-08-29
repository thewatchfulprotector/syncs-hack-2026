import { Pinecone, type Index } from "@pinecone-database/pinecone";

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
    const name = process.env.PINECONE_INDEX;
    if (!apiKey) throw new Error("missing env var PINECONE_API_KEY");
    if (!name) throw new Error("missing env var PINECONE_INDEX");
    index = new Pinecone({ apiKey }).index<ChunkMetadata>(name);
  }
  return index;
}

export async function upsertChunks(records: ChunkRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    await personaIndex().upsert({ records: records.slice(i, i + UPSERT_BATCH_SIZE) });
  }
}
