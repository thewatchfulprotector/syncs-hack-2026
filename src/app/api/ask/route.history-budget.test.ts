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

const HISTORY_MESSAGE_LIMIT = 6;
const HISTORY_CHARACTER_BUDGET = 6_000;

async function* noTokens(): AsyncGenerator<string> {
  // Token generation is irrelevant to request-boundary history validation.
}

describe("POST /api/ask history latency budget", () => {
  beforeEach(() => {
    mocks.getPersona.mockReset().mockReturnValue({
      id: "test-persona",
      name: "Test Persona",
      description: "a test persona",
      quotes: [],
    });
    mocks.askPersona.mockReset().mockResolvedValue({
      chunks: [],
      stream: noTokens(),
      timings: { embedMs: 1, queryMs: 1 },
    });
    mocks.ttsSentence.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("caps untrusted history before passing it into prompt construction", async () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index}:` + String(index).repeat(1_500),
    }));
    history.splice(4, 0, { role: "system", content: "untrusted system instruction" });
    const request = new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personaId: "test-persona",
        question: "Why?",
        history,
      }),
    });

    const response = await POST(request);
    await response.text();

    expect(mocks.askPersona).toHaveBeenCalledOnce();
    const priorTurns = mocks.askPersona.mock.calls[0][2] as Array<{
      role: string;
      content: string;
    }>;
    const totalCharacters = priorTurns.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    expect(priorTurns.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
    expect(totalCharacters).toBeLessThanOrEqual(HISTORY_CHARACTER_BUDGET);
    expect(priorTurns.every((message) => ["user", "assistant"].includes(message.role))).toBe(
      true,
    );
    expect(priorTurns.at(-1)?.content).toContain("turn-7:");
  });
});
