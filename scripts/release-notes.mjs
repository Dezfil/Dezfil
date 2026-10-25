// The release workflow's notes: the changelog's section for the version a tag
// names. It refuses a tag that is not package.json's version, and a version
// the changelog has no section for, so a release never goes out unrecorded.
//
// Usage: node scripts/release-notes.mjs <tag>   # prints the notes for v<version>
import { readFileSync } from "node:fs";

/** The version a release tag names: v0.1.0 gives 0.1.0, v0.2.0-rc.1 gives
 * 0.2.0-rc.1. Anything else is refused, so the version is safe to use in a
 * shell or an image tag. */
export function versionOfTag(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(tag ?? "");
  if (!match) throw new Error(`${tag} is not a release tag such as v0.1.0.`);
  return match[1];
}

/** A pre-release (a version with a suffix) is published without `latest`. */
export function isPrerelease(version) {
  return version.includes("-");
}

/** The body of the changelog's `## [<version>]` section, without the link
 * definitions a Keep a Changelog file ends with. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  const body = lines.slice(start + 1, next < 0 ? lines.length : next)
    .filter((line) => !/^\[[^\]]+\]:\s/.test(line))
    .join("\n")
    .trim();
  if (!body) throw new Error(`CHANGELOG.md's section for ${version} is empty.`);
  return `${body}\n`;
}

if (process.argv[1]?.endsWith("release-notes.mjs")) {
  try {
    const version = versionOfTag(process.argv[2]);
    const declared = JSON.parse(readFileSync("package.json", "utf8")).version;
    if (declared !== version) throw new Error(`The tag names ${version}, but package.json says ${declared}.`);
    process.stdout.write(releaseNotes(readFileSync("CHANGELOG.md", "utf8"), version));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
