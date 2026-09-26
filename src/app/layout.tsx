import type { Metadata } from "next";
import { Archivo, DM_Mono, Gabarito, IBM_Plex_Mono, Inter } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Dezfil",
  description:
    "Self-hosted spatial SQL and map publishing, powered by DuckDB and files",
};

/**
 * Stamps the remembered theme before first paint (no wrong-theme flash).
 * Light is the default, so only "dark" sets the attribute. Published pages
 * (/v/) never follow the workspace theme — they carry their own pre-paint
 * boot.
 */
const THEME_BOOT = `(function(){try{if(location.pathname.slice(0,3)==="/v/")return;if(localStorage.getItem("dezfil-theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${gabarito.variable} ${inter.variable} ${dmMono.variable} ${archivo.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        {children}
      </body>
    </html>
  );
}
