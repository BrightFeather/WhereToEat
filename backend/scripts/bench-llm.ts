/**
 * LLM provider benchmark for the XHS extractor.
 *
 *   FIREWORKS_API_KEY_FILE=~/path/to/key N=20 npx ts-node -T scripts/bench-llm.ts
 *
 * Runs the real `extractRestaurantData` prompt over N cached posts
 * (half NYC, half Bay Area) for each config, sequentially per config so
 * latencies are clean, then compares each config to DeepSeek V4-Pro (direct),
 * the current production extractor: latency, restaurant-name agreement,
 * cuisine agreement, and posts dropped for complaints / non-restaurant.
 * Writes data/bench-llm-<ts>.json.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true } as dotenv.DotenvConfigOptions);

import { extractRestaurantData, type ExtractedRestaurant } from '../api/_lib/llmExtractor';
import type { RawXhsPost } from '../api/_lib/xhsScraper';

interface Config { label: string; provider: 'deepseek' | 'fireworks'; model?: string }
const CONFIGS: Config[] = [
  { label: 'deepseek-v4-pro (direct, current)', provider: 'deepseek' },
  { label: 'fireworks deepseek-v4p1-flash', provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4p1-flash' },
  { label: 'fireworks v4p1-flash ultrafast router', provider: 'fireworks', model: 'accounts/fireworks/routers/deepseek-v4p1-flash-1017-ultrafast' },
];
const N = Number(process.env.N ?? 20);

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/xhs-raw', f), 'utf8')) as RawXhsPost[];

async function main() {
  const nyc = load('posts-nyc.json'), bay = load('posts-bay.json');
  // Deterministic spread across the like-ranked lists.
  const pick = (arr: RawXhsPost[], k: number) => Array.from({ length: k }, (_, i) => arr[Math.floor((i * arr.length) / k)]);
  const posts: Array<{ post: RawXhsPost; city: string }> = [
    ...pick(nyc, Math.ceil(N / 2)).map((post) => ({ post, city: 'nyc' })),
    ...pick(bay, Math.floor(N / 2)).map((post) => ({ post, city: 'bay' })),
  ];

  const results: Record<string, { ms: number[]; out: ExtractedRestaurant[][] }> = {};
  // Baseline outputs: the pipeline's cached V4-Pro extractions (no cache file
  // = Pro returned []). Pro is slow (~1 min/post on long posts), so it is
  // re-run live only on PRO_LATENCY_SAMPLES posts, for timing.
  const cacheFor = (p: RawXhsPost, city: string) => path.resolve(__dirname, `../data/xhs-raw/extract/${city}-v1/${p.noteId}.json`);
  const proOut = posts.map(({ post, city }) => fs.existsSync(cacheFor(post, city)) ? JSON.parse(fs.readFileSync(cacheFor(post, city), 'utf8')) : []);
  const proSamples = Number(process.env.PRO_LATENCY_SAMPLES ?? 5);
  for (const cfg of CONFIGS) {
    if (cfg.provider === 'deepseek') {
      process.env.LLM_PROVIDER = 'deepseek';
      const ms: number[] = [];
      process.stdout.write(`${cfg.label}: outputs from pipeline cache; timing ${proSamples} live calls `);
      for (const { post, city } of posts.slice(0, proSamples)) {
        const t0 = Date.now(); await extractRestaurantData(post, city); ms.push(Date.now() - t0); process.stdout.write('.');
      }
      console.log(' done');
      results[cfg.label] = { ms, out: proOut };
      continue;
    }
    process.env.LLM_PROVIDER = cfg.provider;
    if (cfg.model) process.env.FIREWORKS_MODEL = cfg.model; else delete process.env.FIREWORKS_MODEL;
    const r = { ms: [] as number[], out: [] as ExtractedRestaurant[][] };
    process.stdout.write(`${cfg.label}: `);
    for (const { post, city } of posts) {
      const t0 = Date.now();
      r.out.push(await extractRestaurantData(post, city));
      r.ms.push(Date.now() - t0);
      process.stdout.write('.');
    }
    console.log(' done');
    results[cfg.label] = r;
  }

  const base = results[CONFIGS[0].label];
  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  console.log(`\n${posts.length} posts (${Math.ceil(N / 2)} NYC + ${Math.floor(N / 2)} Bay). Agreement is vs ${CONFIGS[0].label}.\n`);
  console.log('config'.padEnd(40), 'mean s'.padStart(7), 'p50 s'.padStart(6), 'p90 s'.padStart(6), 'total s'.padStart(8), ' restos', ' emptyPosts', ' nameAgree', ' cuisineAgree');
  for (const cfg of CONFIGS) {
    const r = results[cfg.label];
    const mean = r.ms.reduce((a, b) => a + b, 0) / r.ms.length / 1000;
    const total = r.ms.reduce((a, b) => a + b, 0) / 1000;
    let inter = 0, union = 0, cuisineSame = 0, cuisinePairs = 0;
    r.out.forEach((list, i) => {
      const a = new Map(base.out[i].map((x) => [norm(x.restaurantName), x]));
      const b = new Map(list.map((x) => [norm(x.restaurantName), x]));
      const keys = new Set([...a.keys(), ...b.keys()]);
      union += keys.size;
      for (const k of keys) if (a.has(k) && b.has(k)) {
        inter++; cuisinePairs++;
        if (a.get(k)!.cuisineKey === b.get(k)!.cuisineKey) cuisineSame++;
      }
    });
    const restos = r.out.reduce((n, l) => n + l.length, 0);
    const empty = r.out.filter((l) => l.length === 0).length;
    console.log(
      cfg.label.padEnd(40), mean.toFixed(1).padStart(7), (pct(r.ms, 0.5) / 1000).toFixed(1).padStart(6),
      (pct(r.ms, 0.9) / 1000).toFixed(1).padStart(6), total.toFixed(0).padStart(8),
      String(restos).padStart(7), String(empty).padStart(11),
      `${union ? ((inter / union) * 100).toFixed(0) : '-'}%`.padStart(10),
      `${cuisinePairs ? ((cuisineSame / cuisinePairs) * 100).toFixed(0) : '-'}%`.padStart(13),
    );
  }

  // Per-post disagreements, for eyeballing quality differences.
  console.log('\nPosts where configs disagree on which restaurants survive:');
  posts.forEach(({ post }, i) => {
    const sets = CONFIGS.map((c) => results[c.label].out[i].map((x) => x.restaurantName).sort().join(' / ') || '∅');
    if (new Set(sets.map(norm)).size > 1) {
      console.log(`  • ${post.title.slice(0, 40)}`);
      CONFIGS.forEach((c, k) => console.log(`      ${c.label.slice(0, 28).padEnd(28)} ${sets[k].slice(0, 140)}`));
    }
  });

  const out = path.resolve(__dirname, `../data/bench-llm-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ posts: posts.map((p) => p.post.noteId), configs: CONFIGS, results }, null, 2));
  console.log(`\nRaw → ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
