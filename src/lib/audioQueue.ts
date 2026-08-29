/**
 * Gapless browser playback queue: feed it base64 mp3 sentences in order and it
 * schedules each buffer back-to-back on the Web Audio timeline. Decoding is
 * serialized internally so out-of-order decode completion can't reorder audio.
 */
export class AudioQueue {
  private ctx: AudioContext | undefined;
  private chain: Promise<void> = Promise.resolve();
  private nextStartTime = 0;
  private activeSources = 0;
  private onSpeakingChange?: (speaking: boolean) => void;

  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange;
  }

  /** Queue one sentence. Returns a promise that resolves when it is scheduled. */
  enqueue(mp3Base64: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      const ctx = this.context();
      if (ctx.state === "suspended") await ctx.resume();

      const bytes = Uint8Array.from(atob(mp3Base64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const at = Math.max(ctx.currentTime, this.nextStartTime);
      this.nextStartTime = at + buffer.duration;

      if (this.activeSources === 0) this.onSpeakingChange?.(true);
      this.activeSources++;
      source.onended = () => {
        this.activeSources--;
        if (this.activeSources === 0) this.onSpeakingChange?.(false);
      };
      source.start(at);
    });
    return this.chain;
  }

  /** Cut playback immediately and reset for the next answer. */
  stop(): void {
    this.ctx?.close();
    this.ctx = undefined;
    this.chain = Promise.resolve();
    this.nextStartTime = 0;
    if (this.activeSources > 0) this.onSpeakingChange?.(false);
    this.activeSources = 0;
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.nextStartTime = 0;
    }
    return this.ctx;
  }
}
