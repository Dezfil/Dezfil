import { installIngress } from "../src/lib/auth/ingress.mjs";
import { preservePreloads } from "./preload-options.mjs";

installIngress();
// Next's development child reduces repeated --import flags to one. Carry the
// complete chain in that one import so existing observers survive the fork.
process.env.NODE_OPTIONS = preservePreloads(process.env.NODE_OPTIONS ?? "", import.meta.url);
