import manifest from "../../../package.json";

const key = Symbol.for("dezfil.process-start");
const host = process as typeof process & { [key]?: string };
// Route bundles share one timestamp, including a bundle first loaded much later.
export const startedAt = host[key] ??= new Date(Date.now() - process.uptime() * 1000).toISOString();
export const version = manifest.version;
