import { pathToFileURL } from "node:url";
import path from "node:path";

const MARKER = "/* dezfil preload chain */";
function tokens(text) {
  const result = [];
  let word = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && quoted) { word += text[++index] ?? ""; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (/\s/.test(char) && !quoted) { if (word) result.push(word); word = ""; }
    else word += char;
  }
  if (quoted) throw new Error("Unterminated NODE_OPTIONS quote");
  if (word) result.push(word);
  return result;
}
function moduleUrl(value) {
  if (/^(file|data|node):/.test(value)) return value;
  return value.startsWith(".") || path.isAbsolute(value) ? pathToFileURL(path.resolve(value)).href : import.meta.resolve(value);
}
export function preservePreloads(options, ingressUrl) {
  const parsed = tokens(options), imports = [], others = [];
  for (let index = 0; index < parsed.length; index++) {
    const token = parsed[index];
    if (token === "--import") imports.push(parsed[++index]);
    else if (token.startsWith("--import=")) imports.push(token.slice(9));
    else others.push(token);
  }
  if (imports.some(value => value?.startsWith("data:text/javascript;base64,") &&
      Buffer.from(value.split(",")[1], "base64").toString("utf8").startsWith(MARKER))) return options;
  const chain = [...new Set([...imports.map(moduleUrl), ingressUrl])];
  const code = `${MARKER}\n${chain.map(url => `await import(${JSON.stringify(url)});`).join("\n")}`;
  const preload = `--import=data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return [...others, preload].map(token => /[\s"\\]/.test(token) ? JSON.stringify(token) : token).join(" ");
}
