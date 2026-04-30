import { GoogleGenerativeAI, SchemaType, type GenerativeModel, type Schema } from '@google/generative-ai';
import type { RawXhsPost } from './xhsScraper';
import { logger } from './logger';
import { CUISINE_KEYS, isCuisineKey, type CuisineKey } from './cuisines';
import { FEATURE_KEYS, isFeatureKey, canonicalizeFeatures, type FeatureKey } from './features';

export interface ExtractedRestaurant {
  restaurantName: string;
  address: string | null;
  // Hint extracted from the post (neighborhood/landmark/area) used only to
  // guide the Places search. Not stored in DB — the canonical borough +
  // neighborhood come from Places API / post-processing.
  locationHint: string | null;
  /** Canonical cuisine key picked from the closed vocabulary (see cuisines.ts).
   *  Null when the post describes a non-restaurant venue (coffee shop, bar,
   *  bakery) or nothing in the cuisine list fits. */
  cuisineKey: CuisineKey | null;
  /** Feature keys from features.ts — sub-cuisines, formats, venue types. */
  features: FeatureKey[];
  creatorRecommendation: string | null;
  postUrl: string;
  postCreatedAt: string;
  likes: number;
}

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const key = process.env.LLM_API_KEY;
    if (!key) throw new Error('LLM_API_KEY environment variable is not set');
    client = new GoogleGenerativeAI(key);
  }
  return client;
}

/**
 * Parse a Gemini response tolerantly.
 *
 * Gemini 2.5 Flash *sometimes* ignores `responseMimeType: 'application/json'`
 * and wraps the JSON in prose ("Here is the JSON: {…}") or a markdown code
 * fence. Rather than retrying, we find the outermost `{…}` block and parse
 * that. An empty response throws — the caller retries via the 429 path or
 * degrades to `{cuisineKey: null, features: []}`.
 */
function parseJsonTolerant(raw: string): unknown {
  if (!raw) throw new Error('empty LLM response');

  // Strip markdown code fences if wrapped.
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();

  // Fast path — already clean JSON.
  if (s.startsWith('{') && s.endsWith('}')) {
    return JSON.parse(s);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return JSON.parse(s);
  }

  // Slow path — find the widest balanced JSON value.
  const firstObj = s.indexOf('{');
  const lastObj = s.lastIndexOf('}');
  const firstArr = s.indexOf('[');
  const lastArr = s.lastIndexOf(']');

  const candidates: string[] = [];
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(s.slice(firstObj, lastObj + 1));
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(s.slice(firstArr, lastArr + 1));
  // Prefer the widest candidate — it's the outermost structure.
  candidates.sort((a, b) => b.length - a.length);

  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new Error(`no parseable JSON in LLM response: ${raw.slice(0, 120)}…`);
}

// Gemini wrapper: single place that translates a system+user prompt pair into
// a JSON object. Using `responseMimeType: application/json` puts Gemini in
// strict JSON mode so we don't need to strip markdown code fences or retry on
// malformed output. `LLM_MODEL` env var overrides the default for A/B tests.
//
// 429 handling: Gemini 2.5 Flash free tier is ~10 RPM. When we hit rate
// limits, the SDK throws an Error whose message includes "429" / "quota" /
// "rate"; we pause and retry with exponential backoff, respecting any
// Retry-After-like delay the API suggests in the error body.
const MAX_LLM_ATTEMPTS = 5;

