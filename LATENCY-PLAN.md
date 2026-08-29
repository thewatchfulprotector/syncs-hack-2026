# Alexandria Latency Plan

## Objective

Reduce the delay across the complete voice loop:

`mic click -> audio capture -> STT connection -> end-of-turn -> retrieval -> LLM -> TTS -> browser playback -> mic re-armed`

The main problems identified by the audit are:

1. The microphone and STT session are deliberately delayed, destroyed, and rebuilt on every turn.
2. Embedding latency has a large and unpredictable tail.
3. TTS is sentence-pipelined but not actually audio-streamed to playback.

Completed investigation, implementation, or validation is marked `- [x]`. Remaining work is marked `- [ ]`.

Implementation checkpoint (2026-08-29): the local release gates pass with 155 tests, clean lint and TypeScript, and a successful production build. Acceptance targets, production deployment, provider-quality decisions, and regional p50/p95 claims remain unchecked until they are measured live.

## Acceptance targets

- [ ] Measure first-time microphone permission separately from warm-turn latency.
- [ ] Achieve warm click-to-capture p95 at or below 150 ms.
- [ ] Achieve final-playback-to-capture-resumed p95 at or below 150 ms.
- [ ] Achieve end-of-speech-to-final-transcript p50 at or below 350 ms and p95 at or below 700 ms without material false cutoffs.
- [ ] Achieve final-transcript-to-first-audible-response p50 at or below 1.5 seconds.
- [ ] Achieve final-transcript-to-first-audible-response p95 at or below 3 seconds.
- [ ] Achieve embedding p95 at or below 800 ms from the production compute region.
- [ ] Achieve warm Pinecone query p95 at or below 150 ms.
- [ ] Stop AI audio within 100 ms of a manual barge-in.
- [ ] Do not lose words spoken immediately after capture is declared ready.
- [ ] Do not allow played AI speech to trigger a new AI turn.
- [ ] Preserve acceptable transcription, retrieval, persona, and voice quality at the new latency targets.

## Completed audit and baseline

### Repository and implementation

- [x] Mapped the browser microphone, AssemblyAI, retrieval, LLM, ElevenLabs, and playback path.
- [x] Confirmed that the production response route streams NDJSON incrementally rather than buffering the whole response.
- [x] Confirmed that OpenRouter LLM output is streamed correctly.
- [x] Confirmed that the current ElevenLabs implementation waits for a complete MP3 for each sentence.
- [x] Confirmed that browser playback waits for complete base64 conversion and `decodeAudioData()` before starting a sentence.
- [x] Confirmed that the client does not visibly render the streamed assistant tokens.
- [x] Confirmed that the microphone, media tracks, worklet, `AudioContext`, and AssemblyAI WebSocket are destroyed after every user turn.
- [x] Confirmed that conversation re-arming relies on a fixed 600 ms timer and an unstable `speaking` state.
- [x] Confirmed that barge-in is not currently supported.
- [x] Confirmed that the current server `firstAudioMs` is not a measurement of browser-audible playback.
- [x] Confirmed that `micStream` and `AudioQueue` have no stateful lifecycle tests.

### Measured production baseline from Sydney

- [x] Measured an exact 600 ms application delay before initial microphone setup and every re-arm.
- [x] Measured a code/network floor of approximately 1.58-2.01 seconds from click to the current `onReady`, excluding unusually slow permission or hardware setup.
- [x] Measured one clear-speech balanced-mode end-of-turn at approximately 356 ms after the audio ended.
- [x] Measured five final-turn request-to-first-audio-packet samples: 1.75 s, 2.42 s, 2.43 s, 3.95 s, and 9.70 s.
- [x] Calculated a 2.43-second median request-to-first-audio-packet from those five samples.
- [x] Measured embedding times of 238 ms, 365 ms, 515 ms, 2.263 s, and 7.909 s.
- [x] Measured Pinecone times of 53-170 ms during the same deployed requests.
- [x] Measured post-retrieval LLM first-token latency of approximately 309-703 ms.
- [x] Measured a further 433-1,055 ms from first LLM token to the first audio NDJSON packet.
- [x] Measured a 0.81-1.15-second gap between the current server `firstAudioMs` and receipt of that audio packet in Sydney.
- [x] Confirmed that actual audible playback is later still because browser base64 decoding, MP3 decoding, scheduling, and device output are not included.
- [x] Confirmed from `x-vercel-id` that traffic entered through `syd1` and the answer function executed in `iad1`.
- [x] Confirmed that the Pinecone index is in AWS `us-east-1`, making `iad1` a reasonable current starting region.

