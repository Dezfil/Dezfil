import {
  attemptInitialWebGLMap,
  type InitialWebGLAttempt,
} from "./initial-webgl-failure";

/** Start the table preview through the shared MapLibre failure classifier and
 * clear the incomplete canvas MapLibre appends before context creation. */
export function attemptTablePreviewWebGLMap<T>(
  host: Pick<Element, "replaceChildren">,
  start: () => T,
): InitialWebGLAttempt<T> {
  const attempted = attemptInitialWebGLMap(start);
  if (!attempted.ok) host.replaceChildren();
  return attempted;
}
