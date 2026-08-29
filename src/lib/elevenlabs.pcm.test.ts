import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ttsSentence } from "./elevenlabs";

describe("ElevenLabs raw PCM transport", () => {
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
  });

  it("requests 24 kHz raw PCM from the progressive /stream endpoint", async () => {
    const providerStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0x00, 0x00, 0xff, 0x7f]));
        controller.close();
      },
    });
    const providerResponse = new Response(providerStream);
    fetchMock.mockResolvedValueOnce(providerResponse);

    const result = await ttsSentence("Speak progressively.", "voice-test");
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));

    expect(requestUrl.pathname).toBe("/v1/text-to-speech/voice-test/stream");
    expect(requestUrl.searchParams.get("output_format")).toBe("pcm_24000");
    expect(result.stream).toBe(providerResponse.body);
  });
});
