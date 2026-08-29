import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ttsSentence } from "./elevenlabs";

function providerResponse(chunks: number[][]): {
  response: Response;
  arrayBuffer: ReturnType<typeof vi.spyOn>;
} {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
  const response = new Response(body, { headers: { "request-id": "tts-request-123" } });
  return { response, arrayBuffer: vi.spyOn(response, "arrayBuffer") };
}

async function readChunks(stream: ReadableStream<Uint8Array>): Promise<number[][]> {
  const chunks: number[][] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push([...value]);
  }
}

describe("ElevenLabs progressive TTS", () => {
  const fetchMock = vi.fn();
  let previousApiKey: string | undefined;

  beforeEach(() => {
    previousApiKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = previousApiKey;
    vi.restoreAllMocks();
  });

  it("uses the /stream endpoint and exposes its body without arrayBuffer buffering", async () => {
    const provider = providerResponse([[1, 2], [3, 4]]);
    fetchMock.mockResolvedValueOnce(provider.response);

    const result = await ttsSentence("Hello.", "voice-test", [], new AbortController().signal);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);

    expect.soft(requestUrl).toContain("/text-to-speech/voice-test/stream?");
    expect.soft(provider.arrayBuffer).not.toHaveBeenCalled();
    expect.soft((result as unknown as { stream?: ReadableStream<Uint8Array> }).stream).toBe(
      provider.response.body,
    );
    expect(result.requestId).toBe("tts-request-123");
  });

  it("preserves provider byte chunks for progressive downstream forwarding", async () => {
    const provider = providerResponse([[1, 2], [3], [4, 5, 6]]);
    fetchMock.mockResolvedValueOnce(provider.response);

    const result = await ttsSentence("Hello.", "voice-test");
    const stream = (result as unknown as { stream?: ReadableStream<Uint8Array> }).stream;
    expect(stream, "ttsSentence must return the provider stream").toBeDefined();
    if (!stream) return;

    expect(await readChunks(stream)).toEqual([[1, 2], [3], [4, 5, 6]]);
  });
});
