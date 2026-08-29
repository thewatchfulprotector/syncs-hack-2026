import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return (async function* () {
    // A real stream is not needed to exercise retrieval routing.
  })();
}

describe("ask retrieval latency contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.embedTexts.mockResolvedValue([[0.1, 0.2]]);
    dependencies.queryChunks.mockResolvedValue({ matches: [], namespace: "" });
    dependencies.streamChat.mockImplementation(emptyTokenStream);
  });

  it("passes the request abort signal into question embedding", async () => {
    const controller = new AbortController();

    await askPersona(
      "steve-jobs",
      "What causes wildfire smoke?",
      [],
      controller.signal,
    );

    expect(dependencies.embedTexts).toHaveBeenCalledWith(
      ["What causes wildfire smoke?"],
      controller.signal,
    );
  });

  it("passes the request abort signal into Pinecone retrieval", async () => {
    const controller = new AbortController();

    await askPersona(
      "steve-jobs",
      "What causes wildfire smoke?",
      [],
      controller.signal,
    );

    expect(dependencies.queryChunks).toHaveBeenCalledWith(
      [0.1, 0.2],
      "steve-jobs",
      8,
      controller.signal,
    );
  });

  it.each(["Hello!", "Thank you.", "Goodbye!"])(
    "bypasses embedding and Pinecone for unambiguous small talk: %s",
    async (question) => {
      const result = await askPersona("steve-jobs", question);

      expect(dependencies.embedTexts).not.toHaveBeenCalled();
      expect(dependencies.queryChunks).not.toHaveBeenCalled();
      expect(result.chunks).toEqual([]);
      expect(result.timings).toEqual({ embedMs: 0, queryMs: 0 });
      expect(dependencies.streamChat).toHaveBeenCalledOnce();
    },
  );

  it.each(["Who was Aristotle?", "What is smoke?", "Why?"])(
    "never bypasses retrieval merely because a factual question is short: %s",
    async (question) => {
      await askPersona("steve-jobs", question);

      expect(dependencies.embedTexts).toHaveBeenCalledOnce();
      expect(dependencies.queryChunks).toHaveBeenCalledOnce();
    },
  );
});
