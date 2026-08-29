import type { Metadata } from "next";
import { IBM_Plex_Mono, Orbitron, Space_Grotesk } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const grotesk = Space_Grotesk({
  variable: "--font-grotesk",
  weight: ["300", "400", "500"],
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

// Logo display face. Stand-in for HK Modular (commercial, not licensed here);
// to use the real thing, drop the font file in and switch to next/font/local.
const logoFont = Orbitron({
  variable: "--font-logo",
  weight: ["600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Alexandria",
  description: "Speak with a person through everything they ever said.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${grotesk.variable} ${plexMono.variable} ${logoFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white text-[#0A0A0A]">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
