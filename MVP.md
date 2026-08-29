# Alexandria

Description: Humanity is always built off the previous generation. There's a funny joke our team has about how we've gone from trees to wifi, yet we don't actually know all the progressive steps to go from one to the other. More learn Python instead of C and fewer learn assembly because we build on greater levels of abstraction. But a lot of knowledge isn't captured. Steve Jobs once told this story about how Alexander the Great's tutor was Aristotle! Steve was said how infuriating that was to hear because the closest he could get to having a conversation with Aristotle is through the texts he produced. But what if he could have an approximate conversation with Aristotle, or Elon or anyone with enough data captured of them? A system that could ingest information — video, transcripts, texts, whatever — index it, and emulate people through their knowledge base. The whole point is twofold: to capture people's knowledge for humanity, and so someone would never fully lose their grandmother again. If we open source the technology, other people can build their own versions and share this experience as AI keeps lowering the barrier to entry. The library of Alexandria would never burn down again — democratised for everyone. Our idea for Syncs Hack 2026 is the modern day Alexandria.

## MVP (the 24-hour build)

**One sentence:** upload media about one person → ask them a question in the browser → hear them answer in their own voice, grounded in their own words, within ~3 seconds.

One persona, one conversation loop, done well. The demo is won on streaming latency and the persona *sounding* like the person — spend the hours there.

### The loop

1. **Ingest (script, run before the demo).** File flow: `video → audio → (transcribe) → text → metadata → index`:
   - **video → audio:** ffmpeg extracts a mono 16kHz track. Keep the original file path for citations, and clip the cleanest solo-speech segments now — they double as the voice-clone sample.
   - **audio → text:** AssemblyAI async transcription with speaker diarization and word timestamps. Keep only the persona's own speech — interviews are half interviewer, and without this filter the clone absorbs the interviewer. Plain documents/transcripts enter the flow here.
   - **text → metadata:** chunk ~300–500 tokens with overlap; each chunk carries `{persona_id, source_file, media_type, timestamp_range, speaker, text}` so citation chips can link to the exact moment in the source.
   - **metadata → index:** embed each chunk with `voyage-4-lite` → store chunks + embeddings + metadata in one JSON file. No vector DB: at demo scale, in-memory cosine similarity over a few thousand vectors is instant.
2. **Ask:** text box → embed query → top-k (k≈8) from the in-memory index → prompt = persona instructions + 3–5 verbatim quotes as style examples + retrieved chunks → `gpt-oss-120b` via OpenRouter (Groq/Cerebras provider for speed) → stream tokens.
3. **Speak:** ElevenLabs Instant Voice Clone (made from the same source audio) + Eleven Flash v2.5. Stream LLM output sentence-by-sentence into TTS so audio starts before the full answer exists. **This streaming chain is the heart of the MVP.**
4. **UI:** one page. Photo of the persona (subtle pulse while speaking), text input, answer streaming as text while the voice plays, citation chips below linking to sources. Citations are visual, never spoken — spoken answers stay natural.

### Definition of done

Ask a question whose answer exists in the source material → their voice starts answering within ~3 seconds, in their phrasing → the citation chip links to the right source.

## Stack (existing accounts + one AssemblyAI signup)

- **App:** single Next.js + TypeScript + Tailwind app on Vercel; API routes orchestrate retrieval → LLM → TTS. No separate backend service.
- **STT:** AssemblyAI for both modes — **async** (Universal) with speaker diarization + word timestamps for ingestion, **Streaming** (realtime) for voice input. One vendor, one SDK, both paths. (Needs an AssemblyAI account — the one signup on the list; grab the key in H0–2.)
- **Voice cloning:** ElevenLabs Instant Voice Cloning
- **TTS:** Eleven Flash v2.5 (streaming)
- **LLM:** OpenRouter `gpt-oss-120b` (Groq/Cerebras), fallback `google/gemini-3.7-flash`
- **Embeddings:** OpenRouter `voyageai/voyage-4-lite`. The Voyage-4 family (nano/lite/standard/large) shares one embedding space, so if retrieval quality disappoints we can re-embed documents with `voyage-4-large` while keeping fast `lite` query embeddings — no migration. Verify in H0–2 that our OpenRouter key serves Voyage embeddings; fallback is a direct Voyage AI key (two-minute signup, free tier covers the hack many times over).
- **Reranking (optional, off by default):** `voyageai/rerank-2.5` — the full model, not lite: near-leaderboard accuracy (behind only Zerank-2, which is non-commercial, and Cohere Rerank 4 Pro, which needs another account) at ~2× lower latency (~600ms). Wire it in only if retrieval visibly pulls wrong chunks; that 600ms comes straight out of the 3-second first-audio budget.
- **Vector search:** in-memory cosine similarity over a JSON chunk store (no Pinecone for the hack)
- **Lightsail (already provisioned):** backup only — use it if Vercel function timeouts or streaming limits bite, or to run long transcription jobs. Don't build on it unless forced; every extra service is glue hours.

