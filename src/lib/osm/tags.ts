/**
 * Curated tag list for the browse affordance (static, shipped with
 * Dezfil, refreshed at build time — no runtime tag-info dependency). Keys
 * and their most common values, taken from taginfo's top usage.
 */

export interface TagSuggestion {
  /** "key" or "key=value" as it lands in the chip input. */
  entry: string;
}

const KEYS_WITH_VALUES: Record<string, string[]> = {
  amenity: [
    "restaurant",
    "cafe",
    "bar",
    "pub",
    "fast_food",
    "pharmacy",
    "hospital",
    "doctors",
    "school",
    "kindergarten",
    "university",
    "library",
    "bank",
    "atm",
    "fuel",
    "charging_station",
    "parking",
    "bicycle_parking",
    "place_of_worship",
    "toilets",
    "drinking_water",
    "post_office",
    "police",
    "fire_station",
    "theatre",
    "cinema",
  ],
  shop: [
    "supermarket",
    "convenience",
    "bakery",
    "butcher",
    "clothes",
    "hairdresser",
    "florist",
    "furniture",
    "electronics",
    "bicycle",
  ],
  tourism: [
    "hotel",
    "hostel",
    "guest_house",
    "museum",
    "attraction",
    "viewpoint",
    "information",
    "camp_site",
  ],
  leisure: [
    "park",
    "playground",
    "pitch",
    "sports_centre",
    "swimming_pool",
    "garden",
    "fitness_centre",
  ],
  highway: [
    "residential",
    "primary",
    "secondary",
    "tertiary",
    "footway",
    "cycleway",
    "path",
    "bus_stop",
    "crossing",
    "traffic_signals",
  ],
  building: ["house", "apartments", "commercial", "industrial", "church"],
  landuse: [
    "residential",
    "commercial",
    "industrial",
    "forest",
    "farmland",
    "grass",
    "meadow",
  ],
  natural: ["water", "wood", "tree", "scrub", "wetland", "beach"],
  waterway: ["river", "stream", "canal", "ditch"],
  railway: ["station", "halt", "tram_stop", "rail", "subway"],
  public_transport: ["stop_position", "platform", "station"],
  boundary: ["administrative", "protected_area"],
  emergency: ["fire_hydrant", "defibrillator"],
  power: ["tower", "pole", "generator", "substation"],
  man_made: ["surveillance", "water_tower", "mast"],
  historic: ["memorial", "monument", "castle", "ruins"],
  office: ["company", "government", "estate_agent", "insurance"],
  craft: ["carpenter", "electrician", "photographer"],
  sport: ["soccer", "tennis", "basketball", "swimming", "climbing"],
  cuisine: ["italian", "pizza", "burger", "asian", "kebab", "sushi"],
};

export const TAG_SUGGESTIONS: TagSuggestion[] = Object.entries(
  KEYS_WITH_VALUES,
).flatMap(([key, values]) => [
  { entry: key },
  ...values.map((v) => ({ entry: `${key}=${v}` })),
]);
