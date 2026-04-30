#!/usr/bin/env npx tsx
/**
 * Re-classify rows currently marked `cuisine_type = 'other'` against the
 * canonical 18-key taxonomy in `api/_lib/cuisines.ts`. The deterministic
 * token classifier (`scripts/reclassify-cuisines.ts`) couldn't place these
 * rows from `cuisine_type` text alone — many simply lacked enough tokens.
 *
 * Strategy: ask Gemini to pick the single best canonical key given
 * `restaurant_name + address + features[]`. Closed-vocab response schema
 * (one of 18 enum values) so the model can't invent a new key. We keep
 * `other` only when the model is genuinely unsure (it returns `other`
 * itself); we don't apply if the model also returns `other`.
 *
 *   DRY=1 npx tsx scripts/reclassify-other-cuisines.ts   # default — log only
 *   APPLY=1 npx tsx scripts/reclassify-other-cuisines.ts # write to Neon
 *
 * Idempotent: rows that resolve back to `other` are left alone.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { neon } from '@neondatabase/serverless';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { CUISINE_KEYS, CUISINE_DISPLAY, isCuisineKey, type CuisineKey } from '../api/_lib/cuisines';

const APPLY = process.env.APPLY === '1';

const dbUrl =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL;
if (!dbUrl) throw new Error('No Neon connection string in env — run `vercel env pull .env.local --yes` first');
const sql = neon(dbUrl);

const llmKey = process.env.LLM_API_KEY;
if (!llmKey) throw new Error('LLM_API_KEY not set');
const model = new GoogleGenerativeAI(llmKey).getGenerativeModel({
  model: process.env.LLM_MODEL || 'gemini-2.5-flash',
  generationConfig: {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        cuisine: {
          type: SchemaType.STRING,
          enum: [...CUISINE_KEYS],
          description: 'The single best canonical cuisine key.',
        },
        confidence: {
          type: SchemaType.STRING,
          enum: ['high', 'medium', 'low'],
          description: 'Pick high only when the cuisine is unambiguous from the name + address + features.',
        },
        reasoning: { type: SchemaType.STRING },
      },
      required: ['cuisine', 'confidence', 'reasoning'],
    },
  },
});

interface Row {
  id: string;
  restaurant_name: string;
  google_display_name: string | null;
  address: string | null;
  features: string | null;
}

async function classify(row: Row): Promise<{ cuisine: CuisineKey; confidence: string; reasoning: string } | null> {
  const name = row.google_display_name || row.restaurant_name;
  const features: string[] = (() => {
    if (!row.features) return [];
    try {
      const parsed = JSON.parse(row.features);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch { return []; }
  })();

  const cuisineList = CUISINE_KEYS.map((k) => `  - ${k} (${CUISINE_DISPLAY[k]})`).join('\n');
  const prompt = `Pick the single best canonical cuisine key for this NYC restaurant.

Canonical keys (use exactly one):
${cuisineList}

Rules:
  - "american" covers New American / contemporary American / steakhouse / diner / brunch / Southern.
  - "french" covers all French regions, brasseries, bistros.
  - "italian" covers Roman / Tuscan / pizza-focused / pasta-focused.
  - "scandinavian" / "nordic" → use "other" (no canonical key).
  - "georgian" (country) / "filipino" / "balkan" / "german" → use "other".
  - "japanese" covers izakaya / kaiseki / omakase / ramen / sushi / yakitori.
  - When a venue is fusion that clearly leans toward one cuisine, pick that cuisine. When it's truly multi-region with no dominant cuisine, pick "other".
  - Confidence "high" only when the cuisine is unambiguous from name + address + features. If the name is generic and features don't disambiguate, use "low".

Restaurant:
  Name: ${name}
  Address: ${row.address ?? '(none)'}
  Features (sub-cuisines and dish formats already extracted): ${features.length ? features.join(', ') : '(none)'}

Return JSON: { cuisine, confidence, reasoning }`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    if (!isCuisineKey(parsed.cuisine)) return null;
    return {
      cuisine: parsed.cuisine,
      confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'low',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (e) {
    console.error(`  ✗ LLM error for ${name}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function main() {
  const rows = (await sql`
    SELECT id, restaurant_name, google_display_name, address, features
    FROM xhs_restaurants
    WHERE cuisine_type = 'other'
    ORDER BY restaurant_name
  `) as unknown as Row[];

  console.log(`\n=== Reclassify 'other' rows (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${rows.length} rows ===\n`);

  const distribution = new Map<string, number>();
  let applied = 0, kept = 0, errored = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = r.google_display_name || r.restaurant_name;
    const result = await classify(r);

    if (!result) {
      errored++;
      console.log(`  ${i + 1}/${rows.length}  ✗ ${name}  (LLM error / unparseable)`);
      continue;
    }

    distribution.set(result.cuisine, (distribution.get(result.cuisine) ?? 0) + 1);

    // Skip writes when the model also returns 'other' — it's already 'other'
    // and we don't want to flip rows we're not sure about.
    if (result.cuisine === 'other') {
      kept++;
      console.log(`  ${i + 1}/${rows.length}  · ${name}  → other (kept; ${result.confidence}: ${result.reasoning.slice(0, 80)})`);
      continue;
    }

    // Skip low-confidence flips — better to leave as 'other' than to push
    // a wrong category into the user-visible filter.
    if (result.confidence === 'low') {
      kept++;
      console.log(`  ${i + 1}/${rows.length}  · ${name}  → ${result.cuisine} (low conf; KEEPING as other)`);
      continue;
    }

    if (APPLY) {
      await sql`UPDATE xhs_restaurants SET cuisine_type = ${result.cuisine} WHERE id = ${r.id}`;
    }
    applied++;
    const tag = APPLY ? '✓' : '→';
    console.log(`  ${i + 1}/${rows.length}  ${tag} ${name}  →  ${result.cuisine} (${result.confidence})  ${result.reasoning.slice(0, 80)}`);

    // Polite delay so we don't hit the per-minute Gemini rate cap on
    // a longer list. ~600ms between calls is well under the limit.
    await new Promise((res) => setTimeout(res, 600));
  }

  console.log(`\n--- Summary ---`);
  console.log(`  applied (or would apply): ${applied}`);
  console.log(`  kept as other (model said other / low conf): ${kept}`);
  console.log(`  errors: ${errored}`);
  console.log(`\n--- New distribution from this batch ---`);
  [...distribution.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(3)} ${k}`);
  });

  if (!APPLY) {
    console.log(`\n(DRY-RUN — re-run with APPLY=1 to write changes)`);
  } else {
    console.log(`\nDB updated.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
