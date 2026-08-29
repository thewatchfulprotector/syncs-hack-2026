// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const micHarness = vi.hoisted(() => ({
  calls: [] as Array<{
    options: Record<string, (...args: never[]) => void>;
    session: {
      stop: ReturnType<typeof vi.fn>;
      amplitude: ReturnType<typeof vi.fn>;
      setFrameForwarding: ReturnType<typeof vi.fn>;
    };
  }>,
}));

const audioHarness = vi.hoisted(() => ({
  events: [] as string[],
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
    playbackStarted: (sentence: string, durationSec: number) => void;
  }>,
}));

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

vi.mock("@/lib/micStream", () => ({
  prefetchSttToken: vi.fn(),
  startMicStream: vi.fn((options: Record<string, (...args: never[]) => void>) => {
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
    readonly unlock = vi.fn(async () => {
      audioHarness.events.push("unlock");
    });
    readonly beginAnswer = vi.fn(() => this.resetDrain());
    readonly stop = vi.fn(() => this.resolveDrain());
    readonly dispose = vi.fn(() => this.resolveDrain());
    readonly amplitude = vi.fn(() => null);
    readonly markInputComplete = vi.fn();
    queueDrained!: Promise<void>;
    resolveDrain!: () => void;
    readonly playbackStarted: (sentence: string, durationSec: number) => void;

    constructor(
      _onSpeakingChange: (value: boolean) => void,
      onPlaybackStart: (sentence: string, durationSec: number) => void,
    ) {
      this.resetDrain();
      this.playbackStarted = onPlaybackStart;
      audioHarness.instances.push(this);
    }

    private resetDrain(): void {
      let resolveDrain!: () => void;
      this.queueDrained = new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      this.resolveDrain = resolveDrain;
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
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function renderHome(): Promise<void> {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.querySelector("#root")!);
  await act(async () => {
    root!.render(createElement(Home));
    await flushMicrotasks();
  });
}

function orb(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("#test-orb")!;
}

function conversationButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("button[data-conversation]")!;
}

function micStatusLabel(): string {
  return (
    document.querySelector("main > div:first-child > div:first-child > span:last-child")
      ?.textContent ?? ""
  ).trim();
}

function questionInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("#question")!;
}

function enterInputValue(input: HTMLInputElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function ndjsonResponse(messages: unknown[]): Response {
  const bytes = new TextEncoder().encode(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
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

function malformedHangingResponse(): {
  response: Response;
  wasCancelled: () => boolean;
  release: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(encoder.encode("not-json\n"));
      // Intentionally do not close: a parser failure must tear down this
      // transport instead of leaving the reader locked on a hanging stream.
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: { ok: true, status: 200, body } as Response,
    wasCancelled: () => cancelled,
    release: () => {
      if (!cancelled) controller.close();
    },
  };
}

describe("Home voice lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    micHarness.calls = [];
    audioHarness.events = [];
    audioHarness.instances = [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 204, body: null }) as Response),
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("starts microphone capture in the enabling user gesture without a fixed timer", async () => {
    await renderHome();

    await act(async () => orb().click());

    expect(micHarness.calls).toHaveLength(1);
  });

  it("does not label capture as speech-safe until the STT transport is ready", async () => {
    await renderHome();
    await act(async () => orb().click());
    const { options } = micHarness.calls[0];

    expect(micStatusLabel()).toBe("Requesting microphone");

    await act(async () => {
      options.onCaptureReady?.();
      await flushMicrotasks();
    });

    expect(micStatusLabel()).toMatch(/connecting/i);
    expect(micStatusLabel()).not.toMatch(/listening/i);

    await act(async () => {
      options.onReady?.();
      await flushMicrotasks();
    });

    expect(micStatusLabel()).toBe("Listening");
  });

  it("unlocks playback synchronously on typed Enter before starting the ask request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        if (String(input) === "/api/ask") {
          audioHarness.events.push("fetch");
          return new Promise<Response>(() => {});
        }
        return Promise.resolve({ ok: true, status: 204, body: null } as Response);
      }),
    );
    await renderHome();
    const input = questionInput();
    await act(async () => {
      enterInputValue(input, "A typed question");
      await flushMicrotasks();
    });

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(audioHarness.instances).toHaveLength(1);
      expect(audioHarness.instances[0].unlock).toHaveBeenCalledOnce();
      expect(audioHarness.events).toEqual(["unlock", "fetch"]);
      await flushMicrotasks();
    });
  });

  it("manually interrupts an active answer without disabling conversation or stopping capture", async () => {
    let askSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/ask") {
          askSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        }
        return Promise.resolve({ ok: true, status: 204, body: null } as Response);
      }),
    );
    await renderHome();
    await act(async () => orb().click());
    await act(async () => {
      vi.advanceTimersByTime(600);
      await flushMicrotasks();
    });
    const { options, session } = micHarness.calls[0];

    await act(async () => {
      options.onReady?.();
      options.onTurnEnd?.("Why is the sky blue?" as never);
      await flushMicrotasks();
    });
    expect(askSignal?.aborted).toBe(false);

    await act(async () => {
      options.onSpeechStarted?.(1_240 as never);
      await flushMicrotasks();
    });

    expect(askSignal?.aborted).toBe(false);
    expect(audioHarness.instances[0].stop).not.toHaveBeenCalled();

    await act(async () => orb().click());

    expect(askSignal?.aborted).toBe(true);
    expect(audioHarness.instances[0].stop).toHaveBeenCalledOnce();
    expect(session.stop).not.toHaveBeenCalled();
    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(true);
    expect(conversationButton().dataset.conversation).toBe("true");
  });

  it("resumes frame forwarding on queue drain, not on response end or a 600 ms timer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        if (String(input) === "/api/ask") {
          return Promise.resolve(
            ndjsonResponse([
              { type: "generation_complete", correlationId: "turn-1" },
              { type: "audio_complete", correlationId: "turn-1" },
              { type: "done", correlationId: "turn-1", timings: {} },
            ]),
          );
        }
        return Promise.resolve({ ok: true, status: 204, body: null } as Response);
      }),
    );
    await renderHome();
    await act(async () => orb().click());
    await act(async () => {
      vi.advanceTimersByTime(600);
      await flushMicrotasks();
    });
    const { options, session } = micHarness.calls[0];

    await act(async () => {
      options.onReady?.();
      options.onTurnEnd?.("Say something brief." as never);
      await flushMicrotasks();
    });
    const queue = audioHarness.instances[0];

    expect(queue.markInputComplete).toHaveBeenCalledOnce();
    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(false);
    expect(micHarness.calls).toHaveLength(1);

    await act(async () => {
      queue.resolveDrain();
      await flushMicrotasks();
    });

    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(true);
    expect(micHarness.calls).toHaveLength(1);
  });

  it("uses current conversation history for later turns from the persistent mic callback", async () => {
    const requestBodies: Array<{
      question: string;
      history: Array<{ role: string; content: string }>;
    }> = [];
    let answerNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/ask") {
          requestBodies.push(JSON.parse(String(init?.body)));
          answerNumber++;
          return Promise.resolve(
            ndjsonResponse([
              { type: "token", text: `Answer ${answerNumber}.` },
              { type: "generation_complete" },
              { type: "audio_complete" },
              { type: "done", timings: {} },
            ]),
          );
        }
        return Promise.resolve({ ok: true, status: 204, body: null } as Response);
      }),
    );
    await renderHome();
    await act(async () => orb().click());
    const { options } = micHarness.calls[0];
    const queue = audioHarness.instances[0];

    await act(async () => {
      options.onTurnEnd?.("First question" as never);
      await flushMicrotasks();
    });
    await act(async () => {
      queue.resolveDrain();
      await flushMicrotasks();
    });
    await act(async () => {
      options.onTurnEnd?.("Second question" as never);
      await flushMicrotasks();
    });

    expect(micHarness.calls).toHaveLength(1);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toMatchObject({
      question: "Second question",
      history: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "Answer 1." },
      ],
    });

    await act(async () => {
      queue.resolveDrain();
      await flushMicrotasks();
    });
  });

  it("keeps an aborted turn cleanup from completing or resuming the next turn", async () => {
    const firstResponse = new Deferred<Response>();
    const secondResponse = new Deferred<Response>();
    let requestNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        if (String(input) === "/api/ask") {
          requestNumber++;
          return requestNumber === 1 ? firstResponse.promise : secondResponse.promise;
        }
        return Promise.resolve({ ok: true, status: 204, body: null } as Response);
      }),
    );
    await renderHome();
    await act(async () => orb().click());
    const { options, session } = micHarness.calls[0];
    const queue = audioHarness.instances[0];

    await act(async () => {
      options.onTurnEnd?.("Interrupt this first turn" as never);
      await flushMicrotasks();
    });
    await act(async () => orb().click());
    await act(async () => {
      options.onTurnEnd?.("Start the second turn" as never);
      await flushMicrotasks();
    });
    const forwardingCallsAtTurnTwoStart = session.setFrameForwarding.mock.calls.length;

    await act(async () => {
      firstResponse.reject(new Error("the first request observed its abort"));
      await flushMicrotasks();
    });

    expect(queue.markInputComplete).not.toHaveBeenCalled();
    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(false);
    expect(session.setFrameForwarding).toHaveBeenCalledTimes(forwardingCallsAtTurnTwoStart);

    await act(async () => {
      secondResponse.resolve(
        ndjsonResponse([
          { type: "generation_complete" },
          { type: "audio_complete" },
          { type: "done", timings: {} },
        ]),
      );
      await flushMicrotasks();
    });

    expect(queue.markInputComplete).toHaveBeenCalledOnce();
    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(false);
    expect(session.setFrameForwarding).toHaveBeenCalledTimes(forwardingCallsAtTurnTwoStart);

    await act(async () => {
      queue.resolveDrain();
      await flushMicrotasks();
    });

    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(true);
    expect(session.setFrameForwarding).toHaveBeenCalledTimes(forwardingCallsAtTurnTwoStart + 1);
  });

  it("aborts a pending ask on unmount without running stale cleanup after disposal", async () => {
    const pendingResponse = new Deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/ask") {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => pendingResponse.reject(requestSignal?.reason),
            { once: true },
          );
          return pendingResponse.promise;
        }
        return Promise.resolve({ ok: true, status: 204, body: null } as Response);
      }),
    );
    await renderHome();
    await act(async () => orb().click());
    const { options, session } = micHarness.calls[0];
    const queue = audioHarness.instances[0];

    await act(async () => {
      options.onTurnEnd?.("Keep this request pending" as never);
      await flushMicrotasks();
    });
    const forwardingCallsBeforeUnmount = session.setFrameForwarding.mock.calls.length;
    expect(requestSignal?.aborted).toBe(false);

    await act(async () => {
      root!.unmount();
      root = undefined;
      await flushMicrotasks();
    });

    expect(requestSignal?.aborted).toBe(true);
    expect(session.stop).toHaveBeenCalledOnce();
    expect(queue.dispose).toHaveBeenCalledOnce();
    expect(queue.markInputComplete).not.toHaveBeenCalled();
    expect(session.setFrameForwarding).toHaveBeenLastCalledWith(false);
    expect(session.setFrameForwarding).toHaveBeenCalledTimes(forwardingCallsBeforeUnmount);
  });

  it("tears down a hanging ask transport after malformed NDJSON and shows the parse error", async () => {
    const provider = malformedHangingResponse();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/ask") {
          requestSignal = init?.signal ?? undefined;
          return Promise.resolve(provider.response);
        }
        return Promise.resolve({ ok: true, status: 204, body: null } as Response);
      }),
    );
    await renderHome();
    await act(async () => orb().click());
    const { options } = micHarness.calls[0];
    const queue = audioHarness.instances[0];

    await act(async () => {
      options.onTurnEnd?.("Trigger malformed transport" as never);
      await flushMicrotasks();
    });

    // Check before playback-drain cleanup is released: transport teardown and
    // visible error handling must happen promptly at the parse failure.
    const transportStopped = provider.wasCancelled() || requestSignal?.aborted === true;
    const visibleText = document.body.textContent ?? "";
    expect(queue.markInputComplete).toHaveBeenCalledOnce();

    await act(async () => {
      provider.release();
      queue.resolveDrain();
      await flushMicrotasks();
    });

    expect(transportStopped, "cancel the reader or abort /api/ask promptly").toBe(true);
    expect(visibleText).toMatch(/not valid JSON|JSON at position|unexpected token/i);
  });

  it("allows a repeated user phrase once its own playback segment is outside the echo window", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === "/api/ask") return new Promise<Response>(() => {});
      return Promise.resolve({ ok: true, status: 204, body: null } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderHome();
    await act(async () => orb().click());
    const { options } = micHarness.calls[0];
    const queue = audioHarness.instances[0];

    await act(async () => {
      queue.playbackStarted("Tell me more about Aristotle.", 0.5);
      vi.advanceTimersByTime(5_501);
      queue.playbackStarted("A completely unrelated recent sentence.", 0.5);
      options.onTurnEnd?.("Tell me more about Aristotle." as never);
      await flushMicrotasks();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ask",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps a long sentence guarded until the window after playback ends", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === "/api/ask") return new Promise<Response>(() => {});
      return Promise.resolve({ ok: true, status: 204, body: null } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderHome();
    await act(async () => orb().click());
    const { options } = micHarness.calls[0];
    const queue = audioHarness.instances[0];
    const playedSentence = "Every once in a while, a revolutionary product comes along.";

    await act(async () => {
      queue.playbackStarted(playedSentence, 8);
      vi.advanceTimersByTime(8_000);
      options.onTurnEnd?.(playedSentence as never);
      await flushMicrotasks();
    });

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(5_001);
      options.onTurnEnd?.(playedSentence as never);
      await flushMicrotasks();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ask",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
