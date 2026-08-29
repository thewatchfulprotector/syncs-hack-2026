// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HISTORY_MESSAGE_LIMIT = 6;
const HISTORY_CHARACTER_BUDGET = 6_000;

const micHarness = vi.hoisted(() => ({
  options: undefined as Record<string, (...args: never[]) => void> | undefined,
}));

const audioHarness = vi.hoisted(() => ({
  resolveDrain: undefined as (() => void) | undefined,
}));

vi.mock("@/lib/micStream", () => ({
  prefetchSttToken: vi.fn(),
  startMicStream: vi.fn((options: Record<string, (...args: never[]) => void>) => {
    micHarness.options = options;
    return {
      stop: vi.fn(),
      amplitude: vi.fn(() => null),
      setFrameForwarding: vi.fn(),
    };
  }),
}));

vi.mock("@/lib/audioQueue", () => ({
  AudioQueue: class {
    readonly enqueue = vi.fn(async () => {});
    readonly enqueueBytes = vi.fn(async () => {});
    readonly enqueuePcm16 = vi.fn(async () => {});
    readonly unlock = vi.fn(async () => {});
    readonly beginAnswer = vi.fn();
    readonly stop = vi.fn();
    readonly dispose = vi.fn();
    readonly amplitude = vi.fn(() => null);
    readonly markInputComplete = vi.fn();
    readonly queueDrained: Promise<void>;

    constructor() {
      this.queueDrained = new Promise<void>((resolve) => {
        audioHarness.resolveDrain = resolve;
      });
    }
  },
}));

vi.mock("./orb", async () => {
  const { createElement } = await import("react");
  return {
    Orb: ({ onClick }: { onClick: () => void }) =>
      createElement("button", { id: "test-orb", onClick }, "orb"),
  };
});

import Home from "./page";

let root: Root | undefined;

function ndjsonResponse(messages: unknown[]): Response {
  const body = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

describe("browser history latency budget", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    micHarness.options = undefined;
    audioHarness.resolveDrain = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("caps history before serializing the next ask request", async () => {
    let answerIndex = 0;
    fetchMock.mockImplementation((input: string | URL | Request) => {
      if (String(input) !== "/api/ask") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const answer = `assistant-${answerIndex++}:` + "a".repeat(1_800);
      return Promise.resolve(
        ndjsonResponse([
          { type: "token", text: `${answer}\nSOURCES:` },
          { type: "generation_complete" },
          { type: "sources", sources: [], hasSourcesLine: true },
          { type: "audio_complete" },
          { type: "done", timings: {} },
        ]),
      );
    });

    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.querySelector("#root")!);
    await act(async () => {
      root!.render(createElement(Home));
      await flushMicrotasks();
    });
    for (let index = 0; index < 5; index++) {
      const input = document.querySelector<HTMLInputElement>("#question")!;
      await act(async () => {
        const setInputValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setInputValue?.call(input, `question-${index}:` + "q".repeat(1_800));
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        await flushMicrotasks();
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        audioHarness.resolveDrain?.();
        await flushMicrotasks();
      });
      const askCalls = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/ask");
      expect(askCalls).toHaveLength(index + 1);
    }

    const askCalls = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/ask");
    const [, latestInit] = askCalls.at(-1) as [string, RequestInit];
    const request = JSON.parse(String(latestInit.body)) as {
      history: Array<{ role: string; content: string }>;
    };
    const totalCharacters = request.history.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    expect(request.history.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
    expect(totalCharacters).toBeLessThanOrEqual(HISTORY_CHARACTER_BUDGET);
    expect(request.history.at(-1)?.content).toContain("assistant-3:");
  });
});
