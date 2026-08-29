import type { ChunkMetadata } from "./pineconeClient";

export type RetrievedChunk = {
  id: string;
  score: number;
  metadata: ChunkMetadata;
};

type RawMatch = {
  id?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Turn a Pinecone query response into typed chunks, best first, dropping
 * anything without usable text.
 */
export function parseMatches(response: { matches?: RawMatch[] }): RetrievedChunk[] {
  return (response.matches ?? [])
    .filter(
      (m) =>
        typeof m.id === "string" &&
        typeof m.metadata?.text === "string" &&
        m.metadata.text.length > 0,
    )
    .map((m) => ({
      id: m.id!,
      score: m.score ?? 0,
      metadata: m.metadata as unknown as ChunkMetadata,
    }))
    .sort((a, b) => b.score - a.score);
}
