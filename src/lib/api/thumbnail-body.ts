/** Binary thumbnail admission remains the caller's separate contract. */
export async function thumbnailBody(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}
