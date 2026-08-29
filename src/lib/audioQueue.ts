/**
 * Gapless browser playback queue: feed it base64 mp3 sentences in order and it
 * schedules each buffer back-to-back on the Web Audio timeline. Decoding is
 * serialized internally so out-of-order decode completion can't reorder audio.
 * Playback routes through an analyser so the orb can move with the voice, and
 * each sentence's text is announced as its audio actually starts playing.
 */
export class AudioQueue {
  private ctx: AudioContext | undefined;
  private analyser: AnalyserNode | undefined;
  private timeBuf: Uint8Array<ArrayBuffer> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private nextStartTime = 0;
  private activeSources = 0;
  private sentenceTimers: ReturnType<typeof setTimeout>[] = [];
  private onSpeakingChange?: (speaking: boolean) => void;
  private onSentenceStart?: (text: string, durationSec: number) => void;

  constructor(
    onSpeakingChange?: (speaking: boolean) => void,
    onSentenceStart?: (text: string, durationSec: number) => void,
  ) {
    this.onSpeakingChange = onSpeakingChange;
    this.onSentenceStart = onSentenceStart;
  }

  /** Queue one sentence. Returns a promise that resolves when it is scheduled. */
  enqueue(mp3Base64: string, text = ""): Promise<void> {
    this.chain = this.chain.then(async () => {
      const ctx = this.context();
      if (ctx.state === "suspended") await ctx.resume();

      const bytes = Uint8Array.from(atob(mp3Base64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser!);

      const at = Math.max(ctx.currentTime, this.nextStartTime);
      this.nextStartTime = at + buffer.duration;

      if (this.activeSources === 0) this.onSpeakingChange?.(true);
      this.activeSources++;
      source.onended = () => {
        this.activeSources--;
        if (this.activeSources === 0) this.onSpeakingChange?.(false);
      };
      if (this.onSentenceStart && text) {
        this.sentenceTimers.push(
          setTimeout(
            () => this.onSentenceStart?.(text, buffer.duration),
            Math.max(0, (at - ctx.currentTime) * 1000),
          ),
        );
      }
      source.start(at);
    });
    return this.chain;
  }

  /** Playback output level 0..1 for the visualizer, or null when silent/closed. */
  amplitude(): number | null {
    if (!this.analyser) return null;
    this.timeBuf ??= new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(this.timeBuf);
    let sum = 0;
    for (const v of this.timeBuf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / this.timeBuf.length);
    return Math.min(1, Math.pow(Math.min(1, rms * 4.5), 0.7));
  }

  /** Cut playback immediately and reset for the next answer. */
  stop(): void {
    for (const timer of this.sentenceTimers) clearTimeout(timer);
    this.sentenceTimers = [];
    this.ctx?.close();
    this.ctx = undefined;
    this.analyser = undefined;
    this.timeBuf = undefined;
    this.chain = Promise.resolve();
    this.nextStartTime = 0;
    if (this.activeSources > 0) this.onSpeakingChange?.(false);
    this.activeSources = 0;
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
