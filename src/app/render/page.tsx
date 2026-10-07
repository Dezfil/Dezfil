import { notFound } from "next/navigation";

/** The render root's own address names no map: its plain not-found page. */
export default function RenderRootPage(): never {
  notFound();
}
