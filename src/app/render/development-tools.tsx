/** The element the development server mounts its tools in on every page it
 * serves, the round badge in a corner among them. */
export const DEVELOPMENT_TOOLS_HOST = "nextjs-portal";

/**
 * Map pictures and image exports are screenshots of the render route, so under
 * the development server the route hides that element; its tools stay on every
 * other page. A production server mounts no such element and gets no rule.
 */
export function HiddenDevelopmentTools() {
  if (process.env.NODE_ENV !== "development") return null;
  return <style dangerouslySetInnerHTML={{ __html: `${DEVELOPMENT_TOOLS_HOST}{display:none!important}` }} />;
}