### Focused provider measurements

- [x] Measured a cold local Pinecone query at 1.97 s when targeting by name.
- [x] Measured the same cold local query at 1.01 s when targeting by explicit host.
- [x] Measured one direct DeepInfra embedding at 722 ms and one direct Nebius embedding at 1.764 s.
- [x] Recorded that a single pair is insufficient to permanently select a provider.
- [x] Measured ElevenLabs regular endpoint first byte at 531-659 ms in focused probes.
- [x] Measured ElevenLabs `/stream` first byte at 347-348 ms in focused probes.
- [x] Confirmed that the current AssemblyAI session resolves to `universal-3-5-pro` in `balanced` mode.
- [x] Measured one `min_latency` end-of-turn replay at 385 ms versus 356 ms in balanced mode for the same clear clip.
- [x] Recorded that `min_latency` did not improve that clear example, but should reduce the uncertain-turn fallback window and still needs representative evaluation.

### Existing validation status

- [x] Production build completed successfully.
- [x] All 72 existing tests passed across 10 test files.
- [x] Worktree was clean before creating this plan.
- [x] Lint was run and the three existing errors were recorded.
- [x] Fix or explicitly exclude the unrelated generated-design lint errors before using lint as a release gate.
- [x] Fix the latency-relevant unused client timer and effect warning in `src/app/page.tsx`.

## Current critical path

### Microphone startup

- [x] Identified the fixed 600 ms delay in `src/app/page.tsx` before `startListening()` runs.
- [x] Identified that buffered capture only starts after `getUserMedia`, `AudioContext`, and worklet setup.
- [x] Identified that anything spoken during the 600 ms delay or device setup is lost.
- [x] Identified that token minting overlaps microphone setup, but the WebSocket handshake begins only after both are ready.
- [x] Identified the current startup dependency as `max(token, microphone setup) -> WebSocket handshake`.
- [x] Identified the preferred dependency as `max(token -> WebSocket handshake, microphone setup)`.
- [x] Identified that `onReady` currently means WebSocket `open`, not first captured audio, AssemblyAI `Begin`, or confirmed upstream processing.
- [x] Identified that up to 15 seconds of audio can be buffered and then burst-flushed faster than real time.

### User-to-AI handover

- [x] Confirmed that the page calls `ask()` immediately after a qualifying final STT turn.
- [x] Confirmed that endpoint detection, rather than an extra client timer, owns the gap immediately before `ask()`.
- [x] Confirmed that the socket does not explicitly pin model, mode, or turn settings.
- [x] Confirmed that the application requires both `end_of_turn` and `turn_is_formatted` before submitting.
- [x] Confirmed that stable partial transcripts are used only for captions and not for speculative work.

### Retrieval and LLM

- [x] Confirmed that question embedding must complete before Pinecone begins.
- [x] Confirmed that the current 8B, 4096-dimension embedding model is the main measured tail source.
- [x] Confirmed that every single-query embedding launches both DeepInfra and Nebius.
- [x] Confirmed that the losing provider request is not cancelled.
- [x] Confirmed that each race leg also allows OpenRouter fallbacks.
- [x] Confirmed that client cancellation is not propagated through embedding or Pinecone.
- [x] Confirmed that Pinecone is targeted by name and can incur a cold control-plane lookup.
- [x] Confirmed that top-k defaults to eight substantial chunks.
- [x] Confirmed that the browser sends all prior turns even though the server eventually keeps only the last six.

