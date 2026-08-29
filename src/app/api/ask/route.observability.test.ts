import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TraceSink = (name: string, detail?: Record<string, unknown>) => void;

const mocks = vi.hoisted(() => ({
  askPersona: vi.fn(),
  getPersona: vi.fn(),
  ttsSentence: vi.fn(),
}));

vi.mock("@/lib/ask", () => ({ askPersona: mocks.askPersona }));
vi.mock("@/lib/elevenlabs", () => ({
  DEFAULT_VOICE_ID: "default-voice",
  TTS_MODEL: "eleven_flash_v2_5",
  ttsSentence: mocks.ttsSentence,
}));
vi.mock("@/lib/personas", () => ({ getPersona: mocks.getPersona }));

import { POST } from "./route";

const CORRELATION_ID = "turn-observability-001";

async function* answerTokens(): AsyncGenerator<string> {
  yield "A measured answer.";
}

function audioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
      controller.enqueue(Uint8Array.from([4, 5]));
      controller.close();
    },
  });
}

function askRequest(): Request {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-Id": CORRELATION_ID,
    },
    body: JSON.stringify({
      personaId: "test-persona",
      question: "What happened?",
      history: [],
    }),
  });
}

type Milestone = {
  name: string;
  atMs: number;
  detail?: Record<string, unknown>;
};

async function doneEvent(response: Response): Promise<Record<string, unknown>> {
  const events = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const done = events.find((event) => event.type === "done");
  if (!done) throw new Error("expected a done event");
  return done;
}

function milestoneIndex(milestones: Milestone[], name: string): number {
  return milestones.findIndex((milestone) => milestone.name === name);
}

describe("POST /api/ask Phase 0 observability", () => {
  beforeEach(() => {
    mocks.getPersona.mockReset().mockReturnValue({
      id: "test-persona",
      name: "Test Persona",
      description: "a test persona",
      quotes: [],
      voiceId: "voice-observability",
    });
    mocks.askPersona.mockReset().mockImplementation(async (...args: unknown[]) => {
      // Keep topK as the fifth argument; the sixth argument is the deliberately
      // tiny injection contract that lets retrieval report into the route trace.
      const onTrace = args[5] as TraceSink | undefined;
      onTrace?.("embedding_start");
      onTrace?.("embedding_complete", { provider: "deepinfra" });
      onTrace?.("pinecone_start");
      onTrace?.("pinecone_complete", { matchCount: 2, hostResolution: false });
      return {
        chunks: [],
        stream: answerTokens(),
        timings: { embedMs: 10, queryMs: 4 },
      };
    });
    mocks.ttsSentence.mockReset().mockResolvedValue({
      stream: audioStream(),
      requestId: "tts-request-observability",
      servingRegion: "iad1",
      format: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns one correlated, chronologically ordered trace spanning retrieval, generation, and audio", async () => {
    const done = await doneEvent(await POST(askRequest()));
    const trace = done.trace as
      | { correlationId?: unknown; milestones?: Milestone[] }
      | undefined;
    const milestones = trace?.milestones ?? [];
    const names = milestones.map((milestone) => milestone.name);

    expect(trace?.correlationId).toBe(CORRELATION_ID);
    expect(names[0]).toBe("route_entry");
    expect(names).toEqual(
      expect.arrayContaining([
        "route_entry",
        "embedding_start",
        "embedding_complete",
        "pinecone_start",
        "pinecone_complete",
        "llm_first_token",
        "generation_complete",
        "tts_request_start",
        "tts_response_headers",
        "tts_first_byte",
        "tts_complete",
        "audio_complete",
      ]),
    );

    expect(
      milestones.every(
        (milestone) => Number.isFinite(milestone.atMs) && milestone.atMs >= 0,
      ),
    ).toBe(true);
    expect(milestones.map((milestone) => milestone.atMs)).toEqual(
      [...milestones.map((milestone) => milestone.atMs)].sort((a, b) => a - b),
    );

    const before = (earlier: string, later: string) => {
      expect(milestoneIndex(milestones, earlier), `${earlier} should be recorded`).toBeGreaterThanOrEqual(0);
      expect(milestoneIndex(milestones, later), `${later} should be recorded`).toBeGreaterThanOrEqual(0);
      expect(milestoneIndex(milestones, earlier)).toBeLessThan(
        milestoneIndex(milestones, later),
      );
    };

    before("route_entry", "embedding_start");
    before("embedding_start", "embedding_complete");
    before("embedding_complete", "pinecone_start");
    before("pinecone_start", "pinecone_complete");
    before("pinecone_complete", "llm_first_token");
    before("llm_first_token", "generation_complete");
    before("llm_first_token", "tts_request_start");
    before("tts_request_start", "tts_response_headers");
    before("tts_response_headers", "tts_first_byte");
    before("tts_first_byte", "tts_complete");
    before("generation_complete", "audio_complete");
    before("tts_complete", "audio_complete");

    expect(milestones.find((milestone) => milestone.name === "embedding_complete")?.detail).toMatchObject({
      provider: "deepinfra",
    });
    expect(milestones.find((milestone) => milestone.name === "tts_response_headers")?.detail).toMatchObject({
      requestId: "tts-request-observability",
      servingRegion: "iad1",
    });
  });
});
