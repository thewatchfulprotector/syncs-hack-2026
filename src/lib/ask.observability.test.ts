import { beforeEach, describe, expect, it, vi } from "vitest";

type ProviderSelected = (provider: string) => void;
type AskTraceSink = (name: string, detail?: Record<string, unknown>) => void;

const dependencies = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  queryChunks: vi.fn(),
  streamChat: vi.fn(),
}));

vi.mock("./openrouter", () => ({
  embedTexts: dependencies.embedTexts,
  streamChat: dependencies.streamChat,
}));

vi.mock("./pineconeClient", () => ({
  queryChunks: dependencies.queryChunks,
}));

import { askPersona } from "./ask";

function emptyTokenStream(): AsyncGenerator<string> {
  return (async function* () {})();
}

describe("ask retrieval observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.embedTexts.mockImplementation(
      async (_texts: string[], _signal?: AbortSignal, onProviderSelected?: ProviderSelected) => {
        onProviderSelected?.("deepinfra");
        return [[0.1, 0.2]];
      },
    );
    dependencies.queryChunks.mockResolvedValue({
      matches: [{ id: "chunk-1", score: 0.9, metadata: { text: "One" } }],
      namespace: "",
    });
    dependencies.streamChat.mockImplementation(emptyTokenStream);
  });

  it("reports embedding and Pinecone boundaries and carries the actual embedding winner", async () => {
    const signal = new AbortController().signal;
    const observed: Array<{ name: string; detail?: Record<string, unknown> }> = [];
    const onTrace: AskTraceSink = (name, detail) => observed.push({ name, detail });

    await askPersona(
      "wildfire-expert",
      "What causes wildfire smoke?",
      [],
      signal,
      8,
      onTrace,
    );

    expect(dependencies.embedTexts).toHaveBeenCalledWith(
      ["What causes wildfire smoke?"],
      signal,
      expect.any(Function),
    );
    expect(observed.map((event) => event.name)).toEqual([
      "embedding_start",
      "embedding_complete",
      "pinecone_start",
      "pinecone_complete",
    ]);
    expect(observed.find((event) => event.name === "embedding_complete")?.detail).toMatchObject({
      provider: "deepinfra",
    });
  });
});