### TTS and browser playback

- [x] Confirmed that TTS waits for a complete punctuated first sentence.
- [x] Confirmed that the regular ElevenLabs endpoint is used instead of `/stream` or the TTS WebSocket.
- [x] Confirmed that `arrayBuffer()` waits for the complete sentence MP3.
- [x] Confirmed that audio is base64-encoded inside JSON, adding transfer and copying overhead.
- [x] Confirmed that the browser fully decodes each MP3 before starting playback.
- [x] Confirmed that the playback `AudioContext` is created lazily after asynchronous network work rather than during the user gesture.
- [x] Confirmed that TTS sentences are serialized to preserve request stitching.
- [x] Confirmed that the response route waits for the entire TTS chain before sending `done` and closing.

### AI-to-user handover and interruption

- [x] Confirmed that microphone re-arm waits for both request completion and all scheduled playback to finish.
- [x] Confirmed that a second fixed 600 ms timer then runs.
- [x] Confirmed that the complete microphone/STT stack is rebuilt after that timer.
- [x] Confirmed that a click during thinking or speaking aborts playback and also disables conversation mode.
- [x] Confirmed that speaking over the AI is ignored because the microphone is not active.
- [x] Confirmed that the current exact-substring echo guard can both miss real echo and reject genuine repeated phrases.

## Phase 0: End-to-end observability

- [x] Generate one correlation ID for every user turn.
- [x] Propagate the correlation ID from the browser through `/api/ask` and all log events.
- [x] Record mic-click time.
- [x] Record microphone-permission start and resolution.
- [x] Record `AudioContext` creation, resume, and running state.
- [x] Record the first captured audio frame.
- [x] Record STT token request start and completion.
- [x] Record AssemblyAI WebSocket construction, `open`, and `Begin`.
- [x] Record first `SpeechStarted`, first partial, and final turn.
- [ ] Record end-of-speech-to-final-turn latency where the audio timestamp permits it.
- [x] Record `/api/ask` client request start and route entry.
- [ ] Record embedding start, winner, provider, completion, cancellation, and failure.
- [x] Record Pinecone start, completion, match count, and whether host resolution occurred.
- [ ] Record LLM request start, selected model/provider, first token, first sentence, and completion.
- [x] Record TTS connection/request start, response headers, first byte, completion, model, voice, and serving region.
- [x] Record first audio packet arrival in the browser.
- [ ] Record browser audio conversion/decode start and completion.
- [ ] Record the scheduled source start and the closest available approximation of actual output start.
- [x] Record final playback completion and microphone resume.
- [ ] Expose p50, p95, maximum, and failure rate by browser, device, network, provider, and deployment region.
- [ ] Keep first-use permission measurements separate from warm conversational turns.
- [x] Replace or rename the current misleading server `firstAudioMs` metric.
- [x] Add a debug trace view or downloadable structured trace for individual turns.

## Phase 1: Remove avoidable microphone startup delay

- [x] Remove the unconditional 600 ms delay from the initial mic click.
- [x] Call microphone startup directly from the user gesture.
- [ ] Create and resume a shared `AudioContext` from the user gesture.
- [x] Verify `AudioContext.state === "running"` before claiming capture readiness.
- [ ] Split microphone state into at least `requesting-permission`, `capturing`, `connecting`, and `ready`.
- [ ] Show “Listening” or an equivalent capture-safe state as soon as audio is actually being captured.
  - Current policy says “Preparing audio · connecting” until STT is open, because the intentionally bounded one-second preconnection buffer cannot safely promise lossless speech during a longer connection delay.
