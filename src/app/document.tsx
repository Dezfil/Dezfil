import type { Metadata } from "next";
import { Archivo, DM_Mono, Gabarito, IBM_Plex_Mono, Inter } from "next/font/google";
import type { LookAttributes } from "@/lib/look";
import "./globals.css";

// Self-hosted at build time — no runtime font CDN (air-gapped instances
// keep their typography). The workspace speaks Gabarito/Inter/DM Mono;
// Archivo/Plex Mono stay loaded solely for the published viewer, which
// pins its earlier appearance. Unused faces never download.
const gabarito = Gabarito({
  subsets: ["latin"],
  variable: "--font-gabarito",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
});

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

/** Every root layout's metadata: one title and description for the product. */
export const DOCUMENT_METADATA: Metadata = {
  title: "Dezfil",
  description:
    "Self-hosted spatial SQL and map publishing, powered by DuckDB and files",
};

/**
 * Stamps the remembered theme before first paint (no wrong-theme flash).
 * Light is the default, so only "dark" sets the attribute. Published pages
 * (/v/) never follow the workspace theme: their root leaves this script
 * out and the page stamps its own.
 */
const THEME_BOOT = `(function(){try{if(localStorage.getItem("dezfil-theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}})()`;

/**
 * The one document every root layout renders: the fonts, the global
 * stylesheet, `<html>` and `<body>`. The app has several root layouts so
 * that only the workspace's can carry the signed-in person's look: a step
 * between two roots is a full document load, so a stamped root never
 * travels to an entry screen, a published page or the render route. The
 * look arrives as attributes on `<html>` in the served markup itself,
 * which styles the first frame without any script.
 */
export function DezfilDocument({
  children,
  look,
  themeBoot = true,
}: Readonly<{
  children: React.ReactNode;
  /** The person's look, only the picks that differ from Dezfil's default. */
  look?: LookAttributes;
  /** Whether the remembered workspace theme applies before first paint. */
  themeBoot?: boolean;
}>) {
  return (
    <html
      lang="en"
      className={`${gabarito.variable} ${inter.variable} ${dmMono.variable} ${archivo.variable} ${plexMono.variable}`}
      suppressHydrationWarning
      {...look}
    >
      <body>
        {themeBoot && <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />}
        {children}
      </body>
    </html>
  );
}
