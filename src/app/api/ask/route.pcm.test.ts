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

type ProtocolEvent = Record<string, unknown> & { type: string };

async function* tokens(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

function gatedPcmStream(first: number[], last: number[]): {
  stream: ReadableStream<Uint8Array>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deliveredLast = false;
  return {
    release,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(first));
      },
      async pull(controller) {
        if (deliveredLast) return;
        deliveredLast = true;
        await gate;
        controller.enqueue(Uint8Array.from(last));
        controller.close();
      },
    }),
  };
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
      if (done) return null;
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

describe("POST /api/ask PCM protocol", () => {
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
      stream: tokens("A progressive sentence. ", "SOURCES: 1"),
      timings: {},
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("labels every progressive provider packet as mono PCM16 little-endian", async () => {
    const provider = gatedPcmStream([0x00, 0x00], [0xff, 0x7f]);
    mocks.ttsSentence.mockResolvedValueOnce({
      stream: provider.stream,
      requestId: "tts-pcm-request",
      format: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
    });
    const response = await POST(
      new Request("http://localhost/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personaId: "test-persona",
          question: "Why?",
          history: [],
        }),
      }),
    );
    const reader = new EventReader(response);
    const beforeProviderCompletion = (async () => {
      for (;;) {
        const event = await reader.next();
        if (!event || event.type === "audio_chunk") return event;
      }
    })();

    const early = await beforeDeadline(beforeProviderCompletion);
    provider.release();
    const firstAudio = early.timedOut ? await beforeProviderCompletion : early.value;
    const remaining = await reader.rest();

    expect(early.timedOut).toBe(false);
    expect(firstAudio).toMatchObject({
      type: "audio_chunk",
      sentenceSeq: 0,
      chunkSeq: 0,
      format: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      audioBase64: "AAA=",
    });
    expect(remaining.filter((event) => event.type === "audio_chunk")).toEqual([
      expect.objectContaining({
        chunkSeq: 1,
        format: "pcm_s16le",
        sampleRate: 24_000,
        channels: 1,
        audioBase64: "/38=",
      }),
    ]);
    expect(remaining.map((event) => event.type)).toContain("audio_sentence_complete");
    expect(remaining.map((event) => event.type)).toContain("audio_complete");
  });
});
