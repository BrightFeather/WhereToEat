/**
 * Reclassify every row's `cuisine_type` against the canonical 17-key enum
 * (api/_lib/cuisines.ts) and populate `features` (api/_lib/features.ts).
 *
 * Dry-run by default:
 *   npx ts-node scripts/reclassify-cuisines.ts
 *
 * Apply changes:
 *   APPLY=1 npx ts-node scripts/reclassify-cuisines.ts
 *
 * Strategy is deterministic + no-API:
 *   1. Split the current `cuisine_type` on commas/slashes.
 *   2. For each token:
 *        - Try mapCuisineFromRaw → first canonical cuisine wins → cuisine_type.
 *        - Try mapFeatureFromRaw → canonical feature accumulates to features[].
 *   3. Leftover unmatched tokens log out for manual review.
 *
 * This runs against the local SQLite DB. For Neon, port the same loop — the
 * rules + registries are pure functions and identical across dialects.
 */
import Database from 'better-sqlite3';
import path from 'path';
import * as dotenv from 'dotenv';
import { mapCuisineFromRaw, type CuisineKey } from '../api/_lib/cuisines';
import { mapFeatureFromRaw, canonicalizeFeatures, type FeatureKey } from '../api/_lib/features';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const APPLY = process.env.APPLY === '1';
const db = new Database(path.join(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');

interface Row {
  id: string;
  restaurant_name: string;
  cuisine_type: string | null;
  features: string | null;
}

function splitTokens(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,/&]|\bor\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function classify(raw: string | null): {
  cuisineKey: CuisineKey | null;
  features: FeatureKey[];
  unresolved: string[];
} {
  const tokens = splitTokens(raw);
  let cuisineKey: CuisineKey | null = null;
  const features: FeatureKey[] = [];
  const unresolved: string[] = [];

  for (const token of tokens) {
    const c = mapCuisineFromRaw(token);
    const f = mapFeatureFromRaw(token);

    // Whole-token could map to either a cuisine, a feature, or both (e.g.
    // "Sichuan" → cuisine:chinese AND feature:sichuan). Record both.
    if (c && !cuisineKey) cuisineKey = c;
    if (f) features.push(f);

    if (!c && !f) unresolved.push(token);
  }

  return {
    cuisineKey,
    features: canonicalizeFeatures(features),
    unresolved,
  };
}

function main() {
  const rows = db.prepare(`
    SELECT id, restaurant_name, cuisine_type, features FROM xhs_restaurants
  `).all() as Row[];

  const update = db.prepare(`
    UPDATE xhs_restaurants SET cuisine_type = ?, features = ? WHERE id = ?
  `);

  const cuisineCounts = new Map<string, number>();
  const featureCounts = new Map<string, number>();
  const unresolvedCounts = new Map<string, number>();
  let changed = 0;
  let unchanged = 0;
  const examples: Array<{ name: string; raw: string | null; cuisine: string | null; features: string[] }> = [];

  for (const r of rows) {
    const { cuisineKey, features, unresolved } = classify(r.cuisine_type);

    const cuisineStr = cuisineKey ?? null;
    const featuresStr = features.length ? JSON.stringify(features) : null;

    const differs = (cuisineStr !== r.cuisine_type) || (featuresStr !== r.features);
    if (differs) changed++;
    else unchanged++;

    const cKey = cuisineStr ?? '∅ (null)';
    cuisineCounts.set(cKey, (cuisineCounts.get(cKey) ?? 0) + 1);
    for (const f of features) featureCounts.set(f, (featureCounts.get(f) ?? 0) + 1);
    for (const u of unresolved) unresolvedCounts.set(u, (unresolvedCounts.get(u) ?? 0) + 1);

    if (examples.length < 20 && differs) {
      examples.push({ name: r.restaurant_name, raw: r.cuisine_type, cuisine: cuisineStr, features });
    }

    if (APPLY && differs) {
      update.run(cuisineStr, featuresStr, r.id);
    }
  }

  console.log(`\n=== Reclassify (${APPLY ? 'APPLY' : 'dry-run'}) — ${rows.length} rows ===`);
  console.log(`Changed:   ${changed}`);
  console.log(`Unchanged: ${unchanged}`);

  console.log('\n--- Cuisine distribution (after) ---');
  [...cuisineCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(4)} ${k}`);
  });

  console.log('\n--- Feature distribution ---');
  [...featureCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(4)} ${k}`);
  });

  if (unresolvedCounts.size) {
    console.log('\n--- Unresolved raw tokens (dropped) ---');
    [...unresolvedCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
      console.log(`  ${String(n).padStart(4)} ${k}`);
    });
  }

  console.log('\n--- Sample changes ---');
  for (const e of examples) {
    const feat = e.features.length ? `[${e.features.join(', ')}]` : '[]';
    console.log(`  ${e.name}`);
    console.log(`     was: ${e.raw ?? '∅'}`);
    console.log(`     now: cuisine=${e.cuisine ?? '∅'}  features=${feat}`);
  }

  if (!APPLY) {
    console.log('\n(dry-run — re-run with APPLY=1 to write changes)');
  } else {
    console.log('\nDB updated.');
  }
  db.close();
}

main();
