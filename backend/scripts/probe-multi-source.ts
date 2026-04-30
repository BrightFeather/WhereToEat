/**
 * Small-sample validation probe for the Resy blog + Eater NY scrapers.
 *
 * Runs the structural extractors against 6 curated URLs (3 Resy, 3 Eater)
 * spanning the different article shapes we expect to handle, and prints
 * structured JSON to stdout so output can be eyeballed for correctness
 * before we wire up pagination or DB writes.
 *
 * Run:
 *   cd backend
 *   npx ts-node scripts/probe-multi-source.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import * as fs from 'fs';
import { readResyBlogPost } from '../api/_lib/resyBlogScraper';
import { readEaterArticle } from '../api/_lib/eaterScraper';
import { classifyMention } from '../api/_lib/llmExtractor';

const OUTPUT_PATH = path.resolve(__dirname, '../data/probe-multi-source.json');
const CLASSIFY = process.argv.includes('--classify');
// Gemini 2.5 Flash free tier = 10 RPM. 7s spacing = ~8.5 RPM — safely under,
// with the 429-retry in generateJson as a backstop. Override with
// CLASSIFY_DELAY_MS=200 env var when running against a paid key.
const CLASSIFY_DELAY_MS = parseInt(process.env.CLASSIFY_DELAY_MS ?? '7000', 10);

async function classifyAll<T extends { name: string; authorQuote: string; address?: string | null }>(
  mentions: T[]
): Promise<Array<T & { cuisineKey: string | null; features: string[] }>> {
  const out: Array<T & { cuisineKey: string | null; features: string[] }> = [];
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    process.stderr.write(`    classify ${i + 1}/${mentions.length} — ${m.name.slice(0, 40)}\r`);
    const c = await classifyMention({
      name: m.name,
      authorQuote: m.authorQuote,
      address: m.address ?? null,
    });
    out.push({ ...m, cuisineKey: c.cuisineKey, features: c.features });
    if (i < mentions.length - 1) {
      await new Promise((r) => setTimeout(r, CLASSIFY_DELAY_MS));
    }
  }
  process.stderr.write('\n');
  return out;
}

const RESY_URLS = [
  // Listicle — numbered <h2>N. Name</h2> sections, ~9 venue anchors
  'https://blog.resy.com/2025/12/nyc-restaurants-2025/',
  // Single-restaurant post — og:title = "Dean's Is an Ode to the British Pub"
  'https://blog.resy.com/2026/03/deans-nyc/',
  // Another single-restaurant post — "Arthur Wants to Be Your New Favorite..."
  'https://blog.resy.com/2026/04/arthur-nyc/',
];

const EATER_URLS = [
  // Heatmap — "The Best Classic Restaurants in NYC" (latest, 20+ h2 sections)
  'https://ny.eater.com/maps/classic-restaurants-nyc',
  // Heatmap — steakhouses
  'https://ny.eater.com/maps/best-nyc-steakhouse-classic',
  // News-style review (expected: 0 structural mentions — negative control)
  'https://ny.eater.com/dining-report/410821/carversteak-midtown-steakhouse-review',
];

function truncate(s: string, n: number): string {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n) + '…';
}

async function main() {
  const report: Record<string, unknown> = {
    runAt: new Date().toISOString(),
    resy: [] as unknown[],
    eater: [] as unknown[],
  };

  console.error('\n=== RESY BLOG ===\n');
  for (const url of RESY_URLS) {
    console.error(`→ ${url}`);
    try {
      const post = await readResyBlogPost(url);
      if (!post) throw new Error('null result');
      let flat = post.mentions.map((m) => ({
        name: m.restaurantName,
        detectionMethod: m.detectionMethod,
        resyVenueId: m.resy?.venueId ?? null,
        resyBookingUrl: m.resy?.bookingUrl ?? null,
        latLng: m.lat != null && m.lng != null ? `${m.lat},${m.lng}` : null,
        address: null as string | null,
        authorQuote: m.authorQuote,
        authorQuoteLen: m.authorQuote.length,
      }));
      let classified: Array<typeof flat[number] & { cuisineKey?: string | null; features?: string[] }> = flat;
      if (CLASSIFY && flat.length) {
        classified = await classifyAll(flat);
      }
      (report.resy as unknown[]).push({
        url: post.postUrl,
        title: post.postTitle,
        author: post.postAuthor,
        publishedAt: post.publishedAt,
        postType: post.postType,
        mentionCount: post.mentions.length,
        mentions: classified.map((m) => ({
          ...m,
          authorQuote: truncate(m.authorQuote, 400),
        })),
      });
      console.error(`  ok — ${post.mentions.length} mention(s)`);
    } catch (e) {
      (report.resy as unknown[]).push({ url, error: String(e) });
      console.error(`  FAILED — ${e}`);
    }
  }

  console.error('\n=== EATER NY ===\n');
  for (const url of EATER_URLS) {
    console.error(`→ ${url}`);
    try {
      const post = await readEaterArticle(url);
      let flat = post.mentions.map((m) => ({
        name: m.restaurantName,
        slug: m.slug,
        address: m.address,
        authorQuote: m.authorQuote,
        authorQuoteLen: m.authorQuote.length,
      }));
      let classified: Array<typeof flat[number] & { cuisineKey?: string | null; features?: string[] }> = flat;
      if (CLASSIFY && flat.length) {
        classified = await classifyAll(flat);
      }
      (report.eater as unknown[]).push({
        url: post.postUrl,
        title: post.postTitle,
        author: post.postAuthor,
        publishedAt: post.publishedAt,
        postType: post.postType,
        mentionCount: post.mentions.length,
        mentions: classified.map((m) => ({
          ...m,
          authorQuote: truncate(m.authorQuote, 400),
        })),
      });
      console.error(`  ok — ${post.mentions.length} mention(s)`);
    } catch (e) {
      (report.eater as unknown[]).push({ url, error: String(e) });
      console.error(`  FAILED — ${e}`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.error(`\nwrote ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
