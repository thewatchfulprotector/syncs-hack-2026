import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  askPersona: vi.fn(),
  getPersona: vi.fn(),
  ttsSentence: vi.fn(),
}));

vi.mock("@/lib/ask", () => ({ askPersona: mocks.askPersona }));
vi.mock("@/lib/elevenlabs", () => ({
  DEFAULT_VOICE_ID: "default-voice",
  ttsSentence: mocks.ttsSentence,
}));
vi.mock("@/lib/personas", () => ({ getPersona: mocks.getPersona }));

import { POST } from "./route";

const CORRELATION_ID = "0f41efca-e731-4e89-9af2-0dbce704fc79";

type ProtocolEvent = Record<string, unknown> & { type: string };

async function* tokens(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

function byteStream(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

function askRequest(
  correlationId: string | null = CORRELATION_ID,
  body: Record<string, unknown> = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (correlationId) headers.set("x-correlation-id", correlationId);
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers,
    body: JSON.stringify({
      personaId: "test-persona",
      question: "Why?",
      history: [],
      ...body,
    }),
  });
}

async function responseEvents(response: Response): Promise<ProtocolEvent[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ProtocolEvent);
}

class EventReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffered = "";

  constructor(response: Response) {
    if (!response.body) throw new Error("expected a streaming response body");
    this.reader = response.body.getReader();
  }

  async next(): Promise<ProtocolEvent | null> {
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (line.trim()) return JSON.parse(line) as ProtocolEvent;
        continue;
      }

      const { done, value } = await this.reader.read();
      if (done) {
        const tail = this.buffered.trim();
        this.buffered = "";
        return tail ? (JSON.parse(tail) as ProtocolEvent) : null;
      }
      this.buffered += this.decoder.decode(value, { stream: true });
    }
  }

  async rest(): Promise<ProtocolEvent[]> {
    const events: ProtocolEvent[] = [];
    for (;;) {
      const event = await this.next();
      if (!event) return events;
      events.push(event);
    }
  }
}

function gatedByteStream(first: number[], second: number[]): {
  stream: ReadableStream<Uint8Array>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deliveredTail = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from(first));
    },
    async pull(controller) {
      if (deliveredTail) return;
      deliveredTail = true;
      await gate;
      controller.enqueue(Uint8Array.from(second));
      controller.close();
    },
  });
  return { stream, release };
}

