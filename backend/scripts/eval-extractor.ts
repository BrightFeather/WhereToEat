/**
 * Extractor eval — runs `extractRestaurantData` over labelled fixture posts
 * and scores which restaurants survive vs. which should be dropped.
 *
 *   npx ts-node scripts/eval-extractor.ts                 # all fixture files
 *   CASES=scripts/eval/extractor-cases.json npx ts-node scripts/eval-extractor.ts
 *   ONLY=hotel-stay,lukewarm npx ts-node scripts/eval-extractor.ts
 *
 * Fixture shape: [{ id, why, title, body, expect: { keep: string[], drop: string[] } }]
 * Names in `keep`/`drop` match by normalized substring in either direction
 * ("Los Tacos" matches "Los Tacos No.1").
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { extractRestaurantData } from '../api/_lib/llmExtractor';

interface Case {
  id: string;
  why?: string;
  title: string;
  body: string;
  expect: { keep: string[]; drop: string[] };
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const matches = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

function loadCases(): Case[] {
  const files = process.env.CASES
    ? process.env.CASES.split(',')
    : fs.readdirSync(path.resolve(__dirname, 'eval'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join('scripts/eval', f));
  const all = files.flatMap((f) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')) as Case[]);
  const only = process.env.ONLY?.split(',');
  return only ? all.filter((c) => only.includes(c.id)) : all;
}

async function main() {
  const cases = loadCases();
  let keepHit = 0, keepTotal = 0, dropHit = 0, dropTotal = 0, extras = 0, dirtyRecs = 0;
  const failures: string[] = [];

  for (const c of cases) {
    const out = await extractRestaurantData({
      noteId: c.id, title: c.title, body: c.body, likes: 0,
      postUrl: `eval://${c.id}`, createdAt: new Date().toISOString(),
    });
    const names = out.map((r) => r.restaurantName);
    const problems: string[] = [];

    for (const k of c.expect.keep) {
      keepTotal++;
      if (names.some((n) => matches(n, k))) keepHit++;
      else problems.push(`missing keep "${k}"`);
    }
    for (const d of c.expect.drop) {
      dropTotal++;
      if (!names.some((n) => matches(n, d))) dropHit++;
      else problems.push(`kept drop "${d}"`);
    }
    const expected = [...c.expect.keep, ...c.expect.drop];
    for (const n of names) {
      if (!expected.some((e) => matches(n, e))) { extras++; problems.push(`unexpected "${n}"`); }
    }
    for (const r of out) {
      const rec = r.creatorRecommendation ?? '';
      if (/\[话题\]|#\S|📍|⏰|☎️|💰/.test(rec)) { dirtyRecs++; problems.push(`dirty rec on "${r.restaurantName}": ${rec.slice(0, 60)}`); }
    }

    const status = problems.length ? 'FAIL' : 'ok  ';
    console.log(`${status} ${c.id.padEnd(26)} → [${out.map((r) => {
      const en = (r as { englishName?: string | null }).englishName; // added by the PARSE-7 prompt rewrite
      return r.restaurantName + (en ? ` (${en})` : '');
    }).join(', ')}]`);
    for (const p of problems) console.log(`       · ${p}`);
    if (problems.length) failures.push(c.id);
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : 'n/a');
  console.log('\n─── Summary ───');
  console.log(`cases:        ${cases.length - failures.length}/${cases.length} clean`);
  console.log(`keep recall:  ${keepHit}/${keepTotal} (${pct(keepHit, keepTotal)})`);
  console.log(`drop correct: ${dropHit}/${dropTotal} (${pct(dropHit, dropTotal)})`);
  console.log(`unexpected:   ${extras}`);
  console.log(`dirty recs:   ${dirtyRecs}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