async function generateJson(
  systemInstruction: string,
  userPrompt: string,
  maxOutputTokens: number,
  responseSchema?: Schema
): Promise<unknown> {
  // NB: Gemini 2.5 Flash ignores `responseMimeType: 'application/json'` alone
  // — it frequently returns prose preambles like "Here is the JSON:" with no
  // JSON body. Passing `responseSchema` forces strict schema compliance and
  // is the only reliable way to get structured output from 2.5 Flash today.
  //
  // `thinkingConfig.thinkingBudget: 0` disables the model's default
  // "thinking" pass, which otherwise consumes ~100+ tokens from the output
  // budget before any JSON is generated — our 256-token classifier
  // responses were getting truncated mid-object as a result.
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    maxOutputTokens,
    temperature: 0.1,
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (responseSchema) generationConfig.responseSchema = responseSchema;

  const model: GenerativeModel = getClient().getGenerativeModel({
    model: process.env.LLM_MODEL ?? 'gemini-2.5-flash',
    systemInstruction,
    generationConfig,
  });

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const result = await model.generateContent(userPrompt);
      return parseJsonTolerant(result.response.text());
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const is429 = /\b429\b|rate[\s-]?limit|RESOURCE_EXHAUSTED|quota/i.test(msg);
      if (!is429 || attempt >= MAX_LLM_ATTEMPTS) throw e;

      // Gemini sometimes includes a "retryDelay": "30s" hint in the error
      // payload. Honor it if present, else exponential backoff.
      const hint = msg.match(/"retryDelay"\s*:\s*"(\d+)s/);
      const backoffMs = hint
        ? parseInt(hint[1], 10) * 1000 + 500
        : Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      logger.warn('llm.rate_limited', { attempt, backoffMs });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

const SYSTEM_PROMPT = `You are a restaurant data extractor and classifier. You will be given a social-media post about food in New York City. Extract ALL restaurants mentioned and CLASSIFY each one into the closed vocabularies below. Return valid JSON only.

CUISINE_KEYS (pick ONE per restaurant, or null if nothing fits):
${CUISINE_KEYS.join(', ')}

FEATURE_KEYS (pick ZERO or more per restaurant; only keys from this list):
${FEATURE_KEYS.join(', ')}

Response format (no other text, just JSON):
{
  "isRestaurantPost": true/false,
  "restaurants": [
    {
      "restaurantName": "exact name from post — do NOT translate Chinese names",
      "address": "full street address if explicitly stated, otherwise empty string",
      "locationHint": "neighborhood/area/landmark mentioned in the post, copy as-is",
      "cuisineKey": "one of CUISINE_KEYS, or null if the place isn't primarily a restaurant",
      "features": ["zero or more keys from FEATURE_KEYS"],
      "creatorRecommendation": "what the creator liked, in original language, 1-3 sentences max"
    }
  ]
}

Rules:
- Extract EVERY restaurant mentioned, not just the primary one
- restaurantName: copy exactly as written — do NOT translate
- address: only fill if a full street address is explicitly stated (e.g. "123 Mott St")
- locationHint: neighborhood, area, or landmark (e.g. "Flushing", "下城区") — used only to help find the restaurant
- cuisineKey: MUST be one of CUISINE_KEYS verbatim, or null. Do not invent. Sichuan → chinese. Omakase → japanese. Pizza → italian. Peter-Luger-style steakhouse → american. A coffee-first or bar-first venue → null.
- features: MUST each be a key from FEATURE_KEYS. Use regions (sichuan, cantonese, neapolitan, …) for sub-cuisines, formats (omakase, pizza, ramen, hot_pot, …) for dish specialties, venues (coffee, cafe, bar, speakeasy, …) for venue types, occasions (brunch, breakfast, late_night, …) for service periods, modifiers (fusion, contemporary, halal) for style. Empty array is fine.
- creatorRecommendation: copy creator's words as-is in original language — do NOT translate
- isRestaurantPost: true only if the post is about specific restaurant visits/recommendations`;

const EXTRACT_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    isRestaurantPost: { type: SchemaType.BOOLEAN },
    restaurants: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          restaurantName: { type: SchemaType.STRING },
          address: { type: SchemaType.STRING },
          locationHint: { type: SchemaType.STRING },
          cuisineKey: { type: SchemaType.STRING, nullable: true },
          features: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          creatorRecommendation: { type: SchemaType.STRING },
        },
        required: ['restaurantName'],
      },
    },
  },
  required: ['isRestaurantPost', 'restaurants'],
};

