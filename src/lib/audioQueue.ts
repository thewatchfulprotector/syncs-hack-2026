/**
 * Gapless browser playback queue for complete encoded sentences.
 *
 * Server audio packets may arrive with gaps, so silence is not synonymous
 * with answer completion. `queueDrained` resolves only after the server sends
 * `audio_complete` (mapped to `markInputComplete`) and every scheduled source
 * has ended. An epoch guard prevents late resume/decode continuations from
 * resurrecting audio after a manual interruption.
 */
export class AudioQueue {
  private ctx: AudioContext | undefined;
  private analyser: AnalyserNode | undefined;
  private timeBuf: Uint8Array<ArrayBuffer> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private nextStartTime = 0;
  private epoch = 0;
  private pendingTasks = 0;
  private inputComplete = false;
  private speaking = false;
  private pcmRemainder: number | undefined;
  private pcmPendingText = "";
  private pcmSentenceProgress: { scheduledSec: number } | undefined;
  private activeSources = new Set<AudioBufferSourceNode>();
  private sentenceTimers = new Set<ReturnType<typeof setTimeout>>();
  private resolveDrained: (() => void) | undefined;
  private onSpeakingChange?: (speaking: boolean) => void;
  private onSentenceStart?: (text: string, durationSec: number) => void;
  private onFirstPcmSourceScheduled?: () => void;
  private firstPcmSourceScheduled = false;

  /** Replaced by `beginAnswer`; capture it after beginning the current turn. */
  queueDrained: Promise<void>;

  constructor(
    onSpeakingChange?: (speaking: boolean) => void,
    onSentenceStart?: (text: string, durationSec: number) => void,
    onFirstPcmSourceScheduled?: () => void,
  ) {
    this.onSpeakingChange = onSpeakingChange;
    this.onSentenceStart = onSentenceStart;
    this.onFirstPcmSourceScheduled = onFirstPcmSourceScheduled;
    this.queueDrained = this.newDrainPromise();
  }

  /** Unlock the persistent playback context from a real user gesture. */
  async unlock(): Promise<void> {
    const epoch = this.epoch;
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
    if (epoch !== this.epoch) return;
    if (ctx.state !== "running") throw new Error(`playback AudioContext is ${ctx.state}`);
  }

  /** Reset completion state for a new answer while retaining the AudioContext. */
  beginAnswer(): void {
    this.cancelCurrentWork();
    this.firstPcmSourceScheduled = false;
    this.inputComplete = false;
    this.queueDrained = this.newDrainPromise();
  }

  /** Queue one base64-encoded sentence. Resolves once it has been scheduled. */
  enqueue(mp3Base64: string, text = ""): Promise<void> {
    const bytes = Uint8Array.from(atob(mp3Base64), (char) => char.charCodeAt(0));
    return this.enqueueBytes(bytes, text);
  }

  /** Queue already-decoded transport bytes without a base64 round-trip. */
  enqueueBytes(bytes: Uint8Array, text = ""): Promise<void> {
    const epoch = this.epoch;
    const encoded = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    this.pendingTasks++;

    const task = this.chain.then(async () => {
      const ctx = this.context();
      if (ctx.state === "suspended") await ctx.resume();
      if (epoch !== this.epoch) return;

      const buffer = await ctx.decodeAudioData(encoded);
      if (epoch !== this.epoch) return;

      this.scheduleBuffer(ctx, buffer, text, epoch);
    });

    const result = task.finally(() => {
      if (epoch !== this.epoch) return;
      this.pendingTasks--;
      this.maybeResolveDrained();
    });
    // A bad packet is reported to its caller but must not poison scheduling
    // for every packet that follows it.
    this.chain = result.catch(() => {});
    return result;
  }

  /** Schedule one progressive mono signed-16-bit little-endian PCM packet. */
  enqueuePcm16(bytes: Uint8Array, text = "", sampleRate = 24_000): Promise<void> {
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
      return Promise.reject(new Error(`unsupported PCM sample rate: ${sampleRate}`));
    }

