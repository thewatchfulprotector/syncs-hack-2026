/**
 * Persistent browser microphone -> AssemblyAI v3 realtime streaming STT.
 *
 * Permission/capture setup and token/WebSocket setup are independent branches.
 * Capture readiness is therefore reported as soon as the audio graph is
 * running, while early PCM is kept in a short, real-time-paced backlog.
 */
export type MicSession = {
  stop(): void;
  /** Gate outbound frames without tearing down capture or the STT session. */
  setFrameForwarding(enabled: boolean): void;
  /** Live input level 0..1 for the visualizer, or null before capture starts. */
  amplitude(): number | null;
};

export type MicTraceEvent = {
  name: string;
  at: number;
  detail?: Record<string, unknown>;
};

const SAMPLE_RATE = 16_000;
const FRAME_DURATION_MS = 100;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;
const BACKLOG_PACE_MS = FRAME_DURATION_MS / 2;
const MAX_BACKLOG_FRAMES = 10;
const TOKEN_TTL_SECONDS = 300;
const TOKEN_MAX_AGE_MS = (TOKEN_TTL_SECONDS - 60) * 1000;
const TOKEN_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 5_000;

type TokenLease = { token: string; issuedAt: number; expiresAt: number };
type MicTraceSink = (name: string, detail?: Record<string, unknown>) => void;
let prefetchedToken: Promise<TokenLease> | undefined;

