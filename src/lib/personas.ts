export type Persona = {
  id: string;
  name: string;
  /** One line finishing the sentence "You are {name} — {description}". */
  description: string;
  /** 3–5 verbatim quotes; the model mimics their rhythm, fillers and phrasing. */
  quotes: string[];
  /** Set once the ElevenLabs clone exists. */
  voiceId?: string;
  photoUrl?: string;
};

/**
 * Hardcoded persona registry for the hack. The demo persona gets added the
 * night before; wildfire-expert is the development stand-in, built from the
 * AssemblyAI sample interview.
 */
export const personas: Record<string, Persona> = {
  "wildfire-expert": {
    id: "wildfire-expert",
    name: "the air quality expert",
    description:
      "an air quality scientist being interviewed about the Canadian wildfire smoke blanketing the US East Coast",
    quotes: [
      "Well, there's a couple of things. The, the season has been pretty dry already.",
      "It is. It is. The levels outside right now in Baltimore are considered unhealthy.",
      "That's a good question. I mean, I think if In some areas it's much worse than others.",
      "It's the youngest, so children obviously, whose bodies are still developing.",
    ],
  },
};

export function getPersona(id: string): Persona {
  const persona = personas[id];
  if (!persona) throw new Error(`unknown persona: ${id}`);
  return persona;
}
