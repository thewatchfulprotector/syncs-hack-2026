import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createStreamingToken: vi.fn(),
}));

vi.mock("@/lib/assemblyai", () => ({
  createStreamingToken: mocks.createStreamingToken,
}));

import { POST } from "./route";

const NOW_MS = 1_788_000_000_000;
const TOKEN_TTL_SECONDS = 300;
const TOKEN_TTL_MS = TOKEN_TTL_SECONDS * 1000;
const CORRELATION_ID = "3b74653c-85d1-4b91-91e7-d2d3cf677bbd";

type TokenLease = {
  token: string;
  issuedAt: number;
  expiresAt: number;
  correlationId: string;
};

function tokenRequest(correlationId: string | null = CORRELATION_ID): Request {
  const headers = new Headers();
  if (correlationId) headers.set("x-correlation-id", correlationId);
  return new Request("http://localhost/api/stt-token", { method: "POST", headers });
}

async function invoke(request: Request): Promise<Response> {
  return (POST as unknown as (request: Request) => Promise<Response>)(request);
}

describe("POST /api/stt-token lease contract", () => {
  beforeEach(() => {
    mocks.createStreamingToken.mockReset().mockResolvedValue("assembly-single-use-token");
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints a 300-second single-use token and returns an uncacheable lease", async () => {
    const response = await invoke(tokenRequest());
    const lease = (await response.json()) as TokenLease;

    expect(mocks.createStreamingToken).toHaveBeenCalledOnce();
    expect(mocks.createStreamingToken).toHaveBeenCalledWith(TOKEN_TTL_SECONDS);
    expect(lease).toEqual({
      token: "assembly-single-use-token",
      issuedAt: NOW_MS,
      expiresAt: NOW_MS + TOKEN_TTL_MS,
      correlationId: CORRELATION_ID,
    });
    expect(response.headers.get("cache-control")).toMatch(/(?:^|,)\s*no-store(?:\s*(?:,|$))/i);
    expect(response.headers.get("x-correlation-id")).toBe(CORRELATION_ID);
  });

  it("generates one correlation ID when the prefetch request does not have one", async () => {
    const response = await invoke(tokenRequest(null));
    const lease = (await response.json()) as TokenLease;
    const generated = response.headers.get("x-correlation-id");

    expect(generated).toEqual(expect.any(String));
    expect(generated?.length).toBeGreaterThanOrEqual(16);
    expect(lease.correlationId).toBe(generated);
  });
});
