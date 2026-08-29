import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioQueue } from "./audioQueue";

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn(() => this.onended?.());
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 1.25;
  readonly destination = {} as AudioDestinationNode;
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
  readonly createBufferSource = vi.fn(
    () => new FakeBufferSource() as unknown as AudioBufferSourceNode,
  );
  readonly decodeAudioData = vi.fn();
  readonly resume = vi.fn(async () => {});
  readonly close = vi.fn(async () => {});
}

type ObservableAudioQueueConstructor = new (
  onSpeakingChange?: (speaking: boolean) => void,
  onSentenceStart?: (text: string, durationSec: number) => void,
  onFirstPcmSourceScheduled?: () => void,
) => AudioQueue;

describe("AudioQueue scheduling observability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports the first scheduled PCM source once for each answer", async () => {
    const context = new FakeAudioContext();
    vi.stubGlobal("AudioContext", function AudioContextFactory() {
      return context;
    });
    const onFirstPcmSourceScheduled = vi.fn();
    const ObservableAudioQueue = AudioQueue as unknown as ObservableAudioQueueConstructor;
    const queue = new ObservableAudioQueue(
      undefined,
      undefined,
      onFirstPcmSourceScheduled,
    );

    queue.beginAnswer();
    await queue.enqueuePcm16(Uint8Array.from([0, 0]), "First.", 24_000);
    await queue.enqueuePcm16(Uint8Array.from([1, 0]), "", 24_000);

    expect(onFirstPcmSourceScheduled).toHaveBeenCalledOnce();

    queue.beginAnswer();
    await queue.enqueuePcm16(Uint8Array.from([2, 0]), "Second.", 24_000);

    expect(onFirstPcmSourceScheduled).toHaveBeenCalledTimes(2);
  });
});
