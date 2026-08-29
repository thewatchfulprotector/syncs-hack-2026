"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { House, Landmark } from "lucide-react";
import {
  NotchNav,
  type NotchItemData,
} from "@/components/ui/adaptive-notch-navigation-bar";
import { DEFAULT_PERSONA_ID, personas, personaTitle } from "@/lib/personas";

const HOME_ID = "home";

const NAV_ITEMS: NotchItemData[] = [
  { id: HOME_ID, label: "Home", icon: House },
  ...Object.values(personas).map((p) => ({
    id: p.id,
    label: personaTitle(p.id),
    badge: p.voiceId ? "Voice" : undefined,
  })),
];

const PERSONA_PATHS = ["/ask", "/chat"];

/** Voice-cloned personas talk on /ask; the rest get the text chat on /chat. */
function personaPath(id: string): string {
  return personas[id]?.voiceId ? "/ask" : "/chat";
}

function activeFromLocation(): string {
  if (!PERSONA_PATHS.includes(window.location.pathname)) return HOME_ID;
  return (
    new URLSearchParams(window.location.search).get("persona") ??
    DEFAULT_PERSONA_ID
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // read after mount: the URL isn't known during server render
  const [activeId, setActiveId] = useState(HOME_ID);

  useEffect(() => {
    const sync = () => setActiveId(activeFromLocation());
    sync();
    // pathname doesn't change between two personas on /ask, so back/forward
    // needs its own listener
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [pathname]);

  function handleActiveChange(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    if (id === HOME_ID) {
      router.push("/");
      return;
    }
    if (PERSONA_PATHS.includes(pathname ?? "")) {
      // Full navigation between personas: the conversation pages read the
      // persona once on mount, and leaving /ask should tear down the previous
      // persona's mic session and audio queue anyway.
      window.location.href = new URL(
        `${personaPath(id)}?persona=${id}`,
        window.location.origin,
      ).toString();
      return;
    }
    router.push(`${personaPath(id)}?persona=${id}`);
  }

  return (
    <NotchNav
      items={NAV_ITEMS}
      activeId={activeId}
      onActiveChange={handleActiveChange}
      logo={
        <div className="flex h-8.5 items-center gap-2">
          <Landmark className="size-4" />
          <span className="text-[12px] uppercase tracking-[0.08em] font-[family-name:var(--font-logo)]">
            Alexandria
          </span>
        </div>
      }
      rightContent={
        <span className="hidden h-8.5 items-center text-[10px] uppercase tracking-[0.18em] text-zinc-400 sm:flex font-[family-name:var(--font-plex-mono)]">
          Syncs 2026
        </span>
      }
    >
      {children}
    </NotchNav>
  );
}
