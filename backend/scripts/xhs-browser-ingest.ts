/**
 * Browser-based XHS / RedNote ingest (replaces `xhs` CLI scraping).
 *
 * Phase 1 — count (MODE=count, default):
 *   For each keyword, search sorted by 最多点赞 within 半年内 (server-side
 *   filters), scroll until likes drop below MIN_LIKES. Dedupes across keywords
 *   and writes data/xhs-raw/candidates-<city>.json. No notes are opened.
 *
 * Phase 2 — read (MODE=read):
 *   Takes the top MAX_POSTS candidates by likes, opens each note (raw JSON
 *   cached in data/xhs-raw/notes/<id>.json — re-runs don't re-fetch), drops
 *   anything older than 6 months, and writes the posts in the
 *   RawXhsPost shape (data/xhs-raw/posts-<city>.json). Feed that to the pipeline:
 *     POSTS_FILE=data/xhs-raw/posts.json npx ts-node scripts/test-pipeline.ts
 *
 *   npx ts-node -T scripts/xhs-browser-ingest.ts                     # count
 *   MODE=read MAX_POSTS=300 npx ts-node -T scripts/xhs-browser-ingest.ts
 *
 * Env: CITY (nyc | bay, default nyc), KEYWORDS (comma list, overrides the city list), MIN_LIKES (50), MAX_SCROLLS (20), MAX_POSTS (300), MONTHS (6)
 * First run opens Chrome for a one-time QR login (persistent profile).
 */
import * as fs from 'fs';
import * as path from 'path';
import { XhsBrowser, jitter, type SearchCard } from '../api/_lib/xhsBrowser';
import type { RawXhsPost } from '../api/_lib/xhsScraper';

const KEYWORDS_BY_CITY: Record<string, string[]> = {
  nyc: [
    '纽约美食', '纽约探店', '纽约新店', '纽约餐厅', '纽约必吃',
    '曼哈顿美食', '法拉盛美食', '布鲁克林美食', '纽约brunch', '纽约约会餐厅',
    '纽约漂亮饭', '纽约日料', '纽约中餐', '纽约韩餐', '纽约火锅',
  ],
  // See agent_docs/bay-area-expansion.md
  bay: [
    '湾区美食', '旧金山美食', '湾区探店', '湾区新店', '湾区餐厅', '湾区必吃',
    '硅谷美食', '南湾美食', '东湾美食', '半岛美食', '旧金山探店',
    // NOT '奥克兰美食' — 奥克兰 is also Auckland (NZ); on 2026-11-26 all 116 of its
    // exclusive results were New Zealand posts.
    '圣何塞美食', '湾区约会餐厅', '湾区brunch', '湾区漂亮饭', '湾区日料', '湾区中餐', '湾区火锅',
  ],
};
const CITY = process.env.CITY ?? 'nyc';
if (!KEYWORDS_BY_CITY[CITY]) throw new Error(`No keyword list for CITY=${CITY}`);
const MODE = process.env.MODE ?? 'count';
const KEYWORDS = process.env.KEYWORDS ? process.env.KEYWORDS.split(',').map((s) => s.trim()).filter(Boolean) : KEYWORDS_BY_CITY[CITY];
const MIN_LIKES = Number(process.env.MIN_LIKES ?? 50);
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS ?? 20);
const MAX_POSTS = Number(process.env.MAX_POSTS ?? 300);
const MONTHS = Number(process.env.MONTHS ?? 6);

const RAW_DIR = path.resolve(__dirname, '../data/xhs-raw');
const NOTES_DIR = path.join(RAW_DIR, 'notes');
const CANDIDATES_FILE = path.join(RAW_DIR, `candidates-${CITY}.json`);
const POSTS_FILE = path.join(RAW_DIR, `posts-${CITY}.json`);

const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - MONTHS);

interface Candidate extends SearchCard { keywords: string[] }

async function count(xb: XhsBrowser) {
  const all = new Map<string, Candidate>();
  const perKeyword: Record<string, number> = {};
  for (const kw of KEYWORDS) {
    const t0 = Date.now();
    try {
      const cards = await xb.searchPopularRecent(kw, { minLikes: MIN_LIKES, maxScrolls: MAX_SCROLLS });
      perKeyword[kw] = cards.length;
      let fresh = 0;
      for (const c of cards) {
        const prev = all.get(c.id);
        if (prev) { if (!prev.keywords.includes(kw)) prev.keywords.push(kw); continue; }
        all.set(c.id, { ...c, keywords: [kw] });
        fresh++;
      }
      const floor = cards.length ? Math.min(...cards.map((c) => c.likes)) : 0;
      const capped = cards.length > 0 && floor >= MIN_LIKES * 1.5 ? '  ⚠ hit scroll cap — lower bound' : '';
      console.log(`  ${kw.padEnd(10)} ${String(cards.length).padStart(4)} posts ≥${MIN_LIKES}❤  lowest ❤${floor}  (+${fresh} new, total ${all.size})  ${((Date.now() - t0) / 1000).toFixed(0)}s${capped}`);
    } catch (e) {
      perKeyword[kw] = -1;
      console.log(`  ${kw.padEnd(10)} FAILED: ${String(e).slice(0, 200)}`);
    }
    // Save as we go so a crash keeps progress.
    fs.writeFileSync(CANDIDATES_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), minLikes: MIN_LIKES, months: MONTHS, perKeyword, candidates: [...all.values()] }, null, 2));
    await jitter(4000, 7000);
  }

  const cands = [...all.values()].sort((a, b) => b.likes - a.likes);
  const bucket = (n: number) => cands.filter((c) => c.likes >= n).length;
  const older = cands.filter((c) => c.publishedAt && new Date(c.publishedAt) < cutoff).length;
  console.log(`\n=== Count: ${cands.length} unique posts with ≥${MIN_LIKES} likes in the last ${MONTHS} months ===`);
  console.log(`  ≥100❤: ${bucket(100)}   ≥500❤: ${bucket(500)}   ≥1000❤: ${bucket(1000)}   ≥5000❤: ${bucket(5000)}`);
  console.log(`  publish-date sanity: ${older} cards look older than the cutoff (server filter should make this ~0)`);
  console.log(`  top 10:`);
  for (const c of cands.slice(0, 10)) console.log(`    ❤${String(c.likes).padStart(6)} ★${String(c.collects).padStart(6)}  ${c.publishText ?? '?'}  ${c.title.slice(0, 40)}`);
  console.log(`\nCandidates → ${CANDIDATES_FILE}`);
}