## Build checklist (24h)

> **Workflow: test-driven development.** Every pure-logic module is built test-first with Vitest: write the failing test, make it pass, move on. That covers the chunker, the diarization filter, cosine similarity/top-k, prompt assembly, the sentence splitter, and citation mapping. Don't TDD the UI or live third-party calls — instead, capture one real API response per service as a fixture and test your parsing/filtering against it, so the suite runs fast and offline. Keep `npm test` green all night; it's what lets you refactor fearlessly at hour 20.

### Phase 1 · Setup
- [x] Vercel account
- [x] OpenRouter key
- [x] ElevenLabs account
- [x] Lightsail provisioned
- [x] AssemblyAI key
- [ ] Scaffold Next.js + TypeScript + Tailwind, with Vitest wired in and `npm test` running
- [ ] Deploy hello-world to Vercel
- [ ] All API keys in env (local `.env.local` + Vercel project settings)
- [ ] Smoke-test each service: OpenRouter LLM call, ElevenLabs TTS call, AssemblyAI transcription call
- [ ] Verify OpenRouter serves `voyage-4-lite` embeddings (fallback: direct Voyage AI key)

### Phase 2 · Ingestion script (local CLI)
- [ ] Test-first: chunker (~300–500 tokens, overlap)
- [ ] Test-first: diarization filter (keep only persona's speech) against a saved real AssemblyAI response fixture
- [ ] ffmpeg: video → mono 16kHz audio
- [ ] Clip cleanest solo-speech segments (doubles as the voice-clone sample)
- [ ] AssemblyAI async transcription with diarization + word timestamps
- [ ] Chunk metadata schema: `{persona_id, source_file, media_type, timestamp_range, speaker, text}`
- [ ] Embed chunks with `voyage-4-lite`, write JSON index

### Phase 3 · Retrieval + answer (terminal, hardcoded persona 1)
- [ ] Test-first: cosine similarity + top-k over the JSON index
- [ ] Test-first: prompt assembly (persona instructions + 3–5 verbatim quotes + retrieved chunks)
- [ ] Query embedding → retrieve k≈8
- [ ] `gpt-oss-120b` via OpenRouter (Cerebras provider)
- [ ] End-to-end answer with citations in the terminal

### Phase 4 · Streaming pipeline (the hard part — protect this phase)
- [ ] Test-first: sentence splitter over a token stream
- [ ] API route streams LLM tokens
- [ ] Sentence-by-sentence Eleven Flash v2.5 streaming TTS
- [ ] Browser audio playback queue (gapless between sentences)
- [ ] Measure first-audio latency; target < 3s

### Phase 5 · UI (one page)
- [ ] Photo, text input, answer streaming as text while voice plays
- [ ] Subtle speaking pulse on the photo
- [ ] Citation chips linking to source + timestamp
- [ ] Error states: API failure, empty retrieval

### Phase 6 · Voice
- [ ] ElevenLabs Instant Voice Clone from the clipped segments
- [ ] Wire the voice ID in; check it actually sounds like them

### Phase 7 · Persona quality
- [ ] Fully ingest the real demo persona (night before the demo)
- [ ] Tune persona prompt with verbatim quotes until it sounds like them
- [ ] Spot-check ~10 questions with known answers; citations land on the right sources

### Phase 8 · Hardening
- [ ] Latency tuning
- [ ] Production deploy, test on venue wifi
- [ ] Full test suite green

### Phase 9 · Stretch + pitch
- [ ] Voice input (AssemblyAI Streaming realtime STT)
- [ ] Second persona + one short live-ingest clip for the demo
- [ ] Avatar (only if everything else is done)
- [ ] Record a backup demo video
- [ ] Pitch deck + rehearsal; deepfake/consent answer ready

## Stretch goals (in priority order)

1. **Voice input** — browser mic → AssemblyAI Streaming STT (realtime websocket, partial transcripts as you speak) → same loop.
2. **Second persona** + a tiny live-ingest moment in the demo (one short clip, never a long video on stage).
3. **Animated avatar** — only if everything else is done; a static photo with a speaking pulse gets 80% of the presence for 2% of the effort.

## Explicitly out of scope for the hack

Deliberate cuts read as maturity: live long-video ingestion, multi-persona management UI, accounts/auth, family-tree indexing, Pinecone/Supabase/S3, FastAPI backend, reranking (add `voyageai/rerank-2.5` only if retrieval visibly disappoints).

## Production readiness (the slide, not the build)

Durable storage (S3), real vector DB (Pinecone), relational metadata (Supabase Postgres), dedicated backend (FastAPI on Lightsail), reranking, auth + per-user personas, consent/verification workflow for voice capture.
