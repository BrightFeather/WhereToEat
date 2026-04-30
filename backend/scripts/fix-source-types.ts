#!/usr/bin/env npx tsx
/**
 * Re-derive `xhs_sources.source_type` from `post_url` so legacy rows that
 * were written with the default `xiaohongshu` value (or otherwise misclassified
 * during ingest) get the right badge in the iOS app.
 *
 *   xiaohongshu.com / xhslink → xiaohongshu
 *   eater.com                 → eater
 *   resy.com (incl blog.resy) → resy_blog
 *
 * Idempotent: rows that already match keep their value. Anything that doesn't
 * match a known domain is left alone (and logged) — surface unknowns rather
 * than silently coercing them.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { neon } from '@neondatabase/serverless';

const url =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL;
if (!url) throw new Error('No Neon connection string in env — run `vercel env pull` first');
const sql = neon(url);

interface Row { id: string; source_type: string | null; post_url: string }

function classify(postUrl: string): string | null {
  const u = postUrl.toLowerCase();
  if (u.includes('xiaohongshu.com') || u.includes('xhslink.')) return 'xiaohongshu';
  if (u.includes('eater.com'))                                  return 'eater';
  if (u.includes('resy.com'))                                   return 'resy_blog';
  return null;
}

async function main() {
  const rows = (await sql`
    SELECT id, source_type, post_url FROM xhs_sources
  `) as unknown as Row[];

  let fixed = 0, alreadyOk = 0, unknown = 0;

  for (const r of rows) {
    const correct = classify(r.post_url);
    if (correct === null) {
      unknown++;
      console.warn(`  ? unknown domain: ${r.post_url} (left as ${r.source_type})`);
      continue;
    }
    if (r.source_type === correct) {
      alreadyOk++;
      continue;
    }
    await sql`
      UPDATE xhs_sources
      SET source_type = ${correct}
      WHERE id = ${r.id}
    `;
    fixed++;
    console.log(`  ✓ ${r.id.slice(0, 8)}  ${r.source_type ?? 'null'} → ${correct}  (${r.post_url})`);
  }

  console.log(`\n[fix-source-types] fixed=${fixed}  already-correct=${alreadyOk}  unknown=${unknown}  total=${rows.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
