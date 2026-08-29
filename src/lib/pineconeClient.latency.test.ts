import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pineconeMocks = vi.hoisted(() => {
  const query = vi.fn();
  const upsert = vi.fn();
  const index = vi.fn(() => ({ query, upsert }));
  const Pinecone = vi.fn(function PineconeMock() {
    return { index };
  });

  return { Pinecone, index, query, upsert };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: pineconeMocks.Pinecone,
}));

const undiciMocks = vi.hoisted(() => {
  const agentInstances: Array<{ kind: string; options: unknown }> = [];
  const Agent = vi.fn(function AgentMock(this: unknown, options: unknown) {
    const instance = { kind: "undici-agent", options };
    agentInstances.push(instance);
    return instance;
  });
  const fetch = vi.fn(async () => ({ kind: "undici-response" }));
  return { Agent, fetch, agentInstances };
});

vi.mock("undici", () => ({
  Agent: undiciMocks.Agent,
  fetch: undiciMocks.fetch,
}));

describe("Pinecone latency configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("PINECONE_API_KEY", "test-api-key");
    vi.stubEnv("PINECONE_INDEX", "alexandria-test");
    vi.stubEnv("PINECONE_HOST", "alexandria-test.svc.pinecone.io");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets the configured data-plane host without resolving the index by name", async () => {
    const { personaIndex } = await import("./pineconeClient");

    personaIndex();

    expect(pineconeMocks.Pinecone).toHaveBeenCalledWith({
      apiKey: "test-api-key",
      fetchApi: expect.any(Function),
    });
    expect(pineconeMocks.index).toHaveBeenCalledOnce();
    expect(pineconeMocks.index).toHaveBeenCalledWith({
      host: "alexandria-test.svc.pinecone.io",
    });
  });

  it("fails fast when PINECONE_HOST is absent from the serving environment", async () => {
    vi.stubEnv("PINECONE_HOST", "");
    const { personaIndex } = await import("./pineconeClient");

    expect(() => personaIndex()).toThrow("missing env var PINECONE_HOST");
    expect(pineconeMocks.index).not.toHaveBeenCalled();
  });

  it("routes SDK requests through one long keep-alive agent so consecutive turns reuse the connection", async () => {
    const { personaIndex } = await import("./pineconeClient");

    personaIndex();

    expect(undiciMocks.Agent).toHaveBeenCalledOnce();
    const agentOptions = undiciMocks.Agent.mock.calls[0][0] as { keepAliveTimeout: number };
    expect(agentOptions.keepAliveTimeout).toBeGreaterThanOrEqual(30_000);

    const [config] = pineconeMocks.Pinecone.mock.calls[0] as unknown as [
      { fetchApi: (input: string, init?: object) => Promise<unknown> },
    ];
    const { fetchApi } = config;
    const response = await fetchApi("https://host.example/query", { method: "POST" });
    expect(undiciMocks.fetch).toHaveBeenCalledWith("https://host.example/query", {
      method: "POST",
      dispatcher: undiciMocks.agentInstances.at(-1),
    });
    expect(response).toEqual({ kind: "undici-response" });
  });

  it("rejects promptly with the caller's reason when retrieval is aborted", async () => {
    const sdkQuery = new Promise<never>(() => {
      // The public Pinecone SDK does not expose query cancellation, so the
      // data-plane request may remain in flight after our caller stops waiting.
    });
    pineconeMocks.query.mockReturnValue(sdkQuery);
    const { queryChunks } = await import("./pineconeClient");
    const controller = new AbortController();
    const reason = new DOMException("manual interruption", "AbortError");

    const retrieval = queryChunks(
      [0.1, 0.2],
      "wildfire-expert",
      4,
      controller.signal,
    );
    controller.abort(reason);

    const outcome = await Promise.race([
      retrieval.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "timed-out" }>((resolve) => {
        setTimeout(() => resolve({ status: "timed-out" }), 25);
      }),
    ]);

    expect(outcome).toEqual({ status: "rejected", error: reason });
    expect(pineconeMocks.query).toHaveBeenCalledOnce();
  });

  it("returns an ordinary query response unchanged when it is not aborted", async () => {
    const response = { matches: [], namespace: "" };
    pineconeMocks.query.mockResolvedValue(response);
    const { queryChunks } = await import("./pineconeClient");
    const signal = new AbortController().signal;

    await expect(
      queryChunks([0.1, 0.2], "wildfire-expert", 4, signal),
    ).resolves.toBe(response);
    expect(pineconeMocks.query).toHaveBeenCalledWith({
      vector: [0.1, 0.2],
      topK: 4,
      filter: { persona_id: "wildfire-expert" },
      includeMetadata: true,
    });
  });
});
