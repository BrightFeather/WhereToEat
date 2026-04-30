/**
 * Controlled feature vocabulary. A restaurant row carries `cuisine_type` (one
 * coarse bucket from `cuisines.ts`) plus a JSON array of features from this
 * registry — the "Sichuan hot-pot omakase brunch place" kind of nuance.
 *
 * Kinds:
 *   region    — sub-cuisine tied to a geographic region (Sichuan, Cantonese, Neapolitan)
 *   format    — dish-type or service specialty (Omakase, Pizza, BBQ, Bakery)
 *   venue     — primary venue category (Coffee, Bar, Cafe, Speakeasy)
 *   modifier  — cross-cutting style (Fusion, Contemporary, Halal)
 *   occasion  — meal period / service occasion (Brunch, Breakfast, Late Night)
 *
 * `parent` links sub-cuisines to their canonical cuisine bucket so we can
 * validate (cuisine=japanese + feature=omakase is consistent; cuisine=chinese
 * + feature=omakase is a classifier bug).
 */

import type { CuisineKey } from './cuisines';

export type FeatureKind = 'region' | 'format' | 'venue' | 'modifier' | 'occasion';

export interface FeatureDef {
  kind: FeatureKind;
  label: string;
  parent?: CuisineKey;
}

export const FEATURES = {
  // ─── region (sub-cuisine) ───────────────────────────────────────────
  sichuan: { kind: 'region', label: 'Sichuan', parent: 'chinese' },
  cantonese: { kind: 'region', label: 'Cantonese', parent: 'chinese' },
  hunan: { kind: 'region', label: 'Hunan', parent: 'chinese' },
  zhejiang: { kind: 'region', label: 'Zhejiang', parent: 'chinese' },
  ningbo: { kind: 'region', label: 'Ningbo', parent: 'chinese' },
  uyghur: { kind: 'region', label: 'Uyghur', parent: 'chinese' },
  taiwanese: { kind: 'region', label: 'Taiwanese', parent: 'chinese' },
  hainanese: { kind: 'region', label: 'Hainanese', parent: 'chinese' },
  dongbei: { kind: 'region', label: 'Dongbei', parent: 'chinese' },
  shanghainese: { kind: 'region', label: 'Shanghainese', parent: 'chinese' },
  neapolitan: { kind: 'region', label: 'Neapolitan', parent: 'italian' },
  basque: { kind: 'region', label: 'Basque', parent: 'spanish' },
  greek: { kind: 'region', label: 'Greek', parent: 'mediterranean' },
  turkish: { kind: 'region', label: 'Turkish', parent: 'mediterranean' },
  portuguese: { kind: 'region', label: 'Portuguese', parent: 'mediterranean' },
  scandinavian: { kind: 'region', label: 'Scandinavian' },
  hawaiian: { kind: 'region', label: 'Hawaiian', parent: 'american' },

  // ─── format (dish / service specialty) ──────────────────────────────
  omakase: { kind: 'format', label: 'Omakase', parent: 'japanese' },
  sushi: { kind: 'format', label: 'Sushi', parent: 'japanese' },
  ramen: { kind: 'format', label: 'Ramen', parent: 'japanese' },
  yakitori: { kind: 'format', label: 'Yakitori', parent: 'japanese' },
  izakaya: { kind: 'format', label: 'Izakaya', parent: 'japanese' },
  yakiniku: { kind: 'format', label: 'Yakiniku', parent: 'japanese' },
  wagyu: { kind: 'format', label: 'Wagyu', parent: 'japanese' },
  pizza: { kind: 'format', label: 'Pizza', parent: 'italian' },
  bbq: { kind: 'format', label: 'BBQ' },
  steakhouse: { kind: 'format', label: 'Steakhouse' },
  seafood: { kind: 'format', label: 'Seafood' },
  hot_pot: { kind: 'format', label: 'Hot Pot' },
  dim_sum: { kind: 'format', label: 'Dim Sum', parent: 'chinese' },
  noodles: { kind: 'format', label: 'Noodles' },
  dumplings: { kind: 'format', label: 'Dumplings' },
  street_food: { kind: 'format', label: 'Street Food' },
  sandwiches: { kind: 'format', label: 'Sandwiches' },
  burger: { kind: 'format', label: 'Burger' },
  bagels: { kind: 'format', label: 'Bagels' },
  fried_chicken: { kind: 'format', label: 'Fried Chicken' },
  bakery: { kind: 'format', label: 'Bakery' },
  pastry: { kind: 'format', label: 'Pastry' },
  dessert: { kind: 'format', label: 'Dessert' },
  ice_cream: { kind: 'format', label: 'Ice Cream' },
  gelato: { kind: 'format', label: 'Gelato' },
  donut: { kind: 'format', label: 'Donut' },

  // ─── venue (primary venue category) ─────────────────────────────────
  coffee: { kind: 'venue', label: 'Coffee' },
  cafe: { kind: 'venue', label: 'Café' },
  tea: { kind: 'venue', label: 'Tea' },
  matcha: { kind: 'venue', label: 'Matcha' },
  bar: { kind: 'venue', label: 'Bar' },
  cocktails: { kind: 'venue', label: 'Cocktails' },
  natural_wine: { kind: 'venue', label: 'Natural Wine' },
  speakeasy: { kind: 'venue', label: 'Speakeasy' },
  hotel: { kind: 'venue', label: 'Hotel' },
  market: { kind: 'venue', label: 'Market' },

  // ─── modifier (cross-cutting style) ─────────────────────────────────
  fusion: { kind: 'modifier', label: 'Fusion' },
  contemporary: { kind: 'modifier', label: 'Contemporary' },
  halal: { kind: 'modifier', label: 'Halal' },
  kosher: { kind: 'modifier', label: 'Kosher' },
  vegetarian: { kind: 'modifier', label: 'Vegetarian' },
  vegan: { kind: 'modifier', label: 'Vegan' },

  // ─── occasion (meal period / service) ───────────────────────────────
  brunch: { kind: 'occasion', label: 'Brunch' },
  breakfast: { kind: 'occasion', label: 'Breakfast' },
  late_night: { kind: 'occasion', label: 'Late Night' },
  happy_hour: { kind: 'occasion', label: 'Happy Hour' },
} as const satisfies Record<string, FeatureDef>;

