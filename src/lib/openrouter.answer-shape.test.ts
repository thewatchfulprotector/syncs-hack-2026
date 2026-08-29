import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "./openrouter";

const VOICE_OUTPUT_TOKEN_LIMIT = 256;

function chatStreamResponse(...tokens: string[]): Response {
  const body = tokens
    .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenRouter voice answer shape", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("caps chat completion output for a conversational voice answer", async () => {
    fetchMock.mockResolvedValue(chatStreamResponse("A short answer."));

    const received: string[] = [];
    for await (const token of streamChat([{ role: "user", content: "Why?" }])) {
      received.push(token);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const request = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(received).toEqual(["A short answer."]);
    expect(request.max_completion_tokens).toBe(VOICE_OUTPUT_TOKEN_LIMIT);
  });
});