export async function extractRestaurantData(post: RawXhsPost): Promise<ExtractedRestaurant[]> {
  const userPrompt = `Title: ${post.title}
Content: ${post.body}`;

  try {
    const data = (await generateJson(SYSTEM_PROMPT, userPrompt, 4096, EXTRACT_SCHEMA)) as {
      isRestaurantPost: boolean;
      restaurants: Array<{
        restaurantName: string;
        address: string;
        locationHint?: string;
        approximateLocation?: string; // accept legacy name too
        cuisineKey?: string | null;
        cuisineType?: string | null; // accept legacy field
        features?: unknown;
        creatorRecommendation: string;
      }>;
    };

    if (!data.isRestaurantPost || !data.restaurants?.length) {
      return [];
    }

    return data.restaurants
      .filter((r) => r.restaurantName)
      .map((r) => {
        // Accept both the new `cuisineKey` (preferred) and the legacy
        // `cuisineType` field; drop anything that isn't in the closed vocab.
        const rawCuisine = (r.cuisineKey ?? r.cuisineType ?? '').toString().toLowerCase().trim();
        const cuisineKey: CuisineKey | null = isCuisineKey(rawCuisine) ? rawCuisine : null;

        // Features: filter to registry keys only; dedupe + sort.
        const rawFeatures = Array.isArray(r.features) ? r.features : [];
        const features = canonicalizeFeatures(
          rawFeatures.map((f) => (typeof f === 'string' ? f.toLowerCase().trim() : null))
                     .map((f) => (f && isFeatureKey(f) ? f : null)),
        );

        return {
          restaurantName: r.restaurantName,
          address: r.address || null,
          locationHint: r.locationHint || r.approximateLocation || null,
          cuisineKey,
          features,
          creatorRecommendation: r.creatorRecommendation || null,
          postUrl: post.postUrl,
          postCreatedAt: post.createdAt,
          likes: post.likes,
        };
      });
  } catch (e) {
    logger.warn('llm.extract.failed', { noteId: post.noteId, error: String(e) });
    return [];
  }
}

// Process posts sequentially with a small delay.
// Gemini paid Tier 1 = 2000 RPM → 200ms is plenty. Free tier is 5 RPM;
// pass delayMs=13000 when running on the free key to avoid 429s.
export async function extractBatch(
  posts: RawXhsPost[],
  delayMs = 200
): Promise<ExtractedRestaurant[]> {
  const results: ExtractedRestaurant[] = [];

  for (let i = 0; i < posts.length; i++) {
    logger.success('llm.extract.progress', { current: i + 1, total: posts.length });
    const extracted = await extractRestaurantData(posts[i]);
    results.push(...extracted);
    if (i < posts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// ─── Per-mention classifier ──────────────────────────────────────────────
//
// Used by the Resy blog + Eater NY scrapers where the structural pass has
// already handed us a clean (name, quote) pair. We only need classification,
// not extraction — that's a smaller, cheaper, more reliable LLM task than the
// full-post path used by XHS.
//
// Output: {cuisineKey, features}. Both nullable / empty when the quote is
// too sparse to be confident.

export interface MentionClassification {
  cuisineKey: CuisineKey | null;
  features: FeatureKey[];
}

const CLASSIFY_SYSTEM_PROMPT = `You classify NYC restaurants into a closed taxonomy. You will receive a restaurant name and a short editorial paragraph. Return JSON only — no prose.

CUISINE_KEYS (pick exactly ONE, or null if the venue is not a restaurant — e.g. a coffee bar with no food program, or nothing fits):
${CUISINE_KEYS.join(', ')}

FEATURE_KEYS (pick ZERO or more; only keys verbatim from this list):
${FEATURE_KEYS.join(', ')}

Response:
{"cuisineKey": "...", "features": ["..."]}

Rules:
- cuisineKey MUST be one of CUISINE_KEYS or null. Sichuan/Cantonese/Taiwanese → chinese. Omakase/Sushi → japanese. Neapolitan pizza → italian. Peter Luger steakhouse → american. Puerto Rican / Jamaican / Haitian → caribbean. Argentine/Brazilian/Peruvian → latin_american (except peruvian which has its own bucket). Ethiopian/Nigerian/Moroccan → african. Greek/Turkish/Portuguese → mediterranean. Lebanese/Israeli/Persian → middle_eastern.
- features MUST be keys from FEATURE_KEYS. Pick the ones explicitly supported by the text:
  * Sub-cuisine regions (sichuan, cantonese, neapolitan, basque, greek, turkish, hawaiian, etc.)
  * Dish/service formats (omakase, sushi, ramen, pizza, bbq, steakhouse, seafood, hot_pot, dim_sum, noodles, dumplings, bakery, dessert, ice_cream, fried_chicken, burger, sandwiches, bagels, donut)
  * Venue types (coffee, cafe, tea, matcha, bar, cocktails, natural_wine, speakeasy, hotel, market)
  * Modifiers (fusion, contemporary, halal, kosher, vegetarian, vegan) — only when explicitly indicated
  * Occasions (brunch, breakfast, late_night, happy_hour) — only when explicitly served / mentioned
- Do not invent features. If the text only says "great food" return features: [].
- Return at most 5 features — the most salient ones.`;

// Enum-constrained schema — Gemini enforces the vocabulary server-side so
// the LLM can't hallucinate cuisine/feature values outside our taxonomy.
// This is the single most important thing for classifier reliability on
// 2.5 Flash; without `enum` the model happily returns "steakhouse" or
// "Midtown NYC" which our downstream filter drops silently.
const CLASSIFY_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    cuisineKey: {
      type: SchemaType.STRING,
      format: 'enum',
      nullable: true,
      enum: [...CUISINE_KEYS] as unknown as string[],
    },
    features: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.STRING,
        format: 'enum',
        enum: [...FEATURE_KEYS] as unknown as string[],
      },
    },
  },
  required: ['cuisineKey', 'features'],
};

