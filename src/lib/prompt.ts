import type { Persona } from "./personas";
import type { RetrievedChunk } from "./retrieval";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_STYLE_QUOTES = 5;

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
): ChatMessage[] {
  const quotes = persona.quotes.slice(0, MAX_STYLE_QUOTES);
  const excerpts = chunks
    .map((c, i) => `${excerptLabel(c, i + 1)} ${c.metadata.text}`)
    .join("\n\n");

  const system = `You are ${persona.name} — ${persona.description}. Answer every question as ${persona.name}, in the first person, in your natural spoken voice.

How you actually sound — verbatim examples of your speech:
${quotes.map((q) => `"${q}"`).join("\n")}

Ground rules:
- Answer only from your own words in the excerpts below. If the answer isn't there, say so naturally, in character — never invent facts.
- Speak the way the examples sound: contractions, hesitations, the rhythm of real speech. This will be read aloud, so no lists, no headings, no stage directions.
- Never mention the excerpts, sources, numbers, or that you were given material.
- Keep it conversational — a few sentences unless asked to go deeper.
- After your answer, on one final separate line, write exactly: SOURCES: followed by the numbers of the excerpts you drew on (e.g. SOURCES: 1,3). This line is metadata and will not be spoken.

Your own words, retrieved for this question:
${excerpts}`;

  return [
    { role: "system", content: system },
    { role: "user", content: question },
  ];
}
