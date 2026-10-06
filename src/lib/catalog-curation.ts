import type { Product } from "payz-core/types";

const GLOBAL_BRAND_ALIASES = [
  "adobe",
  "adidas",
  "airbnb",
  "amazon",
  "apple",
  "booking.com",
  "canva",
  "chatgpt",
  "claude",
  "disney",
  "doordash",
  "google",
  "google play",
  "gemini",
  "mcdonalds",
  "mcdonald's",
  "microsoft 365",
  "netflix",
  "nintendo",
  "nordvpn",
  "notion",
  "openai",
  "playstation",
  "roblox",
  "spotify",
  "starbucks",
  "steam",
  "target",
  "uber",
  "uber eats",
  "walmart",
  "xbox",
  "youtube",
];

const CATEGORY_BRAND_ALIASES: Record<string, string[]> = {
  shopping: ["adidas", "amazon", "apple", "best buy", "nike", "target", "walmart"],
  "food-beverage": ["doordash", "deliveroo", "kfc", "mcdonalds", "mcdonald's", "starbucks", "uber eats"],
  entertainment: ["disney", "netflix", "spotify", "youtube"],
  gaming: ["google play", "nintendo", "playstation", "roblox", "steam", "xbox"],
  sports: [],
  travel: ["airbnb", "booking.com", "uber"],
  "tech-apps": ["adobe", "canva", "chatgpt", "claude", "gemini", "microsoft 365", "nordvpn", "notion"],
  mobile: [],
  lifestyle: [],
  services: ["ppq.ai", "openai", "nordvpn", "claude", "surfshark", "microsoft office", "microsoft 365", "google workspace", "exitlag", "my instant ai", "gemini", "nordlocker", "nordpass", "adobe", "canva", "notion", "1password", "dropbox"],
};

// Recognition signals only: no products are created from this list. A matching
// live, complete, supported regional offer is always required for approval.
const REGIONAL_BRAND_ALIASES = [
  "7-eleven", "aldi", "asda", "tesco", "sainsbury", "waitrose", "morrisons",
  "carrefour", "auchan", "lidl", "rewe", "edeka", "albert heijn", "jumbo",
  "el corte ingles", "mercadona", "conad", "esselunga", "coop",
  "woolworths", "coles", "big w", "kmart", "bunnings", "jb hi fi", "myer",
  "loblaws", "sobeys", "tim hortons", "cineplex", "canadian tire", "shoppers drug mart",
  "rakuten", "lawson", "familymart", "uniqlo", "don quijote", "yodobashi",
  "lotte", "emart", "shinsegae", "coupang", "olive young", "cgv",
  "grab", "fairprice", "ntuc", "cold storage", "takashimaya", "shopee", "lazada",
  "noon", "lulu", "almosafer", "jarir", "extra", "namshi", "anghami",
  "flipkart", "myntra", "ajio", "swiggy", "zomato", "bigbasket", "pvr", "bookmyshow",
  "tokopedia", "gojek", "gofood", "indomaret", "alfamart", "blibli", "traveloka",
  "ebay", "nike", "best buy", "ikea", "h&m", "zara", "decathlon", "sephora", "asos",
  "dick s sporting goods", "academy sports", "american golf", "arsenal", "as roma",
  "espn", "dazn", "fubo", "fanatics", "foot locker", "the north face",
  "accor", "marriott", "hilton", "air canada", "amtrak", "trainline", "bolt",
  "shell", "bp", "chevron", "exxon", "ampol", "enoc",
  "burger king", "kfc", "pizza hut", "domino", "subway", "dunkin", "chipotle", "taco bell",
  "amc theatres", "cinemark", "odeon", "vue", "pathe", "fnac", "audible", "hulu",
  "1password", "dropbox", "microsoft", "app store & itunes", "battle net", "riot games",
];

const BRAND_MARK_ALIASES = new Set([
  ...GLOBAL_BRAND_ALIASES,
  ...Object.values(CATEGORY_BRAND_ALIASES).flat(),
  ...REGIONAL_BRAND_ALIASES,
]);

