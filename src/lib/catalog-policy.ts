import type { Category } from "payz-core/types";

// Change this configuration to add markets; publication still requires real,
// eligible inventory for each country. These are not fabricated product entries.
export const SUPPORTED_COUNTRIES: Readonly<Record<string, string>> = {
  US: "United States", GB: "United Kingdom", CA: "Canada", AU: "Australia",
  DE: "Germany", FR: "France", NL: "Netherlands", ES: "Spain", IT: "Italy",
  JP: "Japan", KR: "South Korea", IN: "India", ID: "Indonesia", SG: "Singapore",
  AE: "United Arab Emirates", SA: "Saudi Arabia",
};
export const SUPPORTED_COUNTRY_CODES = Object.keys(SUPPORTED_COUNTRIES);
export const CURATED_CATEGORY_LIMIT = 8;
export const SERVICES_CATEGORY_LIMIT = 24;
export const CATALOG_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CURATED_CATALOG_VERSION = "payz-curated-database-v7";
export const CATEGORY_TAXONOMY: Category[] = [
  { id: "shopping", name: "Shopping" },
  { id: "food-beverage", name: "Food & Beverage" },
  { id: "entertainment", name: "Entertainment" },
  { id: "gaming", name: "Gaming" },
  { id: "sports", name: "Sports" },
  { id: "travel", name: "Travel" },
  { id: "lifestyle", name: "Lifestyle" },
  { id: "services", name: "Services & Apps" },
];
