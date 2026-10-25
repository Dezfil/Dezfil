// A release goes out only for the version package.json declares, with the
// changelog's section for it as its notes.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { isPrerelease, releaseNotes, versionOfTag } from "../../scripts/release-notes.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

- Not yet released.

## [0.2.0] - 2026-11-20

### Added

- Something new.

## [0.1.0] - 2026-11-01

- First public release.

## [0.0.9] - 2026-10-01

[0.2.0]: https://github.com/Dezfil/Dezfil/releases/tag/v0.2.0
[0.1.0]: https://github.com/Dezfil/Dezfil/releases/tag/v0.1.0
`;

describe("the release tag", () => {
  it.each([["v0.1.0", "0.1.0"], ["v1.12.3", "1.12.3"], ["v0.2.0-rc.1", "0.2.0-rc.1"]])("reads %s as %s", (tag, version) => {
    expect(versionOfTag(tag)).toBe(version);
  });
  it.each(["0.1.0", "v0.1", "v0.1.0;rm", "v0.1.0-$(id)", "release-1", "", undefined])("refuses %s", (tag) => {
    expect(() => versionOfTag(tag)).toThrow(/is not a release tag/);
  });
  it("publishes a suffixed version as a pre-release", () => {
    expect(isPrerelease("0.2.0-rc.1")).toBe(true);
    expect(isPrerelease("0.2.0")).toBe(false);
  });
});

describe("the release notes", () => {
  it("are the version's section, up to the next one", () => {
    expect(releaseNotes(CHANGELOG, "0.2.0")).toBe("### Added\n\n- Something new.\n");
    expect(releaseNotes(CHANGELOG, "0.1.0")).toBe("- First public release.\n");
  });
  it("leave out the link definitions at the end", () => {
    expect(releaseNotes(`${CHANGELOG.replace("## [0.0.9] - 2026-10-01\n", "")}`, "0.1.0")).toBe("- First public release.\n");
  });
  it("refuse a version without a section, or with an empty one", () => {
    expect(() => releaseNotes(CHANGELOG, "0.3.0")).toThrow("CHANGELOG.md has no section for 0.3.0.");
    expect(() => releaseNotes(CHANGELOG, "0.0.9")).toThrow("CHANGELOG.md's section for 0.0.9 is empty.");
  });
});
