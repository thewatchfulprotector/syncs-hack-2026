import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "./openrouter";

type ObservableEmbedTexts = (
  texts: string[],
  signal?: AbortSignal,
  onProviderSelected?: (provider: string) => void,
) => Promise<number[][]>;

function embeddingResponse(vector: number[]): Response {
  return Response.json({ data: [{ index: 0, embedding: vector }] });
}

describe("embedding provider observability", () => {
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

  it("reports the provider that actually wins the single-query race", async () => {
    fetchMock.mockResolvedValue(embeddingResponse([1, 2, 3]));
    const onProviderSelected = vi.fn();

    const observableEmbedTexts = embedTexts as ObservableEmbedTexts;
    await expect(
      observableEmbedTexts(["hello"], undefined, onProviderSelected),
    ).resolves.toEqual([[1, 2, 3]]);

    expect(onProviderSelected).toHaveBeenCalledOnce();
    expect(onProviderSelected).toHaveBeenCalledWith("deepinfra");
  });
});
