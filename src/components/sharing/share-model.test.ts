import { describe, expect, it } from "vitest";
import type { ProjectPersonWire } from "./people";
import {
  connectionLines,
  everythingLine,
  membersLine,
  missLine,
  orderedPeople,
  transferable,
  USERS_LINE,
} from "./share-model";

/** The share dialog's and the members line's words and orderings. */

const person = (sqlName: string, name: string, role: ProjectPersonWire["role"], deactivated = false): ProjectPersonWire =>
  ({ sqlName, name, role, deactivated });
const ada = person("ada", "Ada Okafor", "owner");
const bo = person("bo", "Bo Lindqvist", "editor");
const cy = person("cy", "Cy Marsh", "viewer", true);
const dee = person("dee", "Dee Nakamura", "viewer");

describe("the dialog's people", () => {
  it("pins the owner first, then the active members by name, then the deactivated", () => {
    expect(orderedPeople([cy, dee, bo, ada]).map((p) => p.sqlName)).toEqual(["ada", "bo", "dee", "cy"]);
  });

  it("hands the project over only to an active member", () => {
    expect(transferable([ada, bo, cy, dee]).map((p) => p.sqlName)).toEqual(["bo", "dee"]);
  });
});

describe("the members line", () => {
  it("names nobody on a project its owner alone reaches", () => {
    expect(membersLine([ada])).toBeNull();
  });

  it("names the people by first name, the first two and a count past three", () => {
    expect(membersLine([ada, bo])).toBe("Shared with Bo");
    expect(membersLine([ada, cy, bo])).toBe("Shared with Bo and Cy");
    expect(membersLine([ada, bo, cy, dee])).toBe("Shared with Bo, Dee and Cy");
    expect(membersLine([ada, bo, cy, dee, person("eli", "Eli Brandt", "viewer")])).toBe("Shared with Bo, Dee and 2 more");
  });
});

describe("the dialog's sentences", () => {
  it("says what people get, by what the project holds", () => {
    expect(everythingLine({ maps: 3, workflows: 1, datasets: 5 })).toBe("People get everything in it: 3 maps, 1 workflow, 5 datasets.");
    expect(everythingLine({ maps: 0, workflows: 0, datasets: 0 })).toBe("People get everything you add to it.");
  });

  it("says a miss by what was typed, and where accounts come from", () => {
    expect(missLine("zed")).toBe("No account with that name.");
    expect(missLine("eli@harbour.example")).toBe("No account with that email.");
    expect(USERS_LINE).toBe("An admin adds accounts on the Users page.");
  });
});

describe("the line naming a connection-bound refresh", () => {
  const table = (name: string, owner: string, source: string, connectionName?: string) =>
    ({ name, owner: { name: owner, sqlName: owner }, source, sourceParams: connectionName ? { connectionName } : null });

  it("names each of the owner's connections a dataset in the project refreshes through", () => {
    expect(connectionLines([
      table("roads", "ada", "postgis", "city_gis"), table("parcels", "ada", "postgis", "city_gis"),
      table("berths", "ada", "upload"), table("quays", "bo", "postgis", "port_gis"),
    ], "ada")).toEqual([{ connection: "city_gis", datasets: ["parcels", "roads"] }]);
  });

  it("names nothing when no dataset of the owner's refreshes through a connection", () => {
    expect(connectionLines([table("berths", "ada", "upload"), table("quays", "bo", "postgis", "port_gis")], "ada")).toEqual([]);
  });
});
