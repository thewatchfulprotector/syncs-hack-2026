// Phase 1 smoke tests — one real call per service.
// Run: node --env-file=.env.local scripts/smoke.mjs [openrouter|elevenlabs|assemblyai|embedding|pinecone|all]
import { writeFileSync } from "node:fs";
import { Pinecone } from "@pinecone-database/pinecone";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const LLM_MODEL = "openai/gpt-oss-120b";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}

async function openrouter() {
  const { value, ms } = await timed(async () => {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${need("OPENROUTER_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        provider: { order: ["cerebras", "groq"], allow_fallbacks: true },
        messages: [{ role: "user", content: "Reply with exactly: hello from alexandria" }],
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  });
  const reply = value.choices[0].message.content.trim();
  return `model=${value.model} provider=${value.provider} ${ms}ms reply="${reply}"`;
}

async function elevenlabs() {
  // Falls back to a premade voice (Rachel) until we have our own clone's voice ID.
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  const { value: bytes, ms } = await timed(async () => {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": need("ELEVENLABS_API_KEY"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "Hello from Alexandria. The library never burns down again.",
          model_id: "eleven_flash_v2_5",
        }),
      },
    );
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  });
  const out = "scripts/smoke-tts.mp3";
  writeFileSync(out, bytes);
  return `voice=${voiceId} ${ms}ms ${bytes.length} bytes -> ${out}`;
}

async function assemblyai() {
  const headers = {
    Authorization: need("ASSEMBLYAI_API_KEY"),
    "Content-Type": "application/json",
  };
  const { value, ms } = await timed(async () => {
    const create = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers,
      body: JSON.stringify({
        audio_url: "https://assembly.ai/wildfires.mp3",
        speaker_labels: true,
      }),
    });
    if (!create.ok) throw new Error(`${create.status} ${await create.text()}`);
    const { id } = await create.json();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers });
      const body = await poll.json();
      if (body.status === "completed") return body;
      if (body.status === "error") throw new Error(body.error);
    }
    throw new Error("transcription timed out after 180s");
  });
  const speakers = new Set((value.utterances ?? []).map((u) => u.speaker));
  return `${ms}ms speakers={${[...speakers]}} text="${value.text.slice(0, 80)}..."`;
}

async function embedQuery(text) {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${need("OPENROUTER_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.data[0].embedding;
}

async function embedding() {
  const { value: vector, ms } = await timed(() =>
    embedQuery("The library of Alexandria would never burn down again."),
  );
  return `model=${EMBEDDING_MODEL} dimension=${vector.length} ${ms}ms`;
}

async function pinecone() {
  const pc = new Pinecone({ apiKey: need("PINECONE_API_KEY") });
  const indexName = need("PINECONE_INDEX");

  const vector = await embedQuery("Aristotle tutored Alexander the Great.");

  const existing = (await pc.listIndexes()).indexes ?? [];
  if (!existing.some((i) => i.name === indexName)) {
    await pc.createIndex({
      name: indexName,
      dimension: vector.length,
      metric: "cosine",
      spec: { serverless: { cloud: "aws", region: "us-east-1" } },
      waitUntilReady: true,
    });
  }

  const index = pc.index(indexName);
  await index.upsert({
    records: [
      {
        id: "smoke-test-1",
        values: vector,
        metadata: { persona_id: "smoke", text: "Aristotle tutored Alexander the Great." },
      },
    ],
  });

  // Serverless indexes are eventually consistent — retry briefly until the upsert is visible.
  const { value: match, ms } = await timed(async () => {
    for (let i = 0; i < 20; i++) {
      const res = await index.query({
        vector,
        topK: 1,
        filter: { persona_id: "smoke" },
        includeMetadata: true,
      });
      if (res.matches?.length) return res.matches[0];
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("upserted vector never became queryable");
  });
  return `index=${indexName} dim=${vector.length} query ${ms}ms score=${match.score.toFixed(4)} text="${match.metadata.text}"`;
}

const checks = { openrouter, elevenlabs, assemblyai, embedding, pinecone };
const requested = process.argv.slice(2).filter((a) => a !== "all");
const toRun = requested.length ? requested : Object.keys(checks);

let failed = false;
for (const name of toRun) {
  if (!checks[name]) {
    console.error(`unknown check: ${name} (valid: ${Object.keys(checks).join(", ")})`);
    process.exit(1);
  }
  try {
    console.log(`PASS ${name}: ${await checks[name]()}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
