import Link from "next/link";
import { CommitsGrid } from "@/components/ui/commits-grid";
import { personas, personaTitle } from "@/lib/personas";

const MONO = "font-[family-name:var(--font-plex-mono)]";

const steps = [
  {
    n: "01",
    title: "Ingest",
    body: "Interviews, talks and writing are transcribed, diarized down to the person's own words, and indexed.",
  },
  {
    n: "02",
    title: "Ask",
    body: "Your question retrieves what they actually said — every answer is grounded in their own words.",
  },
  {
    n: "03",
    title: "Hear",
    body: "They answer aloud in their own cloned voice, with citations back to the exact moment in the source.",
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col items-center px-1 pb-16 pt-10 font-[family-name:var(--font-grotesk)] text-[#0A0A0A] sm:pt-16">
      <p className={`text-center text-[10px] uppercase tracking-[0.18em] text-[#0A0A0A] ${MONO}`}>
        The library that never burns down
      </p>
      <h1 className="mt-5 max-w-[720px] text-center text-[clamp(28px,4.6vw,52px)] font-light leading-[1.12] tracking-[-0.02em]">
        Speak with a person through everything they ever said.
      </h1>
      <p className="mt-6 max-w-[560px] text-center text-[15px] font-light leading-[1.7] text-[#6E6E6E]">
        Steve Jobs said the closest he could get to a conversation with
        Aristotle was the texts he left behind. Alexandria gets closer: give it
        the media a person left behind and ask them anything. They answer in
        their own voice, in their own words, so the library never burns down
        again.
      </p>

      <div className="mt-12 w-full max-w-[620px]">
        <CommitsGrid text="SYNCS 2026" />
      </div>

      <div className="mt-16 grid w-full gap-8 border-t border-[#F1F1F1] pt-10 sm:grid-cols-3">
        {steps.map((step) => (
          <div key={step.n} className="flex flex-col gap-2.5">
            <div className={`text-[10px] uppercase tracking-[0.18em] text-[#0A0A0A] ${MONO}`}>
              {step.n} · {step.title}
            </div>
            <p className="text-[13.5px] font-light leading-[1.65] text-[#6E6E6E]">
              {step.body}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-16 flex w-full items-baseline justify-between gap-3">
        <h2 className={`text-[10px] uppercase tracking-[0.18em] ${MONO}`}>
          Choose a person
        </h2>
        <span className={`text-[10px] uppercase tracking-[0.18em] text-[#C9C9C9] ${MONO}`}>
          {Object.keys(personas).length} available
        </span>
      </div>

      <div className="mt-5 grid w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Object.values(personas).map((persona) => (
          <Link
            key={persona.id}
            href={`${persona.voiceId ? "/ask" : "/chat"}?persona=${persona.id}`}
            className="group flex flex-col rounded-[3px] border border-[#E4E4E4] p-6 transition-colors duration-300 hover:border-[#0A0A0A]"
          >
            <div className={`flex items-center justify-between text-[9px] uppercase tracking-[0.16em] text-[#9A9A9A] ${MONO}`}>
              <span>{persona.id}</span>
              <span className="flex items-center gap-[7px]">
                <span
                  className="h-[5px] w-[5px] rounded-full"
                  style={{ background: persona.voiceId ? "#18A15C" : "#C9C9C9" }}
                />
                {persona.voiceId ? "Voice cloned" : "Text only"}
              </span>
            </div>
            <h3 className="mt-5 text-[22px] font-light leading-tight tracking-[-0.01em]">
              {personaTitle(persona.id)}
            </h3>
            <p className="mt-2.5 line-clamp-3 text-[13px] font-light leading-[1.6] text-[#6E6E6E]">
              {persona.blurb}
            </p>
            <p className="mt-4 line-clamp-2 border-l border-[#E4E4E4] pl-3 text-[12.5px] font-light italic leading-[1.6] text-[#9A9A9A]">
              “{persona.quotes[0]}”
            </p>
            <div className={`mt-6 flex items-center gap-2 pt-1 text-[9px] uppercase tracking-[0.16em] text-[#9A9A9A] transition-colors duration-300 group-hover:text-[#0A0A0A] ${MONO}`}>
              Start a conversation
              <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-0.5">
                →
              </span>
            </div>
          </Link>
        ))}
      </div>

      <p className={`mt-16 text-center text-[10px] uppercase tracking-[0.18em] text-[#C9C9C9] ${MONO}`}>
        Created by Spiros & Adam
      </p>
    </div>
  );
}
