import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioQueue } from "./audioQueue";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn(() => this.onended?.());

  finish(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  readonly destination = {} as AudioDestinationNode;
  readonly sources: FakeBufferSource[] = [];
  readonly decodeRequests: Deferred<AudioBuffer>[] = [];
  resumeResult: Promise<void> = Promise.resolve();

  readonly analyser = {
    fftSize: 0,
    connect: vi.fn(),
    getByteTimeDomainData: vi.fn(),
  };

  readonly createAnalyser = vi.fn(() => this.analyser as unknown as AnalyserNode);
  readonly createBuffer = vi.fn(
    (_numberOfChannels: number, length: number, sampleRate: number) =>
      ({
        duration: length / sampleRate,
        copyToChannel: vi.fn(),
      }) as unknown as AudioBuffer,
  );
  readonly createBufferSource = vi.fn(() => {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
  readonly decodeAudioData = vi.fn(() => {
    const request = new Deferred<AudioBuffer>();
    this.decodeRequests.push(request);
    return request.promise;
  });
  readonly resume = vi.fn(() => this.resumeResult);
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
}

type DrainableAudioQueue = AudioQueue & {
  /** Resolves only after the server has declared `audio_complete` and playback has ended. */
  readonly queueDrained: Promise<void>;
  /** Called when the `audio_complete` protocol event arrives. */
  markInputComplete(): void;
};

const decodedBuffer = (duration: number) => ({ duration }) as AudioBuffer;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function installAudioContext(context: FakeAudioContext): void {
  function AudioContextFactory() {
    return context;
  }
  vi.stubGlobal("AudioContext", AudioContextFactory);
}

describe("AudioQueue lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("atob", (value: string) => Buffer.from(value, "base64").toString("binary"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not schedule decoded audio after stop invalidates the old queue epoch", async () => {
    const context = new FakeAudioContext();
    installAudioContext(context);
    const speakingChanges: boolean[] = [];
    const sentenceStart = vi.fn();
    const queue = new AudioQueue((speaking) => speakingChanges.push(speaking), sentenceStart);

    const scheduled = queue.enqueue("AQ==", "stale sentence");
    await flushMicrotasks();
    expect(context.decodeRequests).toHaveLength(1);

    queue.stop();
    context.decodeRequests[0].resolve(decodedBuffer(0.25));
    await scheduled;

    expect(context.createBufferSource).not.toHaveBeenCalled();
    expect(speakingChanges).not.toContain(true);
    expect(sentenceStart).not.toHaveBeenCalled();
  });

  it("does not begin decoding after stop while an AudioContext resume is pending", async () => {
    const context = new FakeAudioContext();
    context.state = "suspended";
    const resumed = new Deferred<void>();
    context.resumeResult = resumed.promise;
    context.decodeAudioData.mockResolvedValue(decodedBuffer(0.25));
    installAudioContext(context);
    const queue = new AudioQueue();

    const scheduled = queue.enqueue("AQ==");
    await flushMicrotasks();
    expect(context.resume).toHaveBeenCalledOnce();

    queue.stop();
    resumed.resolve(undefined);
    await scheduled;

    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(context.createBufferSource).not.toHaveBeenCalled();
  });

  it("stops the currently playing source synchronously on manual interruption", async () => {
    const context = new FakeAudioContext();
    context.decodeAudioData.mockResolvedValue(decodedBuffer(1));
    installAudioContext(context);
    const queue = new AudioQueue();

    await queue.enqueue("AQ==", "playing sentence");
    expect(context.sources).toHaveLength(1);

    queue.stop();

    expect(context.sources[0].stop).toHaveBeenCalledOnce();
  });

  it("does not report a temporary sentence gap as drained before audio_complete", async () => {
    const context = new FakeAudioContext();
    context.decodeAudioData.mockResolvedValue(decodedBuffer(0.25));
    installAudioContext(context);
    const queue = new AudioQueue() as DrainableAudioQueue;

    expect(queue.queueDrained).toBeInstanceOf(Promise);
    let drained = false;
    void queue.queueDrained.then(() => {
      drained = true;
    });

    await queue.enqueue("AQ==", "first sentence");
    context.sources[0].finish();
    await flushMicrotasks();
    expect(drained).toBe(false);

    await queue.enqueue("Ag==", "second sentence after a transport gap");
    queue.markInputComplete();
    await flushMicrotasks();
    expect(drained).toBe(false);

    context.sources[1].finish();
    await expect(queue.queueDrained).resolves.toBeUndefined();
  });

  it("drains an explicitly completed answer that contains no audio", async () => {
    const context = new FakeAudioContext();
    installAudioContext(context);
    const queue = new AudioQueue() as DrainableAudioQueue;

    expect(queue.queueDrained).toBeInstanceOf(Promise);
    queue.markInputComplete();

    await expect(queue.queueDrained).resolves.toBeUndefined();
  });

  it("recovers the scheduling tail after decode failure and drains later encoded audio", async () => {
    const context = new FakeAudioContext();
    context.decodeAudioData
      .mockRejectedValueOnce(new Error("decode failed"))
      .mockResolvedValueOnce(decodedBuffer(0.25));
    installAudioContext(context);
    const queue = new AudioQueue() as DrainableAudioQueue;
    queue.beginAnswer();
    const drained = queue.queueDrained;

    await expect(queue.enqueue("AQ==", "bad packet")).rejects.toThrow("decode failed");
    await expect(queue.enqueue("Ag==", "recoverable packet")).resolves.toBeUndefined();

    expect(context.sources).toHaveLength(1);
    queue.markInputComplete();
    context.sources[0].finish();
    await expect(drained).resolves.toBeUndefined();
  });

  it("recovers the scheduling tail after resume failure and drains a later packet", async () => {
    const context = new FakeAudioContext();
    context.state = "suspended";
    context.resume
      .mockRejectedValueOnce(new Error("resume failed"))
      .mockResolvedValueOnce(undefined);
    context.decodeAudioData.mockResolvedValue(decodedBuffer(0.25));
    installAudioContext(context);
    const queue = new AudioQueue() as DrainableAudioQueue;
    queue.beginAnswer();
    const drained = queue.queueDrained;

    await expect(queue.enqueue("AQ==", "first packet")).rejects.toThrow("resume failed");
    await expect(queue.enqueue("Ag==", "second packet")).resolves.toBeUndefined();

    expect(context.sources).toHaveLength(1);
    queue.markInputComplete();
    context.sources[0].finish();
    await expect(drained).resolves.toBeUndefined();
  });
});
