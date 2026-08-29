import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicSession } from "./micStream";

const NOW_MS = 1_788_000_000_000;
const REDEMPTION_SAFETY_MS = 60_000;

type TokenLease = {
  token: string;
  issuedAt: number;
  expiresAt: number;
  correlationId: string;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
}

const sessions: MicSession[] = [];

function lease(token: string, expiresAt = NOW_MS + 300_000): TokenLease {
  return {
    token,
    issuedAt: NOW_MS,
    expiresAt,
    correlationId: "token-prefetch-test",
  };
}

function jsonResponse(body: TokenLease): Response {
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

function pendingMedia(): Promise<MediaStream> {
  return new Promise(() => {});
}

function installTransportHarness(fetchMock: ReturnType<typeof vi.fn>): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(() => pendingMedia()) },
  });
  vi.stubGlobal(
    "AudioContext",
    function AudioContextFactory() {
      return {
        state: "running",
        sampleRate: 16_000,
        audioWorklet: { addModule: vi.fn(async () => {}) },
        close: vi.fn(async () => {}),
      } as unknown as AudioContext;
    },
  );
}

function start(
  startMicStream: typeof import("./micStream").startMicStream,
  onError = vi.fn(),
): MicSession {
  const session = startMicStream({
    onPartial: vi.fn(),
    onTurnEnd: vi.fn(),
    onError,
    correlationId: "browser-turn-1",
  });
  sessions.push(session);
  return session;
}

function socketToken(socket: FakeWebSocket): string | null {
  return new URL(socket.url).searchParams.get("token");
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("AssemblyAI token prefetch lease", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("allows one valid prefetched token to open at most one STT session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(lease("prefetched-token")))
      .mockResolvedValueOnce(jsonResponse(lease("fresh-token")));
    installTransportHarness(fetchMock);
    const { prefetchSttToken, startMicStream } = await import("./micStream");

    prefetchSttToken();
    await flushMicrotasks();
    start(startMicStream);
    start(startMicStream);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances.map(socketToken)).toEqual([
      "prefetched-token",
      "fresh-token",
    ]);
  });

  it("rejects a prefetched lease inside the redemption safety window", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(lease("nearly-expired-token", NOW_MS + REDEMPTION_SAFETY_MS - 1)),
      )
      .mockResolvedValueOnce(jsonResponse(lease("replacement-token")));
    installTransportHarness(fetchMock);
    const { prefetchSttToken, startMicStream } = await import("./micStream");

    prefetchSttToken();
    await flushMicrotasks();
    start(startMicStream);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socketToken(FakeWebSocket.instances[0])).toBe("replacement-token");
  });

  it("aborts a token fetch after the explicit five-second deadline", async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error("token request did not include an abort signal"));
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    installTransportHarness(fetchMock);
    const { startMicStream } = await import("./micStream");
    const onError = vi.fn();

    start(startMicStream, onError);
    await flushMicrotasks();
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);

    const timeout = new DOMException("token fetch timed out", "TimeoutError");
    deadline.abort(timeout);
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(timeout);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
