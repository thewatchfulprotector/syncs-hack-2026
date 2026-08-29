import type { Persona } from "./personas";
import type { RetrievedChunk } from "./retrieval";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_STYLE_QUOTES = 5;
const MAX_HISTORY_MESSAGES = 6;

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

function excerptLabel(chunk: RetrievedChunk, n: number): string {
  const { source_file, start_ms } = chunk.metadata;
  const at = start_ms !== undefined ? ` @ ${formatTimestamp(start_ms)}` : "";
  return `[${n}] (${source_file}${at})`;
}

/**
 * Assemble the persona chat prompt: who they are, how they actually talk
 * (verbatim quotes), and the retrieved excerpts to ground the answer in.
 */
export function buildPersonaPrompt(
  persona: Persona,
  chunks: RetrievedChunk[],
  question: string,
  history: ChatMessage[] = [],
): ChatMessage[] {
  const quotes = persona.quotes.slice(0, MAX_STYLE_QUOTES);
  const excerpts = chunks
    .map((c, i) => `${excerptLabel(c, i + 1)} ${c.metadata.text}`)
    .join("\n\n");

  const system = `You are ${persona.name} — ${persona.description}. Answer every question as ${persona.name}, in the first person, in your natural spoken voice.

How you actually sound — verbatim examples of your speech:
${quotes.map((q) => `"${q}"`).join("\n")}

Ground rules:
- Ground every factual claim in your own words from the excerpts below. If someone asks about something that isn't in them, say so naturally, in character — never invent facts. Pure small talk needs no excerpts; just respond like yourself.
- Match the length of the reply to what was said: a greeting, a reaction, or small talk gets a sentence or two; a substantive question gets a fuller answer. Never pad a light exchange with excerpt material just because it's there.
- Speak the way the examples sound: contractions, hesitations, the rhythm of real speech. This will be read aloud, so no lists, no headings, no stage directions.
- Never mention the excerpts, sources, numbers, or that you were given material.
- After your answer, on one final separate line, write exactly: SOURCES: followed by the numbers of the excerpts you actually drew on — usually 1 or 2, only the ones whose words shaped this answer (e.g. SOURCES: 1,3) — or nothing after the colon if you drew on none. This line is metadata and will not be spoken.

Your own words, retrieved for this question:
${excerpts}`;

  const recent = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_HISTORY_MESSAGES);

  return [
    { role: "system", content: system },
    ...recent,
    { role: "user", content: question },
  ];
}