/**
 * Keywords whose results are often about another place: 半岛 = Macau Peninsula /
 * Hainan's 神州半岛, 南湾 / 东湾 = places in Macau, Hong Kong, Shenzhen and LA,
 * 奥克兰 = Auckland. A candidate found ONLY via these keywords is kept only if
 * its title names the city (BAY_TITLE_MARKERS). Observed 2026-11-26.
 */
const AMBIGUOUS_KEYWORDS: Record<string, Set<string>> = {
  bay: new Set(['半岛美食', '南湾美食', '东湾美食', '奥克兰美食']),
};
const TITLE_MARKERS: Record<string, RegExp> = {
  bay: /湾区|旧金山|三藩|硅谷|加州|斯坦福|Stanford|\bSF\b|San Francisco|Bay ?Area|Fremont|费利蒙|弗里蒙特|Walnut Creek|San Jose|圣何塞|Cupertino|库比蒂诺|Palo Alto|帕罗奥图|Berkeley|伯克利|Oakland|Milpitas|米尔皮塔斯|Sunnyvale|桑尼维尔|Mountain View|山景城|San Mateo|圣马特奥|Millbrae|Santa Clara|圣克拉拉|Dublin|Pleasanton|Emeryville|Daly City|Burlingame|Redwood City|Los Altos|Napa|纳帕|Sausalito|Walnut/i,
};

function isRelevant(c: Candidate): boolean {
  const amb = AMBIGUOUS_KEYWORDS[CITY];
  if (!amb || !c.keywords.every((k) => amb.has(k))) return true;
  return TITLE_MARKERS[CITY]?.test(c.title) ?? true;
}

async function read(xb: XhsBrowser) {
  const { candidates: all } = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8')) as { candidates: Candidate[] };
  const candidates = all.filter(isRelevant);
  if (candidates.length !== all.length) console.log(`Relevance filter: dropped ${all.length - candidates.length} ambiguous-keyword candidates without a ${CITY} title marker`);
  const picked = [...candidates].sort((a, b) => b.likes - a.likes).slice(0, MAX_POSTS);
  console.log(`Reading top ${picked.length} of ${candidates.length} candidates (min likes in selection: ${picked.at(-1)?.likes ?? '-'})`);
  fs.mkdirSync(NOTES_DIR, { recursive: true });

  const posts: RawXhsPost[] = [];
  let cached = 0, failed = 0, tooOld = 0, consecutiveFails = 0;
  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    const file = path.join(NOTES_DIR, `${c.id}.json`);
    let note: { title: string; desc: string; time: number | null; likes: number } | null = null;
    if (fs.existsSync(file)) {
      note = JSON.parse(fs.readFileSync(file, 'utf8'));
      cached++;
    } else {
      let d: Awaited<ReturnType<XhsBrowser['readNote']>>;
      try {
        d = await xb.readNote(c.id, c.xsecToken);
      } catch (e) {
        // Unsolved captcha / lost session: stop reading but still write what we have.
        console.log(`!!! stopping at ${i + 1}/${picked.length}: ${String(e).slice(0, 120)} — writing partial results (re-run later; cached notes are skipped)`);
        break;
      }
      if (d) {
        fs.writeFileSync(file, JSON.stringify({ ...d, searchCard: c }, null, 2));
        note = d;
        consecutiveFails = 0;
      } else {
        failed++;
        consecutiveFails++;
        console.log(`  [${i + 1}/${picked.length}] ✗ could not read ${c.id} (${c.title.slice(0, 30)}) url=${xb.page.url().slice(0, 80)}`);
        if (consecutiveFails >= 5) { console.log('!!! 5 reads failed in a row — stopping (session lost or rate-limited).'); break; }
      }
      await jitter(3000, 6000);
    }
    if (!note) continue;
    if (!note.time || note.time < cutoff.getTime()) { tooOld++; continue; }
    posts.push({
      noteId: c.id,
      title: note.title,
      body: note.desc,
      likes: note.likes || c.likes,
      postUrl: `https://www.xiaohongshu.com/explore/${c.id}`,
      createdAt: new Date(note.time).toISOString(),
    });
    if ((i + 1) % 10 === 0) console.log(`  [${i + 1}/${picked.length}] ok=${posts.length} cached=${cached} failed=${failed} tooOld=${tooOld}`);
  }
  fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2));
  console.log(`\n=== Read: ${posts.length} posts (cached ${cached}, failed ${failed}, older than ${MONTHS}mo ${tooOld}) → ${POSTS_FILE}`);
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  console.log(`=== XHS browser ingest — city=${CITY} mode=${MODE} cutoff=${cutoff.toISOString().slice(0, 10)} minLikes=${MIN_LIKES} ===`);
  const xb = new XhsBrowser();
  await xb.open();
  try {
    console.log(`✓ logged in as ${await xb.ensureLoggedIn()}`);
    if (MODE === 'read') await read(xb); else await count(xb);
  } finally {
    await xb.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
