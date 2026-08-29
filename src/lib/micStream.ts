/**
 * Browser mic -> AssemblyAI v3 realtime streaming STT.
 *
 * Capture starts the moment the mic is live: frames produced before the
 * websocket finishes connecting are buffered (bounded) and flushed on open,
 * so the first words of a question are never lost. The token fetch runs
 * concurrently with mic permission + audio-graph setup to shorten that window.
 *
 * Returns synchronously so the caller can show a "connecting" state at once
 * and cancel at any phase; onReady fires when audio is actually flowing.
 */
export type MicSession = { stop(): void };

const FRAMES_PER_SECOND = 10; // ~100ms of audio per websocket frame
const MAX_BACKLOG_FRAMES = 150; // ~15s buffered while the socket connects

const WORKLET_SOURCE = `
registerProcessor("pcm-capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
});`;

export function startMicStream(options: {
  onPartial: (text: string) => void;
  onTurnEnd: (text: string) => void;
  /** The websocket is open and any buffered audio has been flushed. */
  onReady?: () => void;
  onError?: (err: unknown) => void;
}): MicSession {
  let stopped = false;
  let media: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let ws: WebSocket | undefined;

  // safe to run at any setup phase and more than once: releases whatever
  // exists so far and detaches handlers so no callback fires after stop
  const cleanup = () => {
    if (worklet) worklet.port.onmessage = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
      ws.close();
    }
    media?.getTracks().forEach((track) => track.stop());
    ctx?.close().catch(() => {});
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
  };

  const fail = (err: unknown) => {
    if (stopped) return;
    stop();
    options.onError?.(err);
  };

  (async () => {
    // runs concurrently with the mic permission prompt and audio-graph setup
    const tokenPromise = fetch("/api/stt-token", { method: "POST" }).then(async (res) => {
      if (!res.ok) throw new Error(`stt-token: ${res.status}`);
      return (await res.json()).token as string;
    });

    media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    if (stopped) return cleanup(); // cancelled before the mic resolved

    ctx = new AudioContext({ sampleRate: 16000 });
    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    await ctx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    if (stopped) return cleanup();

    // capture begins here — frames queue in the backlog until the socket opens
    const backlog: ArrayBuffer[] = [];
    let pending: number[] = [];
    const frameSize = ctx.sampleRate / FRAMES_PER_SECOND;
    const source = ctx.createMediaStreamSource(media);
    worklet = new AudioWorkletNode(ctx, "pcm-capture");
    source.connect(worklet);
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const sample of event.data) {
        pending.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
      }
      if (pending.length < frameSize) return;
      const frame = new Int16Array(pending).buffer;
      pending = [];
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(frame);
      } else {
        backlog.push(frame);
        if (backlog.length > MAX_BACKLOG_FRAMES) backlog.shift();
      }
    };

    const token = await tokenPromise;
    if (stopped) return cleanup();

    const socket = new WebSocket(
      `wss://streaming.assemblyai.com/v3/ws?sample_rate=${ctx.sampleRate}&format_turns=true&token=${token}`,
    );
    ws = socket;
    socket.onopen = () => {
      if (stopped) return;
      for (const frame of backlog) socket.send(frame);
      backlog.length = 0;
      options.onReady?.();
    };
    socket.onmessage = (event) => {
      if (stopped) return;
      const msg = JSON.parse(event.data);
      if (msg.type !== "Turn") return;
      if (msg.end_of_turn && msg.turn_is_formatted) {
        // terminating the session flushes one last formatted turn — deliver at
        // most one end-of-turn per session so a question can't submit twice
        const text = msg.transcript?.trim();
        stop();
        if (text) options.onTurnEnd(text);
      } else if (msg.transcript) {
        options.onPartial(msg.transcript);
      }
    };
    socket.onerror = (event) => fail(event);
    // a close we didn't initiate (token expiry, network drop) would otherwise
    // leave the caller stuck showing "listening"
    socket.onclose = () => fail(new Error("speech connection closed"));
  })().catch(fail);

  return { stop };
}
