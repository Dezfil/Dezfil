import { describe, it, expect } from "vitest";
import { deriveTableName } from "./naming";

const none = new Set<string>();

describe("deriveTableName", () => {
  it("lowercases and strips the extension", () => {
    expect(deriveTableName("Parks.geojson", none)).toBe("parks");
  });

  it("sanitizes to a valid SQL identifier", () => {
    expect(deriveTableName("NYC Taxi Zones (2024).csv", none)).toBe(
      "nyc_taxi_zones_2024",
    );
    expect(deriveTableName("übungs-daten.parquet", none)).toBe("ubungs_daten");
  });

  it("prefixes names that would start with a digit", () => {
    expect(deriveTableName("2024_trips.csv", none)).toBe("t2024_trips");
  });

  it("falls back when nothing survives sanitizing", () => {
    expect(deriveTableName("---.csv", none)).toBe("table");
  });

  it("deduplicates on collision without overwriting", () => {
    const taken = new Set(["parks", "parks_2"]);
    expect(deriveTableName("parks.geojson", taken)).toBe("parks_3");
  });
});
