/**
 * Canonical cuisine taxonomy (single source of truth for the backend).
 *
 * Mirrors `ios/WhereToEat/Models/CuisineTag.swift` + three new keys the iOS
 * enum gets at the same time. When the Swift enum grows a case, update this
 * list in lockstep so LLM + Places enrichment and the iOS filter agree.
 *
 * Granularity note: this list is intentionally coarse. Regional sub-cuisines
 * (Sichuan, Cantonese, Neapolitan, Basque, …) and dish formats (Omakase,
 * Ramen, Pizza, BBQ, …) live in `features.ts`, not here. See the
 * "Cuisine vs feature" section in SPEC.md for the split rationale.
 */

export const CUISINE_KEYS = [
  'french',
  'italian',
  'japanese',
  'chinese',
  'korean',
  'mexican',
  'american',
  'mediterranean',
  'thai',
  'indian',
  'vietnamese',
  'spanish',
  'middle_eastern',
  'peruvian',
  'latin_american',
  'caribbean',
  'african',
  'other',
] as const;

export type CuisineKey = typeof CUISINE_KEYS[number];

export const CUISINE_DISPLAY: Record<CuisineKey, string> = {
  french: 'French',
  italian: 'Italian',
  japanese: 'Japanese',
  chinese: 'Chinese',
  korean: 'Korean',
  mexican: 'Mexican',
  american: 'American',
  mediterranean: 'Mediterranean',
  thai: 'Thai',
  indian: 'Indian',
  vietnamese: 'Vietnamese',
  spanish: 'Spanish',
  middle_eastern: 'Middle Eastern',
  peruvian: 'Peruvian',
  latin_american: 'Latin American',
  caribbean: 'Caribbean',
  african: 'African',
  other: 'Other',
};

export function isCuisineKey(value: unknown): value is CuisineKey {
  return typeof value === 'string' && (CUISINE_KEYS as readonly string[]).includes(value);
}

/**
 * Map a free-form cuisine string (legacy DB value, LLM echo, Places type) to
 * a canonical key. Returns null when the raw input isn't a cuisine at all —
 * e.g. "Coffee", "Bar", "Perfume/Retail" — so the caller can redirect those
 * to `features`.
 *
 * Matching is deterministic and case/punctuation-insensitive. First hit wins
 * since XHS-authored compound tags ("Japanese, Korean BBQ") list primary
 * cuisine first.
 */