function normalizedIdentity(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function matchesAlias(value: string, alias: string): boolean {
  const normalized = normalizedIdentity(value);
  const target = normalizedIdentity(alias);
  return normalized === target || normalized.startsWith(`${target} `);
}

function featuredBrandIdentity(value: string): string {
  if (matchesAlias(value, "mcdonalds") || matchesAlias(value, "mcdonald's")) {
    return "mcdonalds";
  }
  return normalizedIdentity(value);
}

function hasBrand(product: Product, aliases: string[]): boolean {
  return aliases.some((alias) => matchesAlias(product.brand, alias));
}

export function hasCuratedArtwork(product: Product): boolean {
  return Boolean(product.image?.startsWith("https://")) || hasBrand(product, [...BRAND_MARK_ALIASES]);
}

export function isCuratedProduct(product: Product): boolean {
  return product.available &&
    product.availableRegions.length > 0 &&
    Boolean(product.brand.trim()) &&
    Boolean(product.name.trim()) &&
    Boolean(product.description.trim()) &&
    hasCuratedArtwork(product);
}

export function rankCatalogProducts(
  products: Product[],
  regionCode?: string,
  mode: "global" | "regional" = "global",
): Product[] {
  const regionName = regionCode
    ? products
        .flatMap((product) => product.availableRegions)
        .find((region) => region.code === regionCode)?.name ?? regionCode
    : "";

  const score = (product: Product): number => {
    const coverage = Math.min(product.availableRegions.length, 100);
    const globalBrand = hasBrand(product, GLOBAL_BRAND_ALIASES);
    const categoryBrand = hasBrand(product, CATEGORY_BRAND_ALIASES[product.categoryId] ?? []);
    const regionalBrand = hasBrand(product, REGIONAL_BRAND_ALIASES);
    const usableOffer = product.available && product.availableRegions.length > 0;
    const priceOptions = product.denominations.length + (product.range ? 1 : 0);
    let total =
      (product.featured ? 100 : 0) +
      (globalBrand ? 60 : 0) +
      (categoryBrand ? 30 : 0) +
      (regionalBrand ? 25 : 0) +
      Math.min(priceOptions, 5) * 3 +
      (product.image ? 12 : 0) +
      (usableOffer ? 20 : 0) +
      coverage * 0.5;

    if (mode === "regional" && regionCode) {
      const identity = `${product.brand} ${product.name}`.toLowerCase();
      if (regionName && identity.includes(regionName.toLowerCase())) total += 12;
      if (identity.includes(regionCode.toLowerCase())) total += 8;
      if (product.availableRegions.length <= 3) total += 6;
    }
    return total;
  };

  return [...products].sort((a, b) =>
    score(b) - score(a) ||
    a.brand.localeCompare(b.brand) ||
    a.id.localeCompare(b.id),
  );
}

export function takeUniqueBrands(products: Product[], limit: number): Product[] {
  const seen = new Set<string>();
  const unique: Product[] = [];
  for (const product of products) {
    const key = normalizedIdentity(product.brand);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(product);
    if (unique.length >= limit) break;
  }
  return unique;
}

// Featured is an editorial selection of major brands, not the first catalog
// entries alphabetically. Only existing eligible offers can appear here.
const FEATURED_BRAND_PRIORITY = [
  "mcdonalds", "mcdonald's", "kfc",
  "amazon", "netflix", "spotify", "steam", "apple", "google play",
  "playstation", "uber", "airbnb", "nike", "adidas", "starbucks",
  "xbox", "nintendo", "roblox", "booking.com",
  "walmart", "target", "disney", "doordash", "adobe", "canva",
  "nordvpn", "microsoft 365", "chatgpt", "openai", "claude", "gemini",
];

export function selectFeaturedProducts(products: Product[], limit: number): Product[] {
  if (limit <= 0) return [];
  const eligible = rankCatalogProducts(products).filter(isCuratedProduct);
  const selected: Product[] = [];
  const seen = new Set<string>();
  for (const alias of FEATURED_BRAND_PRIORITY) {
    const identity = normalizedIdentity(alias);
    const product =
      eligible.find((item) => normalizedIdentity(item.brand) === identity) ??
      eligible.find((item) => matchesAlias(item.brand, alias));
    if (!product) continue;
    const brand = featuredBrandIdentity(product.brand);
    if (seen.has(brand)) continue;
    seen.add(brand);
    selected.push(product);
    if (selected.length >= limit) break;
  }
  return selected;
}
