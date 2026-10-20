import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import RenderLayout from "./layout";
import { DEVELOPMENT_TOOLS_HOST } from "./development-tools";

vi.mock("next/font/google", () => {
  const face = (name: string) => () => ({ variable: `font-${name}`, className: name, style: {} });
  return { Archivo: face("archivo"), DM_Mono: face("dm-mono"), Gabarito: face("gabarito"),
    IBM_Plex_Mono: face("plex-mono"), Inter: face("inter") };
});
afterEach(() => vi.unstubAllEnvs());

const markup = () => renderToStaticMarkup(RenderLayout({ children: <main data-export-root="" /> }));

it("hides the development server's tools on every render page it serves", () => {
  vi.stubEnv("NODE_ENV", "development");
  expect(markup()).toContain(`<style>${DEVELOPMENT_TOOLS_HOST}{display:none!important}</style><main data-export-root=""></main>`);
});

it.each(["production", "test"])("adds nothing under NODE_ENV=%s", mode => {
  vi.stubEnv("NODE_ENV", mode);
  expect(markup()).not.toContain("<style>");
  expect(markup()).not.toContain(DEVELOPMENT_TOOLS_HOST);
});

it("names the element the installed Next.js mounts its development tools in", () => {
  // An upgrade that renames the host would bring the badge back into pictures.
  const tools = readFileSync(createRequire(import.meta.url).resolve("next/dist/compiled/next-devtools/index.js"), "utf8");
  expect(tools).toContain(`document.createElement("${DEVELOPMENT_TOOLS_HOST}")`);
  expect(tools).toContain("App Dev Overlay");
});
