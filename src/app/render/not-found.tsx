/** The render route's root answers an address it has no page for with a
 * plain line: the renderer only ever reads a map's composition here. */
export default function RenderNotFound() {
  return <h1>Page not found</h1>;
}
