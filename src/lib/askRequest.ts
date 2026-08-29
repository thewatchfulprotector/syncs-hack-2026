import { z } from "zod";
import { capConversationHistory } from "./prompt";

/**
 * Wire shape of POST /api/ask. personaId and question are rejected when
 * invalid; history is deliberately lenient — junk entries are dropped and the
 * rest capped to budget, so a stale client can never fail a whole request.
 */
const askRequestSchema = z.object({
  personaId: z.string(),
  question: z.string().refine((value) => value.trim().length > 0, {
    message: "question must not be blank",
  }),
  history: z.unknown().optional().transform(capConversationHistory),
  // lenient like history: only an explicit false opts out of TTS
  voice: z
    .unknown()
    .optional()
    .transform((value) => value !== false),
});

export type AskRequest = z.infer<typeof askRequestSchema>;

export function parseAskRequest(body: unknown): AskRequest | null {
  const result = askRequestSchema.safeParse(body);
  return result.success ? result.data : null;
}
