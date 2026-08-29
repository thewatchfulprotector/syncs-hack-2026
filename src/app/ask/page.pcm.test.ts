// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MicOptions = {
  onCaptureReady?: () => void;
  onReady?: () => void;
  onTurnEnd?: (text: string) => void;
};

const micHarness = vi.hoisted(() => ({
  calls: [] as Array<{
    options: MicOptions;
    session: {
      stop: ReturnType<typeof vi.fn>;
      amplitude: ReturnType<typeof vi.fn>;
      setFrameForwarding: ReturnType<typeof vi.fn>;
    };
  }>,
}));

const audioHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    enqueue: ReturnType<typeof vi.fn>;
    enqueueBytes: ReturnType<typeof vi.fn>;
    enqueuePcm16: ReturnType<typeof vi.fn>;
    unlock: ReturnType<typeof vi.fn>;
    beginAnswer: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    amplitude: ReturnType<typeof vi.fn>;
    markInputComplete: ReturnType<typeof vi.fn>;
    queueDrained: Promise<void>;
    resolveDrain: () => void;
  }>,
}));

vi.mock("@/lib/micStream", () => ({
  prefetchSttToken: vi.fn(),
  startMicStream: vi.fn((options: MicOptions) => {
    const session = {
      stop: vi.fn(),
      amplitude: vi.fn(() => null),
      setFrameForwarding: vi.fn(),
    };
    micHarness.calls.push({ options, session });
    return session;
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
    readonly resolveDrain: () => void;

    constructor() {
      let resolveDrain!: () => void;
      this.queueDrained = new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      this.resolveDrain = resolveDrain;
      audioHarness.instances.push(this);
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

async function renderHome(): Promise<void> {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.querySelector("#root")!);
  await act(async () => {
    root!.render(createElement(Home));
    await flushMicrotasks();
  });
}

function gatedAskResponse(): { response: Response; release: () => void } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const firstPacket = {
    type: "audio_chunk",
    sentenceSeq: 0,
    chunkSeq: 0,
    text: "First sentence.",
    format: "pcm_s16le",
    sampleRate: 24_000,
    channels: 1,
    audioBase64: "AAA=",
    correlationId: "turn-pcm",
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(encoder.encode(`${JSON.stringify(firstPacket)}\n`));
    },
  });
  return {
    response: { ok: true, status: 200, body: stream } as Response,
    release() {
      const rest = [
        {
          type: "audio_chunk",
          sentenceSeq: 0,
          chunkSeq: 1,
          text: "First sentence.",
          format: "pcm_s16le",
          sampleRate: 24_000,
          channels: 1,
          audioBase64: "/38=",
          correlationId: "turn-pcm",
        },
        {
          type: "audio_sentence_complete",
          sentenceSeq: 0,
          text: "First sentence.",
          correlationId: "turn-pcm",
        },
        { type: "generation_complete", correlationId: "turn-pcm" },
        {
          type: "sources",
          sources: [],
          hasSourcesLine: false,
          correlationId: "turn-pcm",
        },
        { type: "audio_complete", correlationId: "turn-pcm" },
        { type: "done", timings: {}, correlationId: "turn-pcm" },
      ];
      controller.enqueue(
        encoder.encode(rest.map((message) => JSON.stringify(message)).join("\n") + "\n"),
      );
      controller.close();
    },
  };
}

describe("Home progressive PCM playback", () => {
  beforeEach(() => {
    micHarness.calls = [];
    audioHarness.instances = [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

  it("forwards each PCM packet immediately instead of assembling a complete sentence", async () => {
    const provider = gatedAskResponse();
    vi.stubGlobal("fetch", vi.fn(async () => provider.response));
    await renderHome();

    await act(async () => {
      document.querySelector<HTMLButtonElement>("#test-orb")!.click();
      await flushMicrotasks();
    });
    const { options } = micHarness.calls[0];
    await act(async () => {
      options.onTurnEnd?.("Say it progressively.");
      await flushMicrotasks();
    });
    const queue = audioHarness.instances[0];
    const callsBeforeSentenceAndProviderCompletion = [...queue.enqueuePcm16.mock.calls];
    const encodedCallsBeforeCompletion = [...queue.enqueueBytes.mock.calls];

    await act(async () => {
      provider.release();
      await flushMicrotasks();
      queue.resolveDrain();
      await flushMicrotasks();
    });

    expect(callsBeforeSentenceAndProviderCompletion).toHaveLength(1);
    expect(callsBeforeSentenceAndProviderCompletion[0]).toEqual([
      Uint8Array.from([0x00, 0x00]),
      "First sentence.",
      24_000,
    ]);
    expect(encodedCallsBeforeCompletion).toHaveLength(0);
    expect(queue.enqueuePcm16).toHaveBeenNthCalledWith(
      2,
      Uint8Array.from([0xff, 0x7f]),
      "",
      24_000,
    );
    expect(queue.enqueueBytes).not.toHaveBeenCalled();
    expect(queue.markInputComplete).toHaveBeenCalledOnce();
  });
});