export type FeatureKey = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && value in FEATURES;
}

export function getFeatureKind(key: FeatureKey): FeatureKind {
  return FEATURES[key].kind;
}

/**
 * Normalize a free-form feature string (legacy tag, post-text phrase, Places
 * type) to a canonical key. Returns null when the input doesn't match any
 * registered feature — caller drops it.
 */
export function mapFeatureFromRaw(raw: string | null | undefined): FeatureKey | null {
  if (!raw) return null;
  const norm = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const hit = FEATURE_SYNONYMS.get(norm);
  if (hit) return hit;

  for (const [pattern, key] of FEATURE_PATTERNS) {
    if (pattern.test(norm)) return key;
  }
  return null;
}

/** Exact-string → feature key, after normalization above. */
const FEATURE_SYNONYMS = new Map<string, FeatureKey>([
  // regions
  ['sichuan', 'sichuan'],
  ['szechuan', 'sichuan'],
  ['szechwan', 'sichuan'],
  ['cantonese', 'cantonese'],
  ['hunan', 'hunan'],
  ['zhejiang', 'zhejiang'],
  ['ningbo', 'ningbo'],
  ['uyghur', 'uyghur'],
  ['taiwanese', 'taiwanese'],
  ['hainanese', 'hainanese'],
  ['dongbei', 'dongbei'],
  ['dongbei northeast chinese', 'dongbei'],
  ['shanghainese', 'shanghainese'],
  ['jiangzhe shanghai', 'shanghainese'],
  ['neapolitan', 'neapolitan'],
  ['neapolitan pizza', 'neapolitan'],
  ['basque', 'basque'],
  ['spanish basque', 'basque'],
  ['greek', 'greek'],
  ['turkish', 'turkish'],
  ['portuguese', 'portuguese'],
  ['scandinavian', 'scandinavian'],
  ['hawaiian', 'hawaiian'],
  ['hawaiian poke', 'hawaiian'],

  // formats
  ['omakase', 'omakase'],
  ['japanese omakase', 'omakase'],
  ['sushi', 'sushi'],
  ['ramen', 'ramen'],
  ['japanese ramen', 'ramen'],
  ['yakitori', 'yakitori'],
  ['japanese yakitori', 'yakitori'],
  ['izakaya', 'izakaya'],
  ['japanese izakaya', 'izakaya'],
  ['yakiniku', 'yakiniku'],
  ['japanese yakiniku', 'yakiniku'],
  ['wagyu', 'wagyu'],
  ['japanese wagyu', 'wagyu'],
  ['pizza', 'pizza'],
  ['italian pizza', 'pizza'],
  ['bbq', 'bbq'],
  ['barbecue', 'bbq'],
  ['steakhouse', 'steakhouse'],
  ['italian steakhouse', 'steakhouse'],
  ['seafood', 'seafood'],
  ['seafood steakhouse', 'seafood'],
  ['hot pot', 'hot_pot'],
  ['hotpot', 'hot_pot'],
  ['dim sum', 'dim_sum'],
  ['noodles', 'noodles'],
  ['southeast asian noodles', 'noodles'],
  ['dumplings', 'dumplings'],
  ['street food', 'street_food'],
  ['snacks', 'street_food'],
  ['sandwiches', 'sandwiches'],
  ['burger', 'burger'],
  ['bagels', 'bagels'],
  ['bagel', 'bagels'],
  ['deli', 'sandwiches'],
  ['salad', 'sandwiches'],
  ['bubble tea', 'tea'],
  ['afternoon tea', 'tea'],
  ['boba', 'tea'],
  ['fried chicken', 'fried_chicken'],
  ['korean fried chicken', 'fried_chicken'],
  ['bakery', 'bakery'],
  ['japanese bakery', 'bakery'],
  ['pastry', 'pastry'],
  ['dessert', 'dessert'],
  ['ice cream', 'ice_cream'],
  ['gelato', 'gelato'],
  ['donut', 'donut'],

  // venue
  ['coffee', 'coffee'],
  ['cafe', 'cafe'],
  ['tea', 'tea'],
  ['matcha', 'matcha'],
  ['bar', 'bar'],
  ['cocktails', 'cocktails'],
  ['natural wine', 'natural_wine'],
  ['speakeasy', 'speakeasy'],
  ['japanese speakeasy', 'speakeasy'],
  ['hotel', 'hotel'],
  ['market', 'market'],

  // modifier
  ['fusion', 'fusion'],
  ['japanese fusion', 'fusion'],
  ['vietnamese fusion', 'fusion'],
  ['french chinese', 'fusion'],
  ['japanese peruvian', 'fusion'],
  ['contemporary', 'contemporary'],
  ['halal', 'halal'],
  ['kosher', 'kosher'],
  ['vegetarian', 'vegetarian'],
  ['vegan', 'vegan'],

  // occasion
  ['brunch', 'brunch'],
  ['breakfast', 'breakfast'],
  ['late night', 'late_night'],
  ['happy hour', 'happy_hour'],
]);