- [x] Treat transport connection as a secondary state rather than blocking the user-facing capture state.
- [x] Start the AssemblyAI WebSocket as soon as the token resolves, concurrently with microphone/worklet setup.
- [x] Avoid making WebSocket construction depend on `ctx.sampleRate` when the intended transport rate is already fixed at 16 kHz.
- [x] Prefetch one unused, single-use AssemblyAI token with an age-checked 300-600 second redemption window.
- [ ] Refresh an unused prefetched token before expiry.
- [x] Never reuse a token that has already opened a session.
- [x] Add explicit token request and WebSocket connection timeouts.
- [x] Add retry behavior that obtains a fresh token after an expired or failed connection.
- [x] Bound any pre-connection audio backlog to a much shorter interval.
- [x] Pace backlog frames in real time rather than synchronously burst-flushing them.
- [ ] Move PCM16 conversion and frame aggregation into the worklet if profiling shows meaningful main-thread cost.
- [ ] Evaluate 50 ms versus 100 ms capture frames after larger startup fixes are complete.

## Phase 2: Persistent conversation lifecycle and handover

- [x] Keep one `MediaStream` alive while conversation mode is enabled.
- [x] Keep one capture `AudioContext` and worklet alive while conversation mode is enabled.
- [x] Decide between one persistent AssemblyAI session and preconnecting the next session during TTS.
- [ ] Prefer the persistent-session design if its measured latency benefit justifies connected-session billing.
- [x] Pause or gate outgoing microphone frames while AI audio is playing.
- [x] Resume frame forwarding immediately after the final audio output drains.
- [x] Terminate input resources only when conversation mode is switched off, an unrecoverable error occurs, or an explicit idle timeout expires.
- [ ] Add an inactivity policy and document its AssemblyAI cost implications.
- [x] Replace the re-arm `setTimeout(600)` with an exact queue-drained event.
- [x] Add an explicit server `audio_complete` event so the client knows no more TTS packets are coming.
- [x] Make `AudioQueue` expose a reliable `queueDrained` promise or callback.
- [x] Ensure temporary gaps between sentence buffers do not report the entire answer as drained.
- [x] Add an epoch or abort guard after every asynchronous decode/resume operation in `AudioQueue`.
- [x] Handle empty finalized turns without leaving a dead session referenced as listening.
- [x] Recover cleanly after token expiry, WebSocket closure, or network transition.

## Phase 3: Barge-in and echo handling

- [x] Change a click during thinking or speaking to cancel the active answer while keeping conversation mode enabled.
- [x] Resume or retain capture immediately after a manual interruption.
- [ ] Stop queued and currently playing AI audio within 100 ms of manual interruption.
- [x] Abort the LLM and TTS upstream when the user interrupts.
- [x] Consume AssemblyAI `SpeechStarted` events.
- [ ] Add voice barge-in after manual barge-in is stable.
- [ ] Add a short confirmation/debounce window so coughs and backchannels do not cancel the AI unnecessarily.
- [x] Replace the unbounded exact-substring echo guard with playback-time-bounded matching.
- [x] Use fuzzy transcript similarity rather than requiring a perfect contiguous substring.
- [x] Record speech in the echo history only when it is actually scheduled or played, not merely received.
- [ ] Evaluate AssemblyAI voice focus and speaker labels as supporting signals, not as the sole echo solution.
- [ ] Test speakers, headphones, Bluetooth devices, and noisy-room conditions.

## Phase 4: Retrieval latency and tail control

- [ ] Add `PINECONE_HOST` to local and deployed environment configuration.
- [x] Construct the Pinecone index with the explicit data-plane host.
- [x] Retain index-name configuration only for administration or fallback diagnostics.
- [ ] Verify cold and warm Pinecone timings after direct-host targeting.
- [x] Remove the current page-load `/api/warmup` or redesign it inside the actual `/api/ask` function bundle.
- [x] Confirm that the replacement warmup does not create duplicate provider calls or overlap the user’s first turn.
- [x] Disable OpenRouter fallbacks inside each independent embedding race leg.
- [x] Add one `AbortController` per embedding provider request.
- [x] Abort the losing embedding request immediately after a winner is accepted.
- [x] Propagate the user/request abort signal into embedding requests.
- [ ] Propagate the user/request abort signal into Pinecone queries where supported.
- [ ] Benchmark embedding providers from `iad1` using enough samples to report p50, p95, error rate, and cost.
- [x] Test a delayed hedge rather than launching both providers immediately.
- [ ] Choose the primary provider and hedge delay from production-region data.
- [x] Record which provider actually served every embedding.
- [ ] Create a fixed retrieval-quality evaluation set of questions and expected chunks.
- [ ] Benchmark smaller and faster embedding models against that evaluation set.
- [ ] Compare recall, ranking, embedding latency, vector size, Pinecone latency, and cost.
- [ ] Reindex the corpus only if a smaller model passes the retrieval-quality threshold.
- [x] Add a conservative small-talk bypass for greetings, thanks, and other turns that clearly need no retrieval.
- [x] Ensure short factual questions can never be misclassified as small talk.
- [ ] Cache exact repeated query embeddings only if measurements show meaningful reuse.

