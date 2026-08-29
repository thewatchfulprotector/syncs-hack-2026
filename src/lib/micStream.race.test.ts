import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMicStream, type MicSession } from "./micStream";

class FakeTrack {
  readonly stop = vi.fn();
}

class FakeMediaStream {
  readonly track = new FakeTrack();
  readonly getTracks = vi.fn(() => [this.track] as unknown as MediaStreamTrack[]);
}

class FakeCaptureContext {
  state: AudioContextState = "running";
  readonly destination = {} as AudioDestinationNode;
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });
  readonly audioWorklet = { addModule: vi.fn(async () => {}) };
  readonly source = { connect: vi.fn() };
  readonly analyser = {
    fftSize: 0,
    getByteTimeDomainData: vi.fn(),
  };
  readonly createMediaStreamSource = vi.fn(
    () => this.source as unknown as MediaStreamAudioSourceNode,
  );
  readonly createAnalyser = vi.fn(() => this.analyser as unknown as AnalyserNode);

  constructor(readonly sampleRate = 16_000) {}
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];

  readonly port: {
    onmessage: ((event: MessageEvent<Float32Array>) => void) | null;
  } = { onmessage: null };
  readonly connect = vi.fn();

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }

  emit(samples: Float32Array): void {
    this.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  disconnect(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new Event("close") as CloseEvent);
  }
}

const sessions: MicSession[] = [];

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function installHarness(sampleRate = 16_000): FakeCaptureContext {
  const context = new FakeCaptureContext(sampleRate);
  const media = new FakeMediaStream();
  const fetchMock = vi.fn(async () =>
    Response.json({
      token: `token-${fetchMock.mock.calls.length}`,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    }),
  );

  function AudioContextFactory() {
    return context;
  }

  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => media as unknown as MediaStream),
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("AudioContext", AudioContextFactory);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:pcm-capture"),
    revokeObjectURL: vi.fn(),
  });
  return context;
}

function start(onTurnEnd = vi.fn()): { session: MicSession; onTurnEnd: ReturnType<typeof vi.fn> } {
  const session = startMicStream({
    onPartial: vi.fn(),
    onTurnEnd,
    onError: vi.fn(),
  });
  sessions.push(session);
  return { session, onTurnEnd };
}