    let packet = bytes;
    if (this.pcmRemainder !== undefined) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.pcmRemainder;
      joined.set(bytes, 1);
      packet = joined;
      this.pcmRemainder = undefined;
    }
    if (packet.byteLength % 2 === 1) {
      this.pcmRemainder = packet[packet.byteLength - 1];
      packet = packet.subarray(0, packet.byteLength - 1);
    }
    if (text) this.pcmPendingText = text;
    if (packet.byteLength === 0) return this.chain;

    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const samples = new Float32Array(packet.byteLength / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32_768;
    }

    const epoch = this.epoch;
    const sentenceText = this.pcmPendingText;
    this.pcmPendingText = "";
    this.pendingTasks++;
    const task = this.chain.then(async () => {
      const ctx = this.context();
      if (ctx.state === "suspended") await ctx.resume();
      if (epoch !== this.epoch) return;

      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      if (epoch !== this.epoch) return;
      // A sentence's packets keep arriving while earlier audio plays, so its
      // real duration is read when its caption starts, not when packet 0 is
      // scheduled. The word-rate floor only covers audio still in flight.
      if (sentenceText) this.pcmSentenceProgress = { scheduledSec: 0 };
      const progress = this.pcmSentenceProgress;
      if (progress) progress.scheduledSec += buffer.duration;
      const wordFloorSec = sentenceText
        ? sentenceText.trim().split(/\s+/).length / 3.2
        : 0;
      this.scheduleBuffer(
        ctx,
        buffer,
        sentenceText,
        epoch,
        progress ? () => Math.max(progress.scheduledSec, wordFloorSec) : buffer.duration,
        true,
      );
    });

    const result = task.finally(() => {
      if (epoch !== this.epoch) return;
      this.pendingTasks--;
      this.maybeResolveDrained();
    });
    this.chain = result.catch(() => {});
    return result;
  }

  /** Map the server's exact `audio_complete` event onto playback completion. */
  markInputComplete(): void {
    this.inputComplete = true;
    void this.chain.then(() => this.maybeResolveDrained());
    this.maybeResolveDrained();
  }

  /** Playback output level 0..1 for the visualizer, or null when silent. */
  amplitude(): number | null {
    if (!this.analyser) return null;
    this.timeBuf ??= new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(this.timeBuf);
    let sum = 0;
    for (const value of this.timeBuf) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / this.timeBuf.length);
    return Math.min(1, Math.pow(Math.min(1, rms * 4.5), 0.7));
  }

  /** Cut playback immediately but retain the unlocked context for the next turn. */
  stop(): void {
    this.cancelCurrentWork();
    this.inputComplete = true;
    this.resolveDrained?.();
    this.resolveDrained = undefined;
  }

  /** Release the persistent context when the whole conversation is disabled. */
  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = undefined;
    this.analyser = undefined;
    this.timeBuf = undefined;
  }

  private cancelCurrentWork(): void {
    this.epoch++;
    for (const timer of this.sentenceTimers) clearTimeout(timer);
    this.sentenceTimers.clear();
    for (const source of [...this.activeSources]) {
      try {
        source.stop();
      } catch {
        // A source that ended between iteration and stop is already harmless.
      }
    }
    this.activeSources.clear();
    this.chain = Promise.resolve();
    this.pendingTasks = 0;
    this.nextStartTime = 0;
    this.pcmRemainder = undefined;
    this.pcmPendingText = "";
    this.pcmSentenceProgress = undefined;
    this.setSpeaking(false);
  }

  private scheduleBuffer(
    ctx: AudioContext,
    buffer: AudioBuffer,
    text: string,
    epoch: number,
    captionDuration: number | (() => number) = buffer.duration,
    progressivePcm = false,
  ): void {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);

    const at = Math.max(ctx.currentTime, this.nextStartTime);
    this.nextStartTime = at + buffer.duration;
    this.activeSources.add(source);
    this.setSpeaking(true);

    let ended = false;
    source.onended = () => {
      if (ended) return;
      ended = true;
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) this.setSpeaking(false);
      this.maybeResolveDrained();
    };

    if (this.onSentenceStart && text) {
      const timer = setTimeout(
        () => {
          this.sentenceTimers.delete(timer);
          if (epoch !== this.epoch) return;
          const duration =
            typeof captionDuration === "function" ? captionDuration() : captionDuration;
          this.onSentenceStart?.(text, duration);
        },
        Math.max(0, (at - ctx.currentTime) * 1000),
      );
      this.sentenceTimers.add(timer);
    }
    source.start(at);
    if (progressivePcm && !this.firstPcmSourceScheduled) {
      this.firstPcmSourceScheduled = true;
      this.onFirstPcmSourceScheduled?.();
    }
  }

  private maybeResolveDrained(): void {
    if (!this.inputComplete || this.pendingTasks > 0 || this.activeSources.size > 0) return;
    this.resolveDrained?.();
    this.resolveDrained = undefined;
  }

  private newDrainPromise(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveDrained = resolve;
    });
  }

  private setSpeaking(value: boolean): void {
    if (this.speaking === value) return;
    this.speaking = value;
    this.onSpeakingChange?.(value);
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
      this.nextStartTime = 0;
    }
    return this.ctx;
  }
}
