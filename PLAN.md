# Alexandira

Description: Humanity is always built off the previous generation. There's a funny joke our team has about how we've gone from trees to wifi, yet we don't actually know all the progressive steps to go from one to the other. More learn Python instead of C and fewer learn assembly because we build on greater levels of abstraction. But a lot of knowledge isn't captured. Steve Jobs once told this story about how Alexander the Great's tutor was Aristotle! Steve was said how infuriating that was to hear because the closest he could get to having a conversation with Aristotle is through the texts he produced. But what if he could have an approximate conversation with Aristotle, or Elon or anyone with enough data captured of them? A system that is could ingest information, maybe that be through video, transcripts, searching, texts, whatever. Take that information and somehow index it in a sense where we're able to actually emulate people through their knowledge base. This could involve RAG, a fast model maybe like Gemma 4 or Gemini 3.7, speech-to-text and text-to-speech clone of the person's voice. And if we have pictures of them or videos of them, we could have some sort of technology where we can almost communicate with them and they're moving, like those AI American job interviews, where you have an AI person interviewing you, and you see them moving, blinking, and all that sort of stuff. So something like that. The whole point is for two reasons: to capture people's knowledge, but also to just clone people. Because you might want to capture Elon Musk in time or Spiros "Kaye" Kyriakou, so that humanity has access to their approximate knowledge. But also because someone would never lose their grandmother again fully. They would be able to see them, index their family tree, their lineage, and if we open source the technology, other people can build their own versions to improve it, make it specific, and help other people share this experience and do it for themselves as AI continues to get better, lowering the barrier to entry for code modifications. The library of Alexandria would never burn down again, it would be democratised for everyone to use. Our idea for Syncs Hack 2026 is the modern day Alexandria.

For our 24-hour build, we've mapped out the following:
1. Ingest videos, audio, and documents.
2. Transcribe and divide them into chunks.
3. Store chunks and metadata in Pinecone.
4. Retrieve the best/suitable passages.
5. Give those passages to Gemini 3.7 Flash (or Gemma 4, GPT-OSS with Cerebras or Groq) with a strong specific persona prompt.
6. Return the answer with citations, then speak it using ElevenLabs.

For production readiness, we'll need to consider highly reliable storage, file metadata for storage + better RAG indexing.

File flow for ingestion: video -> audio --transcribe-> text -> metadata -> index


## Our stack

Frontend : Next.js + TypeScript + Tailwind on Vercel
Backend: FastAPI on AWS Lightsail
STT: AssemblyAI Universal-3.5 Pro
Voice cloning: ElevenLabs Instant Voice Cloning
TTS: Eleven Flash v2.5
Vector retrieval: Pinecone Starter
Embeddings: OpenRouter
Reranking: OpenRouter
Primary LLM: OpenRouter
Deployment: Vercel + AWS Lightsail VM