describe("microphone transport race regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioWorkletNode.instances = [];
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("catches up a five-frame preconnection backlog at a bounded 2x rate while live frames continue", async () => {
    installHarness();
    start();
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];

    for (let i = 0; i < 5; i++) worklet.emit(new Float32Array(1_600).fill(i / 10));
    expect(socket.send).not.toHaveBeenCalled();

    socket.open();
    expect(socket.send).toHaveBeenCalledTimes(1);

    let previousCount = socket.send.mock.calls.length;
    for (let tick = 0; tick < 5; tick++) {
      worklet.emit(new Float32Array(1_600).fill((tick + 5) / 10));
      await vi.advanceTimersByTimeAsync(100);
      const sentThisTick = socket.send.mock.calls.length - previousCount;
      expect(sentThisTick).toBeGreaterThanOrEqual(1);
      expect(sentThisTick).toBeLessThanOrEqual(2);
      previousCount = socket.send.mock.calls.length;
    }

    // Five queued frames plus five new frames are all forwarded within 500 ms;
    // this drains startup latency without a burst larger than two frames/tick.
    expect(socket.send).toHaveBeenCalledTimes(10);
  });

  it("retains exactly the newest one second of audio while the transport is delayed", async () => {
    installHarness();
    start();
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];

    const levels = Array.from({ length: 12 }, (_, index) => (index + 1) / 16);
    for (const level of levels) {
      worklet.emit(new Float32Array(1_600).fill(level));
    }
    expect(socket.send).not.toHaveBeenCalled();

    socket.open();
    await vi.advanceTimersByTimeAsync(500);

    // The backlog is intentionally bounded, not lossless: twelve 100 ms
    // frames overflow it by two, retaining frames 3..12 in FIFO order.
    expect(socket.send).toHaveBeenCalledTimes(10);
    const sentFirstSamples = socket.send.mock.calls.map(([rawFrame]) =>
      new Int16Array(rawFrame as ArrayBuffer)[0],
    );
    expect(sentFirstSamples).toEqual(
      levels.slice(2).map((level) => Math.round(level * 32_767)),
    );
  });

  it("activates a suspended capture context synchronously before microphone permission resolves", () => {
    const context = installHarness();
    context.state = "suspended";
    const pendingPermission = new Promise<MediaStream>(() => {});
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pendingPermission) },
    });
    const AudioContextFactory = vi.fn(function AudioContextFactory() {
      return context;
    });
    vi.stubGlobal("AudioContext", AudioContextFactory);

    start();

    // Both calls must happen in the original click stack. Waiting for the
    // permission promise first forfeits user activation in affected browsers.
    expect(AudioContextFactory).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledOnce();
  });

  it("stops a MediaStream whose permission resolves after capture activation fails", async () => {
    const context = installHarness();
    context.state = "suspended";
    context.resume.mockRejectedValueOnce(new Error("capture activation failed"));
    const lateMedia = new FakeMediaStream();
    let resolvePermission!: (stream: MediaStream) => void;
    const pendingPermission = new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pendingPermission) },
    });

    start();
    await flushMicrotasks();

    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(lateMedia.track.stop).not.toHaveBeenCalled();

    resolvePermission(lateMedia as unknown as MediaStream);
    await flushMicrotasks();

    // The failed session can no longer assign the late stream to its `media`
    // field, so the permission branch itself must dispose it on arrival.
    expect(lateMedia.track.stop).toHaveBeenCalledOnce();
  });

  it("stops an acquired MediaStream when capture activation rejects afterward", async () => {
    const context = installHarness();
    context.state = "suspended";
    let rejectActivation!: (reason: unknown) => void;
    const pendingActivation = new Promise<void>((_resolve, reject) => {
      rejectActivation = reject;
    });
    context.resume.mockReturnValueOnce(pendingActivation);
    const acquiredMedia = new FakeMediaStream();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => acquiredMedia as unknown as MediaStream),
      },
    });

    start();
    await flushMicrotasks();

    expect(context.resume).toHaveBeenCalledOnce();
    expect(acquiredMedia.track.stop).not.toHaveBeenCalled();

    rejectActivation(new Error("capture activation failed after permission"));
    await flushMicrotasks();

    expect(context.close).toHaveBeenCalledOnce();
    expect(acquiredMedia.track.stop).toHaveBeenCalledOnce();
  });

  it("deduplicates turn_order only within one WebSocket session", async () => {
    installHarness();
    const onTurnEnd = vi.fn();
    start(onTurnEnd);
    await flushMicrotasks();
    const first = FakeWebSocket.instances[0];
    first.open();

    first.message({ type: "Turn", transcript: "first session", end_of_turn: true, turn_order: 0 });
    first.message({ type: "Turn", transcript: "duplicate", end_of_turn: true, turn_order: 0 });
    first.disconnect();
    await flushMicrotasks();

    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();
    second.open();
    second.message({ type: "Turn", transcript: "second session", end_of_turn: true, turn_order: 0 });

    expect(onTurnEnd).toHaveBeenCalledTimes(2);
    expect(onTurnEnd).toHaveBeenNthCalledWith(1, "first session");
    expect(onTurnEnd).toHaveBeenNthCalledWith(2, "second session");
  });

  it("preserves resampler phase across 48 kHz AudioWorklet quantum boundaries", async () => {
    installHarness(48_000);
    start();
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];
    socket.open();
    socket.send.mockClear();

    // 4,800 capture samples are exactly 100 ms at 48 kHz, but browsers deliver
    // them as smaller AudioWorklet quanta. Exercise 37 complete 128-sample
    // quanta plus a final 64 samples so phase cannot reset at callback edges.
    const source = Float32Array.from(
      { length: 4_800 },
      (_, index) => -0.75 + (index * 1.5) / 4_799,
    );
    for (let offset = 0; offset < 37 * 128; offset += 128) {
      worklet.emit(source.subarray(offset, offset + 128));
    }
    worklet.emit(source.subarray(37 * 128));

    expect(socket.send).toHaveBeenCalledOnce();
    const rawFrame = socket.send.mock.calls[0][0];
    expect(rawFrame).toBeInstanceOf(ArrayBuffer);
    expect((rawFrame as ArrayBuffer).byteLength).toBe(
      1_600 * Int16Array.BYTES_PER_ELEMENT,
    );

    const frame = new Int16Array(rawFrame as ArrayBuffer);
    for (const outputIndex of [0, 42, 43, 85, 86, 1_599]) {
      expect(frame[outputIndex]).toBeCloseTo(
        Math.round(source[outputIndex * 3] * 32_767),
        0,
      );
    }
    for (let index = 1; index < frame.length; index++) {
      expect(frame[index]).toBeGreaterThan(frame[index - 1]);
    }
  });

  it("records stt_first_partial once for each finalized turn", async () => {
    installHarness();
    const onTrace = vi.fn();
    const session = startMicStream({
      onPartial: vi.fn(),
      onTurnEnd: vi.fn(),
      onError: vi.fn(),
      onTrace,
    });
    sessions.push(session);
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.message({ type: "Turn", transcript: "first", end_of_turn: false });
    socket.message({ type: "Turn", transcript: "first expanded", end_of_turn: false });
    socket.message({ type: "Turn", transcript: "first final", end_of_turn: true });
    socket.message({ type: "Turn", transcript: "second", end_of_turn: false });
    socket.message({ type: "Turn", transcript: "second expanded", end_of_turn: false });
    socket.message({ type: "Turn", transcript: "second final", end_of_turn: true });

    const eventNames = onTrace.mock.calls.map(([event]) => event.name);
    expect(eventNames.filter((name) => name === "stt_first_partial")).toEqual([
      "stt_first_partial",
      "stt_first_partial",
    ]);
    expect(eventNames.filter((name) => name === "stt_partial")).toHaveLength(4);
  });

  it("records the first forwarded capture frame again after each turn gate", async () => {
    installHarness();
    const onTrace = vi.fn();
    const session = startMicStream({
      onPartial: vi.fn(),
      onTurnEnd: vi.fn(),
      onError: vi.fn(),
      onTrace,
    });
    sessions.push(session);
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];
    socket.open();

    const firstFrameEvents = () =>
      onTrace.mock.calls
        .map(([event]) => event.name)
        .filter((name) => name === "first_captured_audio_frame");

    worklet.emit(new Float32Array(1_600).fill(0.1));
    expect(firstFrameEvents()).toHaveLength(1);

    session.setFrameForwarding(false);
    worklet.emit(new Float32Array(1_600).fill(0.2));
    expect(firstFrameEvents()).toHaveLength(1);

    session.setFrameForwarding(true);
    worklet.emit(new Float32Array(1_600).fill(0.3));
    expect(firstFrameEvents()).toEqual([
      "first_captured_audio_frame",
      "first_captured_audio_frame",
    ]);
  });
});