## Phase 5: Speculative overlap from STT partials

- [ ] Capture AssemblyAI’s stable `utterance` or equivalent partial-turn field.
- [ ] Define when a partial transcript is stable enough to start speculative retrieval.
- [ ] Debounce speculative embedding so every partial does not trigger a provider call.
- [ ] Start embedding and retrieval while the user is still speaking on sufficiently stable turns.
- [ ] Cancel stale speculative work when the transcript materially changes.
- [ ] Compare the normalized final transcript with the speculative query before reusing results.
- [ ] Restart retrieval when final text differs beyond the accepted threshold.
- [ ] Buffer any speculative model output until the turn is genuinely finalized.
- [ ] Measure additional provider spend and discarded-work rate.
- [ ] Ship speculative retrieval only if latency improvement justifies cost and stale-context risk.

## Phase 6: True TTS and playback streaming

### Lower-risk intermediate implementation

- [x] Replace the regular ElevenLabs endpoint with `/stream` for complete sentences or safe clauses.
- [x] Forward audio bytes progressively instead of awaiting a complete `arrayBuffer()`.
- [ ] Select and test a lower-bandwidth voice-chat output format.
- [ ] Verify cloned-voice quality after reducing bitrate or sample rate.
- [ ] Avoid base64 where the transport can carry binary data.
- [x] If NDJSON must remain temporarily, chunk and decode audio incrementally rather than emitting one large base64 line.
- [x] Keep one playback `AudioContext` alive instead of closing and recreating it for every answer.
- [x] Unlock playback during the original user gesture to avoid autoplay suspension.

### Preferred streaming implementation

- [ ] Open an ElevenLabs TTS WebSocket for each answer or reuse a safe persistent/multi-context connection where supported.
- [ ] Open or prepare TTS concurrently with retrieval/LLM work when doing so is safe and cost-effective.
- [x] Feed safe LLM clauses or sentences to TTS as soon as they are available.
- [ ] Choose and tune `auto_mode` or a chunk schedule using measured quality and latency.
- [x] Guarantee that the trailing `SOURCES:` metadata can never reach TTS.
- [x] Proxy progressive PCM or another streamable format to the browser.
- [ ] Implement an `AudioWorklet` ring buffer for progressive playback.
- [ ] Apply backpressure and bounded buffering.
- [x] Flush server, transport, and browser audio buffers on interruption.
- [ ] Preserve acceptable prosody across generated clauses.
- [ ] Verify that audio begins before the first complete MP3 would previously have arrived.

### Text and protocol cleanup

- [ ] Render assistant text incrementally if token events continue to be sent.
- [ ] Otherwise batch or remove token frames that provide no user-visible value.
- [ ] Batch text updates every 20-40 ms to reduce JSON and render overhead.
- [ ] Send only the citation fields required before first audio; defer large tooltip text if necessary.
- [x] Send an explicit `generation_complete` event separately from `audio_complete`.
- [x] Keep answer-generation state independent from playback and microphone state.

## Phase 7: LLM, prompt, and answer-shape tuning