export async function classifyMention(params: {
  name: string;
  authorQuote: string;
  address?: string | null;
}): Promise<MentionClassification> {
  const { name, authorQuote, address } = params;
  const userPrompt = `Restaurant: ${name}
${address ? `Address: ${address}\n` : ''}
Editorial: ${authorQuote}`;

  try {
    const data = (await generateJson(CLASSIFY_SYSTEM_PROMPT, userPrompt, 256, CLASSIFY_SCHEMA)) as {
      cuisineKey?: unknown;
      features?: unknown;
    };

    const rawCuisine = (data.cuisineKey ?? '').toString().toLowerCase().trim();
    const cuisineKey: CuisineKey | null = isCuisineKey(rawCuisine) ? rawCuisine : null;

    const rawFeatures = Array.isArray(data.features) ? data.features : [];
    const features = canonicalizeFeatures(
      rawFeatures
        .map((f) => (typeof f === 'string' ? f.toLowerCase().trim() : null))
        .map((f) => (f && isFeatureKey(f) ? f : null))
    );

    return { cuisineKey, features };
  } catch (e) {
    logger.warn('llm.classify.failed', { name, error: String(e) });
    return { cuisineKey: null, features: [] };
  }
}

export async function classifyMentions<T extends { name: string; authorQuote: string; address?: string | null }>(
  mentions: T[],
  delayMs = 200
): Promise<Array<T & MentionClassification>> {
  const out: Array<T & MentionClassification> = [];
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    logger.success('llm.classify.progress', { current: i + 1, total: mentions.length });
    const c = await classifyMention(m);
    out.push({ ...m, ...c });
    if (i < mentions.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return out;
}

// Array variant of CLASSIFY_SCHEMA — Gemini returns one classification per
// input, in the exact same order. Indices align positionally with the input
// list. We still defensively handle short/long responses in `classifyBatch`.
const CLASSIFY_BATCH_SCHEMA: Schema = {
  type: SchemaType.ARRAY,
  items: CLASSIFY_SCHEMA,
};

const CLASSIFY_BATCH_SYSTEM_PROMPT = `${CLASSIFY_SYSTEM_PROMPT}

You will receive a JSON array of mentions, each with {index, name, address?, editorial}. Return a JSON array of the SAME LENGTH and SAME ORDER, where item N classifies mention N. Do not skip, reorder, or merge entries. Each item shape: {"cuisineKey": "...", "features": ["..."]}.`;

/**
 * Batched classifier — sends `batchSize` mentions per Gemini call (default 10).
 *
 * Why batch: pagination yields ~1,400 candidate mentions, and the free-tier
 * Gemini 2.5 Flash quota is 250 RPD / 10 RPM. One-by-one classification at
 * 7s spacing is 2.7h of LLM time alone; 10-per-batch drops that to ~16 min
 * (140 calls × 7s) and fits the daily cap with headroom.
 *
 * Resilience:
 * - If the LLM returns fewer/more entries than the input batch, we fall back
 *   to per-mention classification for the missing slots so the orchestrator
 *   never silently drops candidates.
 * - On any thrown error (parse failure, schema reject, 5xx after retries),
 *   we ALSO fall back to per-mention so a single bad batch doesn't kill a
 *   long crawl.
 */
export async function classifyMentionsBatch<T extends { name: string; authorQuote: string; address?: string | null }>(
  mentions: T[],
  batchSize = 10,
  interBatchDelayMs = 7000
): Promise<Array<T & MentionClassification>> {
  if (mentions.length === 0) return [];

  const results: Array<T & MentionClassification> = new Array(mentions.length);
  const totalBatches = Math.ceil(mentions.length / batchSize);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * batchSize;
    const slice = mentions.slice(start, start + batchSize);
    logger.success('llm.classify.batch.progress', {
      batch: b + 1,
      totalBatches,
      mentionsInBatch: slice.length,
    });

    const userPrompt = JSON.stringify(
      slice.map((m, i) => ({
        index: i,
        name: m.name,
        ...(m.address ? { address: m.address } : {}),
        editorial: m.authorQuote,
      }))
    );

    type ParsedItem = { cuisineKey?: unknown; features?: unknown };
    let parsed: ParsedItem[] | null = null;
    try {
      // Generous token budget so a 10-mention batch never gets truncated.
      // Each item is small (~30 tokens) so 10 items × ~30 = ~300 + overhead.
      const data = await generateJson(
        CLASSIFY_BATCH_SYSTEM_PROMPT,
        userPrompt,
        1024,
        CLASSIFY_BATCH_SCHEMA
      );
      if (Array.isArray(data)) parsed = data as ParsedItem[];
    } catch (e) {
      logger.warn('llm.classify.batch.failed', { batch: b + 1, error: String(e) });
    }

    for (let i = 0; i < slice.length; i++) {
      const m = slice[i];
      const item: ParsedItem | undefined = parsed?.[i];

      if (item) {
        const rawCuisine = (item.cuisineKey ?? '').toString().toLowerCase().trim();
        const cuisineKey: CuisineKey | null = isCuisineKey(rawCuisine) ? rawCuisine : null;
        const rawFeatures: unknown[] = Array.isArray(item.features) ? item.features : [];
        const features = canonicalizeFeatures(
          rawFeatures
            .map((f) => (typeof f === 'string' ? f.toLowerCase().trim() : null))
            .map((f) => (f && isFeatureKey(f) ? f : null))
        );
        results[start + i] = { ...m, cuisineKey, features };
      } else {
        // Missing slot — fall back to per-mention call. Rare enough to not
        // tank throughput; logging makes it visible.
        logger.warn('llm.classify.batch.fallback_per_mention', {
          batch: b + 1,
          mentionIndex: start + i,
          name: m.name,
        });
        const c = await classifyMention(m);
        results[start + i] = { ...m, ...c };
      }
    }

    if (b < totalBatches - 1) {
      await new Promise((resolve) => setTimeout(resolve, interBatchDelayMs));
    }
  }

  return results;
}
