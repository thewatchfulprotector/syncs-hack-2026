import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioQueue } from "./audioQueue";

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

class FakePcmBuffer {
  readonly duration: number;
  readonly channel: Float32Array;
  readonly getChannelData = vi.fn(() => this.channel);
  readonly copyToChannel = vi.fn((source: Float32Array) => this.channel.set(source));

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.channel = new Float32Array(length);
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 2.5;
  readonly destination = {} as AudioDestinationNode;
  readonly sources: FakeBufferSource[] = [];
  readonly buffers: FakePcmBuffer[] = [];
  readonly analyser = {
    fftSize: 0,
    connect: vi.fn(),
    getByteTimeDomainData: vi.fn(),
  };

  readonly createAnalyser = vi.fn(() => this.analyser as unknown as AnalyserNode);
  readonly createBuffer = vi.fn(
    (numberOfChannels: number, length: number, sampleRate: number) => {
      const buffer = new FakePcmBuffer(numberOfChannels, length, sampleRate);
      this.buffers.push(buffer);
      return buffer as unknown as AudioBuffer;
    },
  );
  readonly createBufferSource = vi.fn(() => {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
  readonly decodeAudioData = vi.fn(async () => {
    throw new Error("raw PCM must not use decodeAudioData");
  });
  readonly resume = vi.fn(async () => {});
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
}

type ProgressivePcmQueue = AudioQueue & {
  /** Schedule one raw mono signed-16-bit little-endian PCM transport chunk. */
  enqueuePcm16(bytes: Uint8Array, text?: string, sampleRate?: number): Promise<void>;
};

function installAudioContext(context: FakeAudioContext): void {
  function AudioContextFactory() {
    return context;
  }
  vi.stubGlobal("AudioContext", AudioContextFactory);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AudioQueue progressive PCM playback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("schedules the first PCM16 little-endian chunk without decodeAudioData or input completion", async () => {
    const context = new FakeAudioContext();
    installAudioContext(context);
    const queue = new AudioQueue() as ProgressivePcmQueue;
    const firstChunk = Uint8Array.from([
      0x00,
      0x80, // -32768
      0x00,
      0x00, // 0
      0xff,
      0x7f, // 32767
    ]);

    await queue.enqueuePcm16(firstChunk, "First sentence.", 24_000);

    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(context.createBuffer).toHaveBeenCalledWith(1, 3, 24_000);
    expect([...context.buffers[0].channel]).toEqual([
      -1,
      0,
      expect.closeTo(32_767 / 32_768, 6),
    ]);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].start).toHaveBeenCalledWith(2.5);
  });

  it("reports each sentence's actual scheduled audio duration, not a word estimate", async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    installAudioContext(context);
    const onSentenceStart = vi.fn();
    const queue = new AudioQueue(undefined, onSentenceStart) as ProgressivePcmQueue;
    queue.beginAnswer();
    const silence = (seconds: number) => new Uint8Array(Math.round(seconds * 24_000) * 2);

    // first sentence: 0.5s + 2s + 1.5s of audio arrives before playback starts
    await queue.enqueuePcm16(silence(0.5), "one two three four five six seven eight nine ten", 24_000);
    await queue.enqueuePcm16(silence(2), "", 24_000);
    await queue.enqueuePcm16(silence(1.5), "", 24_000);
    // second sentence must not inherit the first sentence's audio
    await queue.enqueuePcm16(silence(0.5), "Then a second one.", 24_000);
    await queue.enqueuePcm16(silence(1.5), "", 24_000);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    expect(onSentenceStart).toHaveBeenCalledTimes(2);
    expect(onSentenceStart.mock.calls[0][0]).toBe(
      "one two three four five six seven eight nine ten",
    );
    expect(onSentenceStart.mock.calls[0][1]).toBeCloseTo(4, 5);
    expect(onSentenceStart.mock.calls[1][0]).toBe("Then a second one.");
    expect(onSentenceStart.mock.calls[1][1]).toBeCloseTo(2, 5);
  });

  it("resolves queueDrained only after exact audio_complete and the final PCM source end", async () => {
    const context = new FakeAudioContext();
    installAudioContext(context);
    const queue = new AudioQueue() as ProgressivePcmQueue;
    queue.beginAnswer();
    const drained = queue.queueDrained;
    let didDrain = false;
    void drained.then(() => {
      didDrain = true;
    });

    await queue.enqueuePcm16(Uint8Array.from([0x00, 0x00]), "First.", 24_000);
    await queue.enqueuePcm16(Uint8Array.from([0x01, 0x00]), "", 24_000);
    context.sources[0].finish();
    await flushMicrotasks();
    expect(didDrain, "a transport gap is not answer completion").toBe(false);

    queue.markInputComplete();
    await flushMicrotasks();
    expect(didDrain, "audio_complete cannot bypass an active final source").toBe(false);

    context.sources[1].finish();
    await expect(drained).resolves.toBeUndefined();
  });

  it("recovers after createBuffer failure and drains a later PCM packet", async () => {
    const context = new FakeAudioContext();
    context.createBuffer.mockImplementationOnce(() => {
      throw new Error("createBuffer failed");
    });
    installAudioContext(context);
    const queue = new AudioQueue() as ProgressivePcmQueue;
    queue.beginAnswer();
    const drained = queue.queueDrained;

    await expect(
      queue.enqueuePcm16(Uint8Array.from([0x00, 0x00]), "bad packet", 24_000),
    ).rejects.toThrow("createBuffer failed");
    await expect(
      queue.enqueuePcm16(Uint8Array.from([0x01, 0x00]), "recovered packet", 24_000),
    ).resolves.toBeUndefined();

    expect(context.sources).toHaveLength(1);
    queue.markInputComplete();
    context.sources[0].finish();
    await expect(drained).resolves.toBeUndefined();
  });
});
