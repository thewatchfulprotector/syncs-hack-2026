// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MicOptions = {
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
    readonly enqueuePcm16: ReturnType<typeof vi.fn>;
    readonly unlock = vi.fn(async () => {});
    readonly beginAnswer = vi.fn();
    readonly stop = vi.fn();
    readonly dispose = vi.fn();
    readonly amplitude = vi.fn(() => null);
    readonly markInputComplete = vi.fn();
    readonly queueDrained: Promise<void>;
    readonly resolveDrain: () => void;
    private firstPcmReported = false;

    constructor(
      _onSpeakingChange?: (speaking: boolean) => void,
      _onSentenceStart?: (text: string, durationSec: number) => void,
      onFirstPcmSourceScheduled?: () => void,
    ) {
      this.enqueuePcm16 = vi.fn(async () => {
        if (this.firstPcmReported) return;
        this.firstPcmReported = true;
        onFirstPcmSourceScheduled?.();
      });
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

type Milestone = { name: string; atMs: number };

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
    await vi.advanceTimersByTimeAsync(0);
  });
}

function askResponse(correlationId: string): Response {
  const serverTrace = {
    correlationId,
    milestones: [
      { name: "route_entry", atMs: 0 },
      { name: "audio_complete", atMs: 12 },
    ],
  };
  const messages = [
    {
      type: "audio_chunk",
      sentenceSeq: 0,
      chunkSeq: 0,
      text: "Measured answer.",
      format: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      audioBase64: "AAA=",
      correlationId,
    },
    {
      type: "audio_chunk",
      sentenceSeq: 0,
      chunkSeq: 1,
      text: "Measured answer.",
      format: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      audioBase64: "AQA=",
      correlationId,
    },
    { type: "generation_complete", correlationId },
    { type: "audio_complete", correlationId },
    { type: "done", timings: { totalMs: 12 }, trace: serverTrace, correlationId },
  ];
  const bytes = new TextEncoder().encode(
    messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as Response;
}

function milestoneIndex(milestones: Milestone[], name: string): number {
  return milestones.findIndex((milestone) => milestone.name === name);
}

describe("Home Phase 0 debug trace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    micHarness.calls = [];
    audioHarness.instances = [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/?debug=1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== "/api/ask") {
          return { ok: true, status: 204, body: null } as Response;
        }
        const correlationId = new Headers(init?.headers).get("x-correlation-id");
        if (!correlationId) throw new Error("expected the ask correlation ID");
        return askResponse(correlationId);
      }),
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("shows the correlated server trace and client milestones through mic resume", async () => {
    await renderHome();
    await act(async () => {
      document.querySelector<HTMLButtonElement>("#test-orb")!.click();
      await flushMicrotasks();
    });
    const { options, session } = micHarness.calls[0];

    await act(async () => {
      options.onTurnEnd?.("Measure this turn.");
      await flushMicrotasks();
    });
    const queue = audioHarness.instances[0];

    await act(async () => {
      queue.resolveDrain();
      await flushMicrotasks();
    });

    const debug = JSON.parse(document.querySelector("#timings")?.textContent ?? "null") as {
      correlationId?: string;
      serverTrace?: { correlationId?: string; milestones?: Milestone[] };
      clientTrace?: { correlationId?: string; milestones?: Milestone[] };
    } | null;
    const clientMilestones = debug?.clientTrace?.milestones ?? [];
    const names = clientMilestones.map((milestone) => milestone.name);

    expect(debug?.correlationId).toEqual(expect.any(String));
    expect(debug?.serverTrace?.correlationId).toBe(debug?.correlationId);
    expect(debug?.clientTrace?.correlationId).toBe(debug?.correlationId);
    expect(debug?.serverTrace?.milestones?.map((milestone) => milestone.name)).toEqual([
      "route_entry",
      "audio_complete",
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        "ask_request_start",
        "first_audio_packet",
        "first_pcm_source_scheduled",
        "playback_drained",
        "mic_forwarding_resumed",
      ]),
    );
    expect(names.filter((name) => name === "first_audio_packet")).toHaveLength(1);
    expect(names.filter((name) => name === "first_pcm_source_scheduled")).toHaveLength(1);

    const before = (earlier: string, later: string) => {
      expect(milestoneIndex(clientMilestones, earlier), `${earlier} should be recorded`).toBeGreaterThanOrEqual(0);
      expect(milestoneIndex(clientMilestones, later), `${later} should be recorded`).toBeGreaterThanOrEqual(0);
      expect(milestoneIndex(clientMilestones, earlier)).toBeLessThan(
        milestoneIndex(clientMilestones, later),
      );
    };
    before("ask_request_start", "first_audio_packet");
    before("first_audio_packet", "first_pcm_source_scheduled");
    before("first_pcm_source_scheduled", "playback_drained");
    before("playback_drained", "mic_forwarding_resumed");

    expect(
      clientMilestones.every(
        (milestone) => Number.isFinite(milestone.atMs) && milestone.atMs >= 0,
      ),
    ).toBe(true);
    expect(clientMilestones.map((milestone) => milestone.atMs)).toEqual(
      [...clientMilestones.map((milestone) => milestone.atMs)].sort((a, b) => a - b),
    );
    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(true);
  });
});