export function mapCuisineFromRaw(raw: string | null | undefined): CuisineKey | null {
  if (!raw) return null;
  const tokens = raw
    .split(/[,/&]|\bor\b/i)
    .map(normalize)
    .filter(Boolean);
  for (const t of tokens) {
    const hit = CUISINE_SYNONYMS.get(t);
    if (hit) return hit;
    for (const [pattern, key] of CUISINE_PATTERNS) {
      if (pattern.test(t)) return key;
    }
  }
  return null;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact-string synonyms (after normalization). */
const CUISINE_SYNONYMS = new Map<string, CuisineKey>([
  // Direct hits
  ['french', 'french'],
  ['italian', 'italian'],
  ['japanese', 'japanese'],
  ['chinese', 'chinese'],
  ['korean', 'korean'],
  ['mexican', 'mexican'],
  ['american', 'american'],
  ['mediterranean', 'mediterranean'],
  ['thai', 'thai'],
  ['indian', 'indian'],
  ['vietnamese', 'vietnamese'],
  ['spanish', 'spanish'],
  ['middle eastern', 'middle_eastern'],
  ['peruvian', 'peruvian'],
  ['latin american', 'latin_american'],
  ['caribbean', 'caribbean'],
  ['african', 'african'],

  // Chinese regional rollups
  ['cantonese', 'chinese'],
  ['sichuan', 'chinese'],
  ['szechuan', 'chinese'],
  ['szechwan', 'chinese'],
  ['hunan', 'chinese'],
  ['zhejiang', 'chinese'],
  ['ningbo', 'chinese'],
  ['uyghur', 'chinese'],
  ['taiwanese', 'chinese'],
  ['hainanese', 'chinese'],
  ['dongbei', 'chinese'],
  ['dongbei northeast chinese', 'chinese'],
  ['jiangzhe shanghai', 'chinese'],
  ['shanghainese', 'chinese'],
  ['dim sum', 'chinese'],

  // Japanese rollups
  ['omakase', 'japanese'],
  ['sushi', 'japanese'],
  ['ramen', 'japanese'],
  ['yakitori', 'japanese'],
  ['izakaya', 'japanese'],
  ['yakiniku', 'japanese'],
  ['wagyu', 'japanese'],

  // Italian rollups
  ['pizza', 'italian'],
  ['neapolitan pizza', 'italian'],
  ['italian pizza', 'italian'],

  // Korean rollups
  ['korean bbq', 'korean'],
  ['korean fried chicken', 'korean'],

  // American rollups
  ['steakhouse', 'american'],
  ['burger', 'american'],
  ['fried chicken', 'american'],
  ['bagels', 'american'],
  ['sandwiches', 'american'],
  ['hawaiian poke', 'american'],
  ['hawaiian', 'american'],
  ['poke', 'american'],
  ['bbq', 'american'],
  ['barbecue', 'american'],

  // Latin rollups
  ['cuban', 'latin_american'],
  ['argentine', 'latin_american'],
  ['argentinian', 'latin_american'],
  ['brazilian', 'latin_american'],
  ['colombian', 'latin_american'],
  ['venezuelan', 'latin_american'],
  ['dominican', 'caribbean'],
  ['puerto rican', 'caribbean'],
  ['jamaican', 'caribbean'],
  ['haitian', 'caribbean'],
  ['trinidadian', 'caribbean'],

  // African rollups
  ['ethiopian', 'african'],
  ['nigerian', 'african'],
  ['moroccan', 'african'],
  ['senegalese', 'african'],

  // Mediterranean / ME rollups
  ['greek', 'mediterranean'],
  ['turkish', 'mediterranean'],
  ['lebanese', 'middle_eastern'],
  ['israeli', 'middle_eastern'],
  ['persian', 'middle_eastern'],
  ['iranian', 'middle_eastern'],
  ['halal', 'middle_eastern'],

  // SE Asian rollups (no dedicated bucket — nearest neighbor)
  ['southeast asian', 'thai'],
  ['southeast asian noodles', 'thai'],
  ['filipino', 'other'],
  ['indonesian', 'other'],
  ['malaysian', 'other'],
  ['singaporean', 'other'],

  // Misc
  ['portuguese', 'mediterranean'],
  ['scandinavian', 'other'],
  ['german', 'other'],
  ['russian', 'other'],
  ['ukrainian', 'other'],
]);

/**
 * Fallback regexes for compound tags not caught above ("Japanese Ramen",
 * "Italian Steakhouse", "Vietnamese Fusion"). Order matters — first match wins.
 */
const CUISINE_PATTERNS: Array<[RegExp, CuisineKey]> = [
  [/\bjapanese\b/, 'japanese'],
  [/\bchinese\b/, 'chinese'],
  [/\bkorean\b/, 'korean'],
  [/\bitalian\b/, 'italian'],
  [/\bfrench\b/, 'french'],
  [/\bthai\b/, 'thai'],
  [/\bvietnamese\b/, 'vietnamese'],
  [/\bmexican\b/, 'mexican'],
  [/\bspanish\b/, 'spanish'],
  [/\bindian\b/, 'indian'],
  [/\bperuvian\b/, 'peruvian'],
  [/\bmediterranean\b/, 'mediterranean'],
  [/\bmiddle\s*east/, 'middle_eastern'],
  [/\bamerican\b/, 'american'],
  [/\blatin\b/, 'latin_american'],
  [/\bcaribbean\b/, 'caribbean'],
  [/\bafrican\b/, 'african'],
];
