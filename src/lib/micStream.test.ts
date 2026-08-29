import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMicStream, type MicSession } from "./micStream";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeTrack {
  readonly stop = vi.fn();
}

class FakeMediaStream {
  readonly track = new FakeTrack();
  readonly getTracks = vi.fn(() => [this.track] as unknown as MediaStreamTrack[]);
}

class FakeCaptureContext {
  state: AudioContextState = "running";
  sampleRate = 16000;
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
  readonly createMediaStreamSource = vi.fn(() => this.source as unknown as MediaStreamAudioSourceNode);
  readonly createAnalyser = vi.fn(() => this.analyser as unknown as AnalyserNode);
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
}

type PersistentMicSession = MicSession & {
  /** Gates network forwarding without tearing down the capture graph. Gated frames are dropped. */
  setFrameForwarding(enabled: boolean): void;
};

type MicCallbacks = Parameters<typeof startMicStream>[0] & {
  /** Capture graph is running, even if the STT transport is still connecting. */
  onCaptureReady?: () => void;
};

const sessions: MicSession[] = [];

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function installBrowserHarness(options?: {
  media?: Promise<MediaStream>;
  token?: Promise<string>;
  context?: FakeCaptureContext;
}) {
  const context = options?.context ?? new FakeCaptureContext();
  const media = new FakeMediaStream();
  const getUserMedia = vi.fn(() => options?.media ?? Promise.resolve(media as unknown as MediaStream));
  const token = options?.token ?? Promise.resolve("single-use-token");
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ token: await token }),
  }));

  function AudioContextFactory() {
    return context;
  }

  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("AudioContext", AudioContextFactory);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:pcm-capture"),
    revokeObjectURL: vi.fn(),
  });

  return { context, media, getUserMedia, fetchMock };
}

function start(callbacks?: Partial<MicCallbacks>): MicSession {
  const session = startMicStream({
    onPartial: vi.fn(),
    onTurnEnd: vi.fn(),
    onError: vi.fn(),
    ...callbacks,
  });
  sessions.push(session);
  return session;
}

describe("persistent microphone and STT lifecycle", () => {
  beforeEach(() => {
    FakeAudioWorkletNode.instances = [];
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("constructs the fixed-rate STT websocket as soon as its token resolves", async () => {
    const permission = new Deferred<MediaStream>();
    installBrowserHarness({ media: permission.promise, token: Promise.resolve("early-token") });

    start();
    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("sample_rate=16000");
  });

  it("reports capture readiness while the STT token is still pending", async () => {
    const token = new Deferred<string>();
    const { context } = installBrowserHarness({ token: token.promise });
    const onCaptureReady = vi.fn();

    start({ onCaptureReady });
    await flushMicrotasks();

    expect(context.state).toBe("running");
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);
    expect(onCaptureReady).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("delivers multiple finalized turns without destroying the capture session", async () => {
    const { context, media } = installBrowserHarness();
    const onTurnEnd = vi.fn();
    start({ onTurnEnd });
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.message({
      type: "Turn",
      transcript: "first question",
      end_of_turn: true,
      turn_is_formatted: true,
    });
    socket.message({
      type: "Turn",
      transcript: "second question",
      end_of_turn: true,
      turn_is_formatted: true,
    });

    expect(onTurnEnd).toHaveBeenNthCalledWith(1, "first question");
    expect(onTurnEnd).toHaveBeenNthCalledWith(2, "second question");
    expect(media.track.stop).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("exposes SpeechStarted without manufacturing a finalized turn", async () => {
    installBrowserHarness();
    const onSpeechStarted = vi.fn();
    const onTurnEnd = vi.fn();
    start({ onSpeechStarted, onTurnEnd });
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.message({ type: "SpeechStarted", timestamp: 1_240 });

    expect(onSpeechStarted).toHaveBeenCalledOnce();
    expect(onSpeechStarted).toHaveBeenCalledWith(1_240);
    expect(onTurnEnd).not.toHaveBeenCalled();
  });

  it("keeps an empty finalized turn from leaving a dead session referenced as listening", async () => {
    const { context, media } = installBrowserHarness();
    const onTurnEnd = vi.fn();
    start({ onTurnEnd });
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.message({
      type: "Turn",
      transcript: "   ",
      end_of_turn: true,
      turn_is_formatted: true,
    });
    socket.message({
      type: "Turn",
      transcript: "question after silence",
      end_of_turn: true,
      turn_is_formatted: true,
    });

    expect(onTurnEnd).toHaveBeenCalledOnce();
    expect(onTurnEnd).toHaveBeenCalledWith("question after silence");
    expect(media.track.stop).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("drops frames while forwarding is gated and resumes on the same live capture graph", async () => {
    const { context, media } = installBrowserHarness();
    const session = start() as PersistentMicSession;
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];
    socket.open();
    socket.send.mockClear();

    expect(typeof session.setFrameForwarding).toBe("function");
    session.setFrameForwarding(false);
    worklet.emit(new Float32Array(1600).fill(0.2));
    expect(socket.send).not.toHaveBeenCalled();
    expect(media.track.stop).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();

    session.setFrameForwarding(true);
    worklet.emit(new Float32Array(1600).fill(0.3));

    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
  });
});