async function beforeDeadline<T>(promise: Promise<T>, ms = 250): Promise<{
  timedOut: boolean;
  value?: T;
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const settled = promise.then((value) => ({ timedOut: false as const, value }));
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

describe("POST /api/ask latency protocol", () => {
  beforeEach(() => {
    mocks.getPersona.mockReset().mockReturnValue({
      id: "test-persona",
      name: "Test Persona",
      description: "a test persona",
      quotes: [],
      voiceId: "test-voice",
    });
    mocks.askPersona.mockReset().mockResolvedValue({
      chunks: [],
      stream: tokens("One sentence. ", "SOURCES: 1"),
      timings: { embedMs: 12, queryMs: 7 },
    });
    mocks.ttsSentence.mockReset().mockImplementation(async () => ({
      stream: byteStream([1, 2], [3]),
      requestId: "tts-request-1",
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("echoes the browser correlation ID and attaches it to every streamed event", async () => {
    const response = await POST(askRequest());
    const events = await responseEvents(response);

    expect(response.headers.get("x-correlation-id")).toBe(CORRELATION_ID);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.correlationId === CORRELATION_ID)).toBe(true);
  });

  it("generates one correlation ID when a caller omits it", async () => {
    const response = await POST(askRequest(null));
    const events = await responseEvents(response);
    const generated = response.headers.get("x-correlation-id");

    expect(generated).toEqual(expect.any(String));
    expect(generated?.length).toBeGreaterThanOrEqual(16);
    expect(events.every((event) => event.correlationId === generated)).toBe(true);
  });

  it("separates generation, audio finalization, and request completion in protocol order", async () => {
    mocks.askPersona.mockResolvedValueOnce({
      chunks: [],
      stream: tokens("First sentence. ", "Second sentence. ", "SOURCES: 1"),
      timings: { embedMs: 12, queryMs: 7 },
    });
    const events = await responseEvents(await POST(askRequest()));
    const types = events.map((event) => event.type);
    const lastToken = types.lastIndexOf("token");
    const generationComplete = types.indexOf("generation_complete");
    const firstAudio = types.indexOf("audio_chunk");
    const lastSentenceComplete = types.lastIndexOf("audio_sentence_complete");
    const audioComplete = types.indexOf("audio_complete");
    const done = types.indexOf("done");

    // TTS is intentionally allowed to overlap generation: an audio chunk may
    // arrive between the final token and this marker. Never buffer early audio
    // merely to make protocol event types contiguous.
    expect(generationComplete).toBeGreaterThan(lastToken);
    expect(firstAudio).toBeGreaterThan(-1);
    expect(lastSentenceComplete).toBeGreaterThan(firstAudio);
    expect(lastSentenceComplete).toBeGreaterThan(generationComplete);
    expect(audioComplete).toBeGreaterThan(lastSentenceComplete);
    expect(done).toBe(audioComplete + 1);
    expect(
      events
        .filter((event) => event.type === "audio_sentence_complete")
        .map((event) => event.sentenceSeq),
    ).toEqual([0, 1]);
  });

  it("uses a transport-observable first-packet timing instead of firstAudioMs", async () => {
    const events = await responseEvents(await POST(askRequest()));
    const done = events.find((event) => event.type === "done");
    const timings = done?.timings as Record<string, unknown> | undefined;

    expect(timings).toBeDefined();
    expect(timings).not.toHaveProperty("firstAudioMs");
    expect(timings?.firstAudioPacketMs).toBeTypeOf("number");
  });

  it("forwards the first provider bytes before the provider stream completes", async () => {
    const provider = gatedByteStream([1, 2, 3], [4, 5]);
    mocks.ttsSentence.mockResolvedValueOnce({
      stream: provider.stream,
      requestId: "tts-request-streaming",
    });

    const reader = new EventReader(await POST(askRequest()));
    const seen: ProtocolEvent[] = [];
    const firstAudioPromise = (async () => {
      for (;;) {
        const event = await reader.next();
        if (!event) return null;
        seen.push(event);
        if (event.type === "audio_chunk") return event;
      }
    })();

    const early = await beforeDeadline(firstAudioPromise);
    provider.release();
    const firstAudio = early.timedOut ? await firstAudioPromise : early.value;
    const events = [...seen, ...(await reader.rest())];

    expect(early.timedOut).toBe(false);
    expect(firstAudio).toMatchObject({
      type: "audio_chunk",
      sentenceSeq: 0,
      chunkSeq: 0,
      text: "One sentence.",
      audioBase64: "AQID",
      correlationId: CORRELATION_ID,
    });

    const chunks = events.filter((event) => event.type === "audio_chunk");
    expect(chunks).toEqual([
      expect.objectContaining({ sentenceSeq: 0, chunkSeq: 0, audioBase64: "AQID" }),
      expect.objectContaining({ sentenceSeq: 0, chunkSeq: 1, audioBase64: "BAU=" }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "audio_sentence_complete",
        sentenceSeq: 0,
        text: "One sentence.",
      }),
    );
  });

  it("never sends a trailing SOURCES line to TTS when it shares the flushed fragment", async () => {
    mocks.askPersona.mockResolvedValueOnce({
      chunks: [],
      stream: tokens("A final answer without terminal punctuation\nSOURCES: 2, 3"),
      timings: { embedMs: 12, queryMs: 7 },
    });

    const events = await responseEvents(await POST(askRequest()));

    expect(mocks.ttsSentence).toHaveBeenCalledTimes(1);
    expect(mocks.ttsSentence.mock.calls[0]?.[0]).toBe(
      "A final answer without terminal punctuation",
    );
    expect(
      mocks.ttsSentence.mock.calls.some(([spoken]) => String(spoken).includes("SOURCES:")),
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sources",
        sources: [2, 3],
        hasSourcesLine: true,
      }),
    );
  });

  it("never sends same-line trailing SOURCES metadata to TTS", async () => {
    mocks.askPersona.mockResolvedValueOnce({
      chunks: [],
      stream: tokens("A same-line answer without punctuation SOURCES: 2"),
      timings: { embedMs: 12, queryMs: 7 },
    });

    const events = await responseEvents(await POST(askRequest()));

    expect(mocks.ttsSentence).toHaveBeenCalledTimes(1);
    expect(mocks.ttsSentence.mock.calls[0]?.[0]).toBe(
      "A same-line answer without punctuation",
    );
    expect(
      mocks.ttsSentence.mock.calls.some(([spoken]) => String(spoken).includes("SOURCES:")),
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sources",
        sources: [2],
        hasSourcesLine: true,
      }),
    );
  });

  it("skips TTS entirely when the request opts out of voice", async () => {
    mocks.askPersona.mockResolvedValueOnce({
      chunks: [],
      stream: tokens("First sentence. ", "Second sentence. ", "SOURCES: 1"),
      timings: { embedMs: 12, queryMs: 7 },
    });

    const events = await responseEvents(await POST(askRequest(CORRELATION_ID, { voice: false })));
    const types = events.map((event) => event.type);

    expect(mocks.ttsSentence).not.toHaveBeenCalled();
    expect(types).not.toContain("audio_chunk");
    expect(types).not.toContain("audio_sentence_complete");
    // text clients still get the full protocol shape, in order
    expect(types.indexOf("generation_complete")).toBeGreaterThan(types.lastIndexOf("token"));
    expect(types.indexOf("audio_complete")).toBeGreaterThan(types.indexOf("sources"));
    expect(types.indexOf("done")).toBe(types.indexOf("audio_complete") + 1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "sources", sources: [1], hasSourcesLine: true }),
    );
  });

  it("aborts in-flight TTS and terminates the response when LLM iteration fails", async () => {
    let markTtsStarted!: () => void;
    const ttsStarted = new Promise<void>((resolve) => {
      markTtsStarted = resolve;
    });
    let markTtsAborted!: () => void;
    const ttsAborted = new Promise<void>((resolve) => {
      markTtsAborted = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    let releaseHangingTts: (() => void) | undefined;

    mocks.ttsSentence.mockImplementationOnce(
      async (
        _sentence: string,
        _voiceId: string,
        _requestIds: string[],
        signal?: AbortSignal,
      ) => {
        capturedSignal = signal;
        markTtsStarted();
        return await new Promise((_, reject) => {
          let settled = false;
          const rejectOnce = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          releaseHangingTts = () => rejectOnce(new Error("test cleanup"));
          signal?.addEventListener(
            "abort",
            () => {
              markTtsAborted();
              rejectOnce(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          );
        });
      },
    );

    async function* failingTokens(): AsyncGenerator<string> {
      yield "The first sentence starts TTS. ";
      await ttsStarted;
      throw new Error("LLM stream failed");
    }
    mocks.askPersona.mockResolvedValueOnce({
      chunks: [],
      stream: failingTokens(),
      timings: { embedMs: 12, queryMs: 7 },
    });

    const completed = await beforeDeadline(
      responseEvents(await POST(askRequest())),
    );
    const cancelled = await beforeDeadline(ttsAborted);
    if (cancelled.timedOut) releaseHangingTts?.();
    await Promise.resolve();

    expect(completed.timedOut, "the NDJSON response should not hang with TTS").toBe(false);
    expect(completed.value).toContainEqual(
      expect.objectContaining({ type: "error", message: "LLM stream failed" }),
    );
    expect(cancelled.timedOut, "the shared upstream signal should cancel TTS").toBe(false);
    expect(capturedSignal?.aborted).toBe(true);
  });
});