const WORKLET_SOURCE = `
registerProcessor("pcm-capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
});`;

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function requestToken(
  signal?: AbortSignal,
  correlationId?: string,
  onTrace?: MicTraceSink,
): Promise<TokenLease> {
  onTrace?.("stt_token_request_start");
  try {
    const headers = correlationId ? { "X-Correlation-Id": correlationId } : undefined;
    const res = await fetch("/api/stt-token", {
      method: "POST",
      headers,
      signal: timeoutSignal(TOKEN_TIMEOUT_MS, signal),
    });
    if (!res.ok) throw new Error(`stt-token: ${res.status}`);
    const body = (await res.json()) as {
      token?: unknown;
      issuedAt?: unknown;
      expiresAt?: unknown;
    };
    if (typeof body.token !== "string" || !body.token) {
      throw new Error("stt-token: missing token");
    }
    const issuedAt = typeof body.issuedAt === "number" ? body.issuedAt : Date.now();
    const expiresAt =
      typeof body.expiresAt === "number"
        ? body.expiresAt
        : issuedAt + TOKEN_TTL_SECONDS * 1000;
    onTrace?.("stt_token_request_complete", {
      expiresInMs: Math.max(0, expiresAt - Date.now()),
    });
    return { token: body.token, issuedAt, expiresAt };
  } catch (error) {
    onTrace?.("stt_token_request_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Warm one unused, single-use token. Calling this repeatedly never reuses it. */
export function prefetchSttToken(): void {
  if (prefetchedToken) return;
  const pending = requestToken();
  prefetchedToken = pending;
  pending.catch(() => {
    if (prefetchedToken === pending) prefetchedToken = undefined;
  });
}

async function consumeToken(
  signal?: AbortSignal,
  correlationId?: string,
  onTrace?: MicTraceSink,
): Promise<string> {
  const cached = prefetchedToken;
  prefetchedToken = undefined;
  if (cached) {
    try {
      const lease = await cached;
      if (
        Date.now() - lease.issuedAt <= TOKEN_MAX_AGE_MS &&
        lease.expiresAt - Date.now() > 60_000
      ) {
        onTrace?.("stt_token_prefetch_used", { ageMs: Date.now() - lease.issuedAt });
        return lease.token;
      }
    } catch {
      // A failed prefetch must not poison the user-initiated connection.
    }
  }
  return (await requestToken(signal, correlationId, onTrace)).token;
}

export function startMicStream(options: {
  onPartial: (text: string) => void;
  onTurnEnd: (text: string) => void;
  /** Capture graph is running, independently of the STT connection. */
  onCaptureReady?: () => void;
  /** STT WebSocket is open and can accept audio. */
  onReady?: () => void;
  onSpeechStarted?: (timestamp?: number) => void;
  onError?: (err: unknown) => void;
  onTrace?: (event: MicTraceEvent) => void;
  correlationId?: string;
  getCorrelationId?: () => string | undefined;
}): MicSession {
  let stopped = false;
  let forwarding = true;
  let media: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let ws: WebSocket | undefined;
  let analyser: AnalyserNode | undefined;
  let timeBuf: Uint8Array<ArrayBuffer> | undefined;
  let pending: number[] = [];
  let resampleInput: number[] = [];
  let resamplePosition = 0;
  const backlog: ArrayBuffer[] = [];
  let backlogTimer: ReturnType<typeof setTimeout> | undefined;
  let socketTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnects = 0;
  let firstPartialRecorded = false;
  let firstAudioFrameRecorded = false;
  const lifetime = new AbortController();

  const trace = (name: string, detail?: Record<string, unknown>) => {
    options.onTrace?.({ name, at: performance.now(), detail });
  };

  const clearSocketTimers = () => {
    if (backlogTimer) clearTimeout(backlogTimer);
    if (socketTimer) clearTimeout(socketTimer);
    backlogTimer = undefined;
    socketTimer = undefined;
  };

  const detachSocket = (socket: WebSocket) => {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  };

  const cleanup = () => {
    clearSocketTimers();
    if (worklet) worklet.port.onmessage = null;
    if (ws) {
      const socket = ws;
      detachSocket(socket);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "Terminate" }));
      }
      socket.close();
    }
    media?.getTracks().forEach((track) => track.stop());
    void ctx?.close();
    backlog.length = 0;
    pending = [];
    resampleInput = [];
    resamplePosition = 0;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    cleanup();
  };

  const fail = (err: unknown) => {
    if (stopped) return;
    stop();
    options.onError?.(err);
  };

  const sendBacklogFrame = () => {
    backlogTimer = undefined;
    if (
      stopped ||
      !forwarding ||
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      backlog.length === 0
    ) {
      return;
    }
    ws.send(backlog.shift()!);
    if (backlog.length > 0) {
      // Catch up at a bounded 2x rate. This removes preconnection lag while
      // still pacing audio instead of burst-flushing the whole backlog.
      backlogTimer = setTimeout(sendBacklogFrame, BACKLOG_PACE_MS);
    }
  };

  const queueFrame = (frame: ArrayBuffer) => {
    if (!forwarding) return;
    if (ws?.readyState === WebSocket.OPEN && backlog.length === 0 && !backlogTimer) {
      ws.send(frame);
      return;
    }
    backlog.push(frame);
    if (backlog.length > MAX_BACKLOG_FRAMES) backlog.shift();
    if (ws?.readyState === WebSocket.OPEN && !backlogTimer) sendBacklogFrame();
  };

  const setFrameForwarding = (enabled: boolean) => {
    const wasForwarding = forwarding;
    forwarding = enabled;
    if (enabled && !wasForwarding) firstAudioFrameRecorded = false;
    trace(enabled ? "mic_forwarding_resumed" : "mic_forwarding_paused");
    if (!enabled) {
      if (backlogTimer) clearTimeout(backlogTimer);
      backlogTimer = undefined;
      backlog.length = 0;
      pending = [];
      resampleInput = [];
      resamplePosition = 0;
    }
  };

  const installSocketHandlers = (socket: WebSocket) => {
    // AssemblyAI turn_order values are scoped to one WebSocket session.
    const finalizedTurns = new Set<number>();
    socket.onopen = () => {
      if (stopped || socket !== ws) return;
      if (socketTimer) clearTimeout(socketTimer);
      socketTimer = undefined;
      trace("stt_websocket_open");
      if (backlog.length > 0 && !backlogTimer) sendBacklogFrame();
      options.onReady?.();
    };
    socket.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      const msg = JSON.parse(event.data);
      if (msg.type === "Begin") {
        trace("stt_begin", { sessionId: msg.id });
        return;
      }
      if (msg.type === "SpeechStarted") {
        trace("stt_speech_started", { timestamp: msg.timestamp });
        options.onSpeechStarted?.(msg.timestamp);
        return;
      }
      if (msg.type !== "Turn") return;
      const text = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
      if (msg.end_of_turn) {
        const order = typeof msg.turn_order === "number" ? msg.turn_order : undefined;
        if (order !== undefined && finalizedTurns.has(order)) return;
        if (order !== undefined) finalizedTurns.add(order);
        trace("stt_final_turn", { turnOrder: order, hasText: Boolean(text) });
        firstPartialRecorded = false;
        if (text) options.onTurnEnd(text);
      } else if (text) {
        if (!firstPartialRecorded) {
          firstPartialRecorded = true;
          trace("stt_first_partial");
        }
        trace("stt_partial");
        options.onPartial(text);
      }
    };
    socket.onerror = (event) => {
      if (socket === ws) void recoverSocket(event);
    };
    socket.onclose = () => {
      if (socket === ws) void recoverSocket(new Error("speech connection closed"));
    };
  };

  const connect = async (fresh = false): Promise<void> => {
    const correlationId = options.getCorrelationId?.() ?? options.correlationId;
    const token = fresh
      ? (await requestToken(lifetime.signal, correlationId, trace)).token
      : await consumeToken(lifetime.signal, correlationId, trace);
    if (stopped) return;
    const params = new URLSearchParams({
      sample_rate: String(SAMPLE_RATE),
      speech_model: "universal-3-5-pro",
      mode: "balanced",
      format_turns: "true",
      token,
    });
    trace("stt_websocket_constructed", { retry: reconnects });
    const socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
    ws = socket;
    installSocketHandlers(socket);
    socketTimer = setTimeout(() => {
      if (socket !== ws || socket.readyState === WebSocket.OPEN) return;
      detachSocket(socket);
      socket.close();
      void recoverSocket(new Error("speech connection timed out"));
    }, SOCKET_TIMEOUT_MS);
  };

  async function recoverSocket(cause: unknown): Promise<void> {
    if (stopped) return;
    const old = ws;
    if (old) {
      detachSocket(old);
      old.close();
    }
    ws = undefined;
    clearSocketTimers();
    if (reconnects >= 1) {
      fail(cause);
      return;
    }
    reconnects++;
    trace("stt_reconnecting");
    try {
      await connect(true);
    } catch (err) {
      fail(err);
    }
  }

  // Begin transport setup immediately; it never waits for mic permission.
  void connect().catch(fail);

  // Begin permission and capture setup independently of token minting.
  void (async () => {
    // Construct and begin resuming inside startMicStream's user-gesture call
    // stack. Permission resolution must not push the autoplay unlock later.
    trace("capture_context_create");
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const captureContext = ctx;
    const resume =
      captureContext.state === "suspended"
        ? (trace("capture_context_resume_start"), captureContext.resume())
        : Promise.resolve();
    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    const loadWorklet = captureContext.audioWorklet
      .addModule(workletUrl)
      .finally(() => URL.revokeObjectURL(workletUrl));

    trace("microphone_permission_start");
    const permission = navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      })
      .then((captured) => {
        trace("microphone_permission_resolved");
        media = captured;
        if (stopped) {
          captured.getTracks().forEach((track) => track.stop());
          media = undefined;
        }
        return captured;
      });
    const [capturedMedia] = await Promise.all([permission, resume, loadWorklet]);
    if (stopped) return cleanup();
    media = capturedMedia;

    if (captureContext.state !== "running") {
      throw new Error(`capture AudioContext is ${captureContext.state}`);
    }
    trace("capture_context_running", {
      sampleRate: captureContext.sampleRate,
      state: captureContext.state,
    });

    const source = captureContext.createMediaStreamSource(capturedMedia);
    worklet = new AudioWorkletNode(captureContext, "pcm-capture");
    source.connect(worklet);
    analyser = captureContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!firstAudioFrameRecorded) {
        firstAudioFrameRecorded = true;
        trace("first_captured_audio_frame", {
          sourceSampleRate: captureContext.sampleRate,
          samples: event.data.length,
        });
      }
      if (!forwarding) return;
      const sourceRate = captureContext.sampleRate;
      const appendPcm16 = (sample: number) => {
        pending.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
      };
      if (sourceRate === SAMPLE_RATE) {
        for (const sample of event.data) appendPcm16(sample);
      } else {
        const ratio = sourceRate / SAMPLE_RATE;
        resampleInput.push(...event.data);
        while (resamplePosition + 1 < resampleInput.length) {
          const index = Math.floor(resamplePosition);
          const fraction = resamplePosition - index;
          appendPcm16(
            resampleInput[index] +
              (resampleInput[index + 1] - resampleInput[index]) * fraction,
          );
          resamplePosition += ratio;
        }
        // Retain one source sample so interpolation stays continuous across
        // AudioWorklet quantum boundaries.
        const consumed = Math.min(
          Math.floor(resamplePosition),
          Math.max(0, resampleInput.length - 1),
        );
        if (consumed > 0) {
          resampleInput.splice(0, consumed);
          resamplePosition -= consumed;
        }
      }
      while (pending.length >= FRAME_SIZE) {
        const pcm = pending.splice(0, FRAME_SIZE);
        queueFrame(Int16Array.from(pcm).buffer);
      }
    };
    trace("first_capture_ready", { contextState: captureContext.state });
    options.onCaptureReady?.();
  })().catch(fail);

  const amplitude = () => {
    if (stopped || !analyser) return null;
    timeBuf ??= new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(timeBuf);
    let sum = 0;
    for (const value of timeBuf) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / timeBuf.length);
    return Math.min(1, Math.pow(Math.min(1, rms * 5.5), 0.75));
  };

  return { stop, setFrameForwarding, amplitude };
}