const FEATURE_PATTERNS: Array<[RegExp, FeatureKey]> = [
  [/\bomakase\b/, 'omakase'],
  [/\bramen\b/, 'ramen'],
  [/\byakitori\b/, 'yakitori'],
  [/\bizakaya\b/, 'izakaya'],
  [/\byakiniku\b/, 'yakiniku'],
  [/\bwagyu\b/, 'wagyu'],
  [/\bpizza\b/, 'pizza'],
  [/\bbbq\b/, 'bbq'],
  [/\bsteakhouse\b/, 'steakhouse'],
  [/\bseafood\b/, 'seafood'],
  [/\bhotpot\b|\bhot\s*pot\b/, 'hot_pot'],
  [/\bsichuan\b/, 'sichuan'],
  [/\bcantonese\b/, 'cantonese'],
  [/\bbakery\b/, 'bakery'],
  [/\bcoffee\b/, 'coffee'],
  [/\bcafe\b|\bcafé\b/, 'cafe'],
  [/\bfusion\b/, 'fusion'],
  [/\bcontemporary\b/, 'contemporary'],
  [/\bbrunch\b/, 'brunch'],
];

/**
 * Map a Places (New) primaryType or types entry to a feature key. Scoped to
 * venue/format signals that are useful to surface ("chinese_restaurant"
 * itself is handled by cuisines.ts — this function only emits features).
 */
export function featuresFromPlacesType(type: string | null | undefined): FeatureKey | null {
  if (!type) return null;
  switch (type) {
    case 'coffee_shop': return 'coffee';
    case 'cafe': return 'cafe';
    case 'bar': return 'bar';
    case 'bakery': return 'bakery';
    case 'ice_cream_shop': return 'ice_cream';
    case 'donut_shop': return 'donut';
    case 'pizza_restaurant': return 'pizza';
    case 'ramen_restaurant': return 'ramen';
    case 'sushi_restaurant': return 'sushi';
    case 'steak_house':
    case 'steakhouse': return 'steakhouse';
    case 'barbecue_restaurant': return 'bbq';
    case 'seafood_restaurant': return 'seafood';
    case 'hamburger_restaurant': return 'burger';
    case 'sandwich_shop': return 'sandwiches';
    case 'bagel_shop': return 'bagels';
    case 'dessert_restaurant':
    case 'dessert_shop': return 'dessert';
    case 'tea_house': return 'tea';
    case 'wine_bar': return 'natural_wine';
    case 'cocktail_lounge': return 'cocktails';
    default: return null;
  }
}

/**
 * Translate Places `serves*` boolean flags (servesBrunch, servesCoffee,
 * servesDessert, servesCocktails, servesBreakfast) into feature keys. Caller
 * passes the raw Places `place` object.
 */
export function featuresFromPlacesServes(place: {
  servesBrunch?: boolean;
  servesBreakfast?: boolean;
  servesCoffee?: boolean;
  servesDessert?: boolean;
  servesCocktails?: boolean;
  servesBeer?: boolean;
  servesWine?: boolean;
}): FeatureKey[] {
  const out: FeatureKey[] = [];
  if (place.servesBrunch) out.push('brunch');
  if (place.servesBreakfast) out.push('breakfast');
  if (place.servesCoffee) out.push('coffee');
  if (place.servesDessert) out.push('dessert');
  if (place.servesCocktails) out.push('cocktails');
  return out;
}

/** Dedupe + sort a feature key array. */
export function canonicalizeFeatures(keys: Array<FeatureKey | null | undefined>): FeatureKey[] {
  const set = new Set<FeatureKey>();
  for (const k of keys) {
    if (k && isFeatureKey(k)) set.add(k);
  }
  return Array.from(set).sort();
}
