/**
 * Read a provider's answer, or stop reading it.
 *
 * A response body is an untrusted stream: it arrives from an endpoint an
 * administrator configured, over a connection this process opened, and nothing about
 * it is bounded until something bounds it. Past the cap the answer is not
 * trusted *at all* — the read stops, the connection is destroyed, and the caller
 * gets null rather than a truncated document that would parse into a plausible
 * lie.
 *
 * Extracted when batch geocoding became the second caller: two copies of a
 * byte cap is how one of them quietly grows a different number.
 */
export async function readCapped(
  body: NodeJS.ReadableStream & { destroy?: (e?: Error) => void },
  maxBytes: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy?.();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
