import type { RawXhsPost } from './xhsScraper';
import { logger } from './logger';
import { CUISINE_KEYS, isCuisineKey, type CuisineKey } from './cuisines';
import { FEATURE_KEYS, isFeatureKey, canonicalizeFeatures, type FeatureKey } from './features';
import { deepseekJson } from './deepseek';

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

const SYSTEM_PROMPT = `You are a restaurant data extractor and classifier. You will be given a social-media post about food in New York City. Extract ALL restaurants mentioned and CLASSIFY each one into the closed vocabularies below. Return valid JSON only.

CUISINE_KEYS (pick ONE per restaurant, or null if nothing fits):
${CUISINE_KEYS.join(', ')}

FEATURE_KEYS (pick ZERO or more per restaurant; only keys from this list):
${FEATURE_KEYS.join(', ')}

ALSO classify the post as a whole on whether it contains ANY complaint about ANY mentioned restaurant — ANY criticism, "don't go", "skip it", "wasn't worth it", "service was bad", "food was mid", "underwhelming", "not great", "would not recommend", lukewarm "okay" descriptions, mixed reviews, etc. Strict: a single negative remark or hedged endorsement counts as a complaint.

Response format (no other text, just JSON):
{
  "isRestaurantPost": true/false,
  "hasComplaint": true/false,
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
- isRestaurantPost: true only if the post is about specific restaurant visits/recommendations
- hasComplaint: be aggressive — when in doubt, true.`;

/**
 * Extract restaurants from an XHS post via DeepSeek-V4-Pro.
 *
 * If the post contains ANY complaint (`hasComplaint: true`), this returns
 * `[]` so the entire post is dropped at ingest. The user's rule is "drop on
 * any complains" — so we err on the side of dropping.
 */
export async function extractRestaurantData(post: RawXhsPost): Promise<ExtractedRestaurant[]> {
  const userPrompt = `Title: ${post.title}
Content: ${post.body}`;

  try {
    const data = (await deepseekJson(SYSTEM_PROMPT, userPrompt, 4096)) as {
      isRestaurantPost: boolean;
      hasComplaint?: boolean;
      restaurants: Array<{
        restaurantName: string;
        address: string;
        locationHint?: string;
        approximateLocation?: string;
        cuisineKey?: string | null;
        cuisineType?: string | null;
        features?: unknown;
        creatorRecommendation: string;
      }>;
    };

    if (!data.isRestaurantPost || !data.restaurants?.length) {
      return [];
    }

    if (data.hasComplaint === true) {
      logger.success('llm.extract.dropped_negative_post', { noteId: post.noteId });
      return [];
    }

    return data.restaurants
      .filter((r) => r.restaurantName)
      .map((r) => {
        const rawCuisine = (r.cuisineKey ?? r.cuisineType ?? '').toString().toLowerCase().trim();
        const cuisineKey: CuisineKey | null = isCuisineKey(rawCuisine) ? rawCuisine : null;

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

// DeepSeek paid tier is high RPM; 200ms delay is plenty.
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
- cuisineKey MUST be one of CUISINE_KEYS or null. Sichuan/Cantonese/Taiwanese → chinese. Omakase/Sushi → japanese. Neapolitan pizza → italian. Peter Luger steakhouse → american. Puerto Rican / Jamaican / Haitian → caribbean. Argentine/Brazilian → latin_american (peruvian has its own bucket). Ethiopian/Nigerian/Moroccan → african. Greek/Turkish/Portuguese → mediterranean. Lebanese/Israeli/Persian → middle_eastern.
- features MUST be keys from FEATURE_KEYS. Pick the ones explicitly supported by the text.
- Do not invent features. If the text only says "great food" return features: [].
- Return at most 5 features — the most salient ones.`;

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
    const data = (await deepseekJson(CLASSIFY_SYSTEM_PROMPT, userPrompt, 256)) as {
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

const CLASSIFY_BATCH_SYSTEM_PROMPT = `${CLASSIFY_SYSTEM_PROMPT}

You will receive a JSON array of mentions, each with {index, name, address?, editorial}. Return JSON: {"results": [...]} where the results array has the SAME LENGTH and SAME ORDER as input. Each item: {"cuisineKey": "...", "features": ["..."]}. Do not skip, reorder, or merge entries.`;

/**
 * Batched classifier — sends `batchSize` mentions per DeepSeek call.
 * On any failure (parse, schema, 5xx), falls back to per-mention so a single
 * bad batch can't kill a long crawl.
 */
export async function classifyMentionsBatch<T extends { name: string; authorQuote: string; address?: string | null }>(
  mentions: T[],
  batchSize = 10,
  interBatchDelayMs = 1500
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
      const data = await deepseekJson(CLASSIFY_BATCH_SYSTEM_PROMPT, userPrompt, 1024);
      const arr = (data as { results?: unknown })?.results ?? data;
      if (Array.isArray(arr)) parsed = arr as ParsedItem[];
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

// ─── Sentiment / complaint classifier ────────────────────────────────────

const COMPLAINT_SYSTEM_PROMPT = `You read short social-media posts about NYC restaurants. Your job is to decide whether the post contains a complaint, criticism, or hedged endorsement DIRECTED AT a specific target restaurant.

You will be given the target restaurant name. Posts often mention many restaurants — IGNORE complaints about other restaurants. Only flag if the post is negative or hedged about THE TARGET.

Return JSON only:
{"hasComplaint": true|false, "reason": "<one short phrase, mentions target if flagged>"}

ANY of the following counts as a complaint about the target:
- direct criticism ("不好吃", "踩雷", "难吃", "失望", "wouldn't go back", "skip it", "overrated", "underwhelming", "not great", "service was bad", "wasn't worth it")
- mixed reviews about the target ("food great but service bad")
- lukewarm endorsement ("just okay", "fine", "nothing special", "alright")
- warnings ("avoid", "don't bother")
- "X is not as good as Y" where the target is X
- venting about the target (wait, prices, attitude, hygiene)

Pure positive recommendations of the target ("超推荐", "loved it", "best meal of my life", "must-try") → hasComplaint: false.
Post is about other restaurants, target only listed/mentioned in passing → hasComplaint: false.

When in doubt about the target specifically, return hasComplaint: true.`;

export interface ComplaintVerdict {
  hasComplaint: boolean;
  reason: string;
}

export async function classifyComplaint(args: {
  title: string;
  body: string;
  restaurantName?: string;
}): Promise<ComplaintVerdict> {
  const { title, body, restaurantName } = args;
  const userPrompt = [
    restaurantName ? `Restaurant of interest: ${restaurantName}` : '',
    `Title: ${title}`,
    `Content: ${body}`,
  ].filter(Boolean).join('\n');

  try {
    const data = (await deepseekJson(COMPLAINT_SYSTEM_PROMPT, userPrompt, 128)) as {
      hasComplaint?: unknown;
      reason?: unknown;
    };
    return {
      hasComplaint: data.hasComplaint === true,
      reason: typeof data.reason === 'string' ? data.reason : '',
    };
  } catch (e) {
    logger.warn('llm.complaint.failed', { error: String(e) });
    // Fail closed — if we can't classify, treat as suspicious and drop.
    return { hasComplaint: true, reason: 'classifier_failed' };
  }
}
