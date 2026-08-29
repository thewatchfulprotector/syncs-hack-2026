import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "./openrouter";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type PendingEmbedding = {
  provider: string;
  signal: AbortSignal | null | undefined;
  response: Deferred<Response>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function embeddingResponse(vector: number[]): Response {
  return Response.json({ data: [{ index: 0, embedding: vector }] });
}

function requestBody(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as {
    provider: { order: string[]; allow_fallbacks: boolean };
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("embedding tail-latency controls", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("uses one provider with provider fallbacks disabled when the primary is fast", async () => {
    fetchMock.mockResolvedValue(embeddingResponse([1, 2, 3]));

    await expect(embedTexts(["hello"])).resolves.toEqual([[1, 2, 3]]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestBody(init).provider).toEqual({
      order: ["azure"],
      allow_fallbacks: false,
    });
  });

  it("starts a retry request only after a delay and aborts the losing request", async () => {
    vi.useFakeTimers();
    const pending: PendingEmbedding[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = requestBody(init);
      const provider = body.provider.order[0];
      const response = deferred<Response>();
      const signal = init.signal;
      signal?.addEventListener(
        "abort",
        () => response.reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      pending.push({ provider, signal, response });
      return response.promise;
    });

    const resultPromise = embedTexts(["tail latency"]);
    await flushMicrotasks();
    const requestsStartedImmediately = pending.length;

    if (pending.length < 2) {
      await vi.advanceTimersToNextTimerAsync();
      await flushMicrotasks();
    }

    const [primary, hedge] = pending;
    expect(hedge, "the delayed retry should eventually start").toBeDefined();
    expect(primary, "the primary request should start first").toBeDefined();

    hedge.response.resolve(embeddingResponse([9, 8, 7]));
    await expect(resultPromise).resolves.toEqual([[9, 8, 7]]);
    await flushMicrotasks();

    const loserWasAborted = primary.signal?.aborted === true;
    if (!loserWasAborted) primary.response.resolve(embeddingResponse([1, 2, 3]));

    expect(requestsStartedImmediately).toBe(1);
    expect(loserWasAborted).toBe(true);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(requestBody(init).provider).toEqual({
        order: ["azure"],
        allow_fallbacks: false,
      });
    }
  });

  it("propagates caller cancellation into every active embedding request", async () => {
    const pending: PendingEmbedding[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const provider = requestBody(init).provider.order[0];
      const response = deferred<Response>();
      const signal = init.signal;
      signal?.addEventListener(
        "abort",
        () => response.reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      pending.push({ provider, signal, response });
      return response.promise;
    });

    const controller = new AbortController();
    const embedWithSignal = embedTexts as unknown as (
      texts: string[],
      signal?: AbortSignal,
    ) => Promise<number[][]>;
    const resultPromise = embedWithSignal(["cancel me"], controller.signal).catch(() => undefined);
    await flushMicrotasks();

    controller.abort();
    await flushMicrotasks();
    const callerCancellationReachedFetch =
      pending.length > 0 && pending.every((request) => request.signal?.aborted === true);

    for (const request of pending) {
      request.response.resolve(embeddingResponse([4, 5, 6]));
    }
    await resultPromise;

    expect(callerCancellationReachedFetch).toBe(true);
  });
});
