import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { listTemplates, readTemplate, refreshCatalogue, resetCatalogueForTests } from "./catalogue";

/**
 * The templates this release ships, as a fresh instance sees them with the
 * catalogue switched off: the three shipped versions first, in the image's
 * order, each installed, readable whole from the image (its map, data and,
 * for the workflow example, the workflow with every step's result), and
 * each the released archive by its checksum, which the revision begins.
 * Nothing is sent: the list answers from disk, and a refresh is refused
 * while the switch is off.
 */

keepRequestsOnThisMachine();

/** The shipped versions in the image's order, each with its released
 * archive's SHA-256 as the release's index declares it. */
const SHIPPED = [
  {
    id: "earthquakes", version: 3, kind: "map", title: "Forty years of big earthquakes",
    archive: "fe37668cb6ee09b8d893f5610c5642cb40a6db85f6e0949056a8f2a0131bfbbe",
  },
  {
    id: "air-routes", version: 3, kind: "map", title: "The world's air routes",
    archive: "58a09d6e9727e405912d1de385aada0883546ae7a834d4e315b170bddffb588d",
  },
  {
    id: "rwanda-health-access", version: 4, kind: "workflow", title: "Health access in Rwanda",
    archive: "3f6db7f5d68d8e09301c2b68c812d4dfa3b1d753910b08801480f8b0c303f5f1",
  },
];

let f: ReturnType<typeof instanceSettingsFixture>;

beforeEach(() => {
  f = instanceSettingsFixture();
  resetSecretKeyCache();
  resetCatalogueForTests();
  writeStoredSettings({ "templates.catalogue": false }, f.db);
});

afterEach(() => {
  resetCatalogueForTests();
  f.close();
  resetSecretKeyCache();
});

describe("the shipped set on a fresh instance with the catalogue off", () => {
  it("lists the three shipped templates, in the image's order, and nothing else", async () => {
    const list = await listTemplates(f.db);
    expect(list.catalogue.state).toBe("off");
    expect(list.templates.map(({ id, version, kind, title }) => ({ id, version, kind, title })))
      .toEqual(SHIPPED.map(({ id, version, kind, title }) => ({ id, version, kind, title })));
    for (const card of list.templates) {
      const { version } = SHIPPED.find((s) => s.id === card.id)!;
      expect(card).toMatchObject({ origin: "shipped", installed: version, listed: null, present: true, picture: "kept" });
    }
    expect(list.templates.find((t) => t.id === "rwanda-health-access")?.steps).toHaveLength(6);
    expect(list.downloads).toEqual({ versions: 0, bytes: 0 });
    await expect(refreshCatalogue(f.db)).rejects.toMatchObject({ code: "templates_catalogue_off", status: 409 });
  });

  it("reads each one whole from the image: the released version, its map, its data and its workflow", async () => {
    for (const { id, kind, archive } of SHIPPED) {
      const read = await readTemplate(id, f.db);
      expect(read.contents, id).not.toBeNull();
      expect(read.contents!.revision, id).toBe(archive.slice(0, 32));
      expect(read.contents!.mapId, id).toEqual(expect.any(String));
      expect(read.contents!.datasets.length, id).toBeGreaterThan(0);
      for (const dataset of read.contents!.datasets) expect(dataset.rowCount, `${id}: ${dataset.name}`).toBeGreaterThan(0);
      if (kind === "workflow") {
        expect(read.contents!.workflow?.steps, id).toHaveLength(6);
        for (const step of read.contents!.workflow!.steps) expect(step.output.rowCount, `${id}: ${step.id}`).toBeGreaterThan(0);
      } else {
        expect(read.contents!.workflow, id).toBeNull();
      }
    }
  });
});
