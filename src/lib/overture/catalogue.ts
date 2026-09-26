/**
 * The Overture themes Dezfil imports (all six at launch). Each theme maps
 * to the hive paths it reads and how dense it is relative to the base
 * area budget — dense themes get a fraction of it.
 */

export type OvertureTheme =
  | "places"
  | "buildings"
  | "transportation"
  | "divisions"
  | "base"
  | "addresses";

export interface ThemeSpec {
  key: OvertureTheme;
  label: string;
  /** Hive partitions under a release, e.g. theme=places/type=place. */
  paths: string[];
  /** Multiplier on the base km² budget (dense themes < 1). */
  budgetFactor: number;
  /** Whether the places category filter applies. */
  categoryFilter: boolean;
}

export const OVERTURE_THEMES: Record<OvertureTheme, ThemeSpec> = {
  places: {
    key: "places",
    label: "Places",
    paths: ["theme=places/type=place"],
    budgetFactor: 1,
    categoryFilter: true,
  },
  buildings: {
    key: "buildings",
    label: "Buildings",
    paths: ["theme=buildings/type=building"],
    budgetFactor: 0.2,
    categoryFilter: false,
  },
  transportation: {
    key: "transportation",
    label: "Transportation",
    paths: ["theme=transportation/type=segment"],
    budgetFactor: 0.5,
    categoryFilter: false,
  },
  divisions: {
    key: "divisions",
    label: "Divisions",
    paths: ["theme=divisions/type=division_area"],
    budgetFactor: 20,
    categoryFilter: false,
  },
  base: {
    key: "base",
    label: "Base · land & water",
    paths: ["theme=base/type=land", "theme=base/type=water"],
    budgetFactor: 4,
    categoryFilter: false,
  },
  addresses: {
    key: "addresses",
    label: "Addresses",
    paths: ["theme=addresses/type=address"],
    budgetFactor: 0.2,
    categoryFilter: false,
  },
};

export function isOvertureTheme(value: unknown): value is OvertureTheme {
  return typeof value === "string" && value in OVERTURE_THEMES;
}

/** Curated places categories (a picker, not free text). Values
 * are Overture taxonomy primaries. */
export const PLACE_CATEGORIES: { value: string; label: string }[] = [
  { value: "restaurant", label: "Restaurants" },
  { value: "cafe", label: "Cafés" },
  { value: "bar", label: "Bars" },
  { value: "fast_food_restaurant", label: "Fast food" },
  { value: "hotel", label: "Hotels" },
  { value: "supermarket", label: "Supermarkets" },
  { value: "grocery_store", label: "Grocery stores" },
  { value: "pharmacy", label: "Pharmacies" },
  { value: "hospital", label: "Hospitals" },
  { value: "doctor", label: "Doctors" },
  { value: "dentist", label: "Dentists" },
  { value: "school", label: "Schools" },
  { value: "college_university", label: "Universities" },
  { value: "library", label: "Libraries" },
  { value: "museum", label: "Museums" },
  { value: "art_gallery", label: "Art galleries" },
  { value: "park", label: "Parks" },
  { value: "gym", label: "Gyms" },
  { value: "bank", label: "Banks" },
  { value: "atm", label: "ATMs" },
  { value: "gas_station", label: "Gas stations" },
  { value: "ev_charging_station", label: "EV charging" },
  { value: "parking", label: "Parking" },
  { value: "bus_station", label: "Bus stations" },
  { value: "train_station", label: "Train stations" },
  { value: "shopping_center", label: "Shopping centers" },
  { value: "clothing_store", label: "Clothing stores" },
  { value: "hair_salon", label: "Hair salons" },
];