- [ ] Add LLM request, provider, model, and first-token telemetry before changing routing.
- [x] Retain the current fast streaming implementation unless measurements identify a regression.
- [x] Set a conversational output-token cap appropriate for voice answers.
- [x] Prompt for a short, direct opening sentence so TTS can begin earlier.
- [ ] Stop generation after the required `SOURCES:` line is complete.
- [x] Send only the last six globally capped history messages from the browser.
- [x] Cap total history characters or tokens before network transfer.
- [ ] Evaluate top-k 4, 6, and 8 against the retrieval-quality set.
- [ ] Add a similarity threshold or dynamic top-k if weak matches are common.
- [ ] Measure prompt prefill and first-token effects after reducing context.
- [ ] Keep model fallback behavior for reliability, but record when a fallback causes a latency outlier.
- [ ] Consider a timed LLM hedge only if first-token p95 remains a problem after retrieval and TTS fixes.

## Phase 8: AssemblyAI endpointing configuration

- [x] Pin `speech_model=universal-3-5-pro` explicitly so backend-default changes cannot alter behavior silently.
- [x] Pin or explicitly select the desired mode rather than relying on the current `balanced` default.
- [ ] Build an endpointing evaluation set from real short questions, long questions, hesitations, lists, numbers, and thinking pauses.
- [ ] Record false-cutoff rate and delayed-turn rate for balanced mode.
- [ ] Record the same metrics for `min_latency` mode.
- [ ] Test explicit silence settings only if the selected model/mode supports and benefits from them.
- [ ] Evaluate `interruption_delay=0` for earlier partials and barge-in.
- [ ] Do not select `min_latency` solely from the one clear-speech replay.
- [ ] Choose the lowest-latency configuration that stays within the accepted false-cutoff budget.
- [x] Continue using `end_of_turn` as the authoritative final-turn signal.
- [x] Reassess whether the extra `turn_is_formatted` condition is still needed for the pinned model.

## Phase 9: Deployment and regional validation

- [x] Confirmed that the current answer function executes in `iad1` near the `us-east-1` Pinecone index.
- [x] Confirmed that moving compute blindly to Sydney could reduce client ingress while increasing serial provider/data latency.
- [ ] Keep `iad1` as the initial optimization baseline.
- [ ] Confirm whether Vercel Fluid Compute is enabled for production.
- [ ] Record function cold-start, warm-start, and instance-reuse indicators where available.
- [ ] Benchmark the complete loop in `iad1` after lifecycle, retrieval, and TTS fixes.
- [ ] A/B test a Sydney or Asia deployment only after stage-level telemetry exists.
- [ ] Compare full end-to-end p50/p95 rather than only browser-to-function latency.
- [ ] Keep compute close to whichever serial data/provider calls remain dominant.
- [ ] Evaluate a long-lived Lightsail or other persistent backend only if Vercel cold starts or connection reuse remain material after fixes.
- [ ] If self-hosting Next.js behind nginx, explicitly disable response buffering for streamed routes.
- [ ] Test on the actual venue network and a constrained/mobile network profile.

## Phase 10: Tests and failure handling

- [x] Add unit tests for mic-session setup, cancellation, cleanup, and reconnection.
- [x] Add tests proving that the initial click does not wait 600 ms.
- [x] Add tests proving that playback completion re-arms capture without a fixed delay.
- [x] Add tests for token expiry and single-use behavior.
- [x] Add tests for connection timeout and fresh-token retry.
- [x] Add tests for bounded and paced audio backlog handling.
- [x] Add `AudioQueue` tests for ordered decode, queue drain, interruption, stale decode completion, and context reuse.
- [x] Add tests for empty finalized turns.
- [ ] Add tests for manual and voice barge-in.
- [x] Add tests for echo false positives and false negatives.
- [x] Add tests proving that `SOURCES:` metadata is never spoken.
- [ ] Add tests for progressive TTS chunks, backpressure, flush, and finalization.
- [x] Add tests proving that aborted turns cancel embedding, Pinecone where possible, LLM, TTS, and playback.
- [ ] Add integration tests with mocked AssemblyAI, OpenRouter, Pinecone, and ElevenLabs timing behavior.
- [ ] Add a deterministic end-to-end latency test harness with recorded audio.
- [x] Run the full test suite after every phase.
- [x] Keep `npm run build` green after every phase.
- [x] Make `npm run lint` a clean release gate after existing unrelated errors are resolved or excluded.

