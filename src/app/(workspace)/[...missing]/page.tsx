import { notFound } from "next/navigation";

/** Any address no other page answers. With several root layouts there is no
 * top-level one to hold the framework's own 404, so an unknown address is
 * caught here: it stays behind the gate, and the workspace's not-found page
 * says so inside the shell. */
export default function MissingPage(): never {
  notFound();
}