## Recommended implementation order

- [x] 1. Add correlated client/server timing for the entire turn.
- [x] 2. Remove the initial 600 ms delay and expose capture-ready separately from transport-ready.
- [x] 3. Parallelize WebSocket connection with microphone/worklet setup and prefetch an age-checked token.
- [x] 4. Keep microphone and audio resources alive across turns; replace timer-based re-arm with exact queue drain.
- [x] 5. Pin the Pinecone host and remove or merge the ineffective warmup.
- [ ] 6. Make embedding routing strict, cancellable, and production-benchmarked.
- [x] 7. Implement real TTS byte streaming and persistent progressive browser playback.
- [ ] 8. Add manual barge-in, then voice barge-in and stronger echo protection.
- [ ] 9. Benchmark smaller embedding models and reindex only after retrieval-quality validation.
- [ ] 10. Add speculative retrieval from stable partials if the remaining latency justifies its cost.
- [ ] 11. Tune AssemblyAI endpointing, prompt size, answer length, and model fallbacks from trace evidence.
- [ ] 12. Validate p50/p95 targets on production and venue-like networks.

## Go/no-go checklist

- [ ] All stage timings are captured with one correlated turn ID.
- [ ] Warm click-to-capture and AI-to-user handover meet their p95 targets.
- [ ] Final-transcript-to-first-audible-response meets its p50 and p95 targets.
- [ ] No first words are lost during normal startup or re-arm.
- [ ] Barge-in reliably stops generation and audio without disabling conversation mode.
- [ ] No self-response loops occur in speaker testing.
- [ ] Endpoint tuning does not exceed the accepted false-cutoff rate.
- [ ] Retrieval-quality evaluation passes after any embedding or top-k change.
- [ ] Persona and voice quality remain acceptable after clause streaming and output-format changes.
- [ ] Provider usage and cost remain within budget after hedging or speculative work.
- [x] Full tests, build, and lint gates pass.
- [ ] Production and venue-network traces meet the targets across multiple consecutive conversations.

## Verified reference guidance

- [x] AssemblyAI temporary streaming tokens are single-use and allow a 1-600 second redemption window: <https://www.assemblyai.com/docs/streaming/api-spec/generate-streaming-token>
- [x] AssemblyAI exposes voice-agent latency modes and endpointing guidance: <https://www.assemblyai.com/docs/voice-agents/best-practices>
- [x] ElevenLabs recommends streaming for complete text and WebSockets for live LLM text: <https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization>
- [x] ElevenLabs exposes a progressive TTS stream endpoint: <https://elevenlabs.io/docs/api-reference/text-to-speech/stream>
- [x] Pinecone recommends targeting production indexes by host rather than name: <https://docs.pinecone.io/guides/manage-data/target-an-index>
- [x] OpenRouter documents that provider order remains preferential unless fallbacks are disabled: <https://openrouter.ai/docs/guides/routing/provider-selection>
- [x] Vercel recommends placing functions near their serial data sources: <https://vercel.com/docs/functions>
- [x] Vercel documents function bundling behavior and the effect of differing route configurations: <https://vercel.com/docs/functions/configuring-functions/advanced-configuration>

## Scope decisions

- [x] Do not rewrite the application framework solely for latency.
- [x] Do not move the answer function to Sydney without a complete regional A/B measurement.
- [x] Do not choose an embedding provider from a single sample.
- [x] Do not reindex with a smaller embedding model until retrieval quality is measured.
- [x] Do not claim success from server `firstAudioMs`; acceptance is based on browser-audible timing.
- [x] Treat persistent connections, speculative work, and provider hedging as latency-versus-cost decisions that must be measured.
