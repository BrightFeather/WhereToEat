import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { fetchWithRetry, randomUserAgent } from '../_lib/scraper';
import { ok, err, XhsItem } from '../_lib/types';
import { logger, withRequestLogging } from '../_lib/logger';

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { lat, lng } = req.query;
  const cuisines = Array.isArray(req.query['cuisines[]'])
    ? req.query['cuisines[]']
    : req.query['cuisines[]']
    ? [req.query['cuisines[]'] as string]
    : [];

  if (!lat || !lng) {
    return res.status(400).json(err('Missing lat/lng', 'BAD_REQUEST'));
  }

  logger.request('GET', '/api/scrape/xiaohongshu', { lat, lng, cuisines });

  try {
    const items = await scrapeXiaohongshu(
      parseFloat(lat as string),
      parseFloat(lng as string),
      cuisines as string[]
    );
    logger.success('xhs.scrape.complete', { lat, lng, itemCount: items.length });
    return res.status(200).json(ok(items));
  } catch (e: unknown) {
    logger.error('xhs.scrape.failed', e, { lat, lng });
    return res.status(200).json(ok([])); // Return empty on failure, not error
  }
}

async function scrapeXiaohongshu(
  lat: number,
  lng: number,
  cuisines: string[]
): Promise<XhsItem[]> {
  const cityKeyword = await resolveCity(lat, lng);
  const cuisineKeyword = cuisines.length > 0 ? cuisines[0] : '';
  const keyword = [cityKeyword, cuisineKeyword, '餐厅', '美食'].filter(Boolean).join(' ');

  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&type=51`;

  let html: string;
  try {
    html = await fetchWithRetry(searchUrl, {
      headers: {
        'Cookie': '',  // anonymous
        'Referer': 'https://www.xiaohongshu.com/',
      },
    });
  } catch {
    return [];
  }

  const $ = cheerio.load(html);
  const noteLinks: string[] = [];

  // Xiaohongshu note cards in search results
  $('a[href*="/explore/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !noteLinks.includes(href)) {
      noteLinks.push(href);
    }
  });

  // Also try data-note-id or note-id patterns in JSON embedded in page
  const scriptContent = $('script').text();
  const noteIdMatches = scriptContent.matchAll(/"noteId":"([a-f0-9]{24})"/g);
  for (const match of noteIdMatches) {
    const url = `/explore/${match[1]}`;
    if (!noteLinks.includes(url)) noteLinks.push(url);
  }

  const results: XhsItem[] = [];

  // Fetch first 10 notes
  for (const link of noteLinks.slice(0, 10)) {
    try {
      const noteUrl = link.startsWith('http') ? link : `https://www.xiaohongshu.com${link}`;
      const noteHtml = await fetchWithRetry(noteUrl);
      const item = parseNoteDetail(noteHtml, noteUrl);
      if (item) results.push(item);
    } catch {
      // skip failed notes
    }
  }

  return results;
}

function parseNoteDetail(html: string, noteUrl: string): XhsItem | null {
  const $ = cheerio.load(html);

  // Try OG tags first
  const title = $('meta[property="og:title"]').attr('content') ?? '';
  const description = $('meta[property="og:description"]').attr('content') ?? '';

  const imageUrls: string[] = [];
  $('meta[property="og:image"]').each((_, el) => {
    const content = $(el).attr('content');
    if (content) imageUrls.push(content);
  });

  // Also collect img tags from note content
  $('img[src*="xhscdn"]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !imageUrls.includes(src)) imageUrls.push(src);
  });

  if (!title) return null;

  // Try to extract address from content
  const addressMatch = description.match(
    /(?:地址|📍|🗺)[：:]\s*([^\n,，。]+(?:路|街|大道|号|区|市)[^\n,，。]*)/
  );

  // Extract likes from page
  const likesMatch = html.match(/"likeCount":(\d+)/);
  const likes = likesMatch ? parseInt(likesMatch[1], 10) : undefined;

  return {
    name: title.replace(/【|】|\[|\]/g, '').trim(),
    address: addressMatch?.[1]?.trim(),
    postUrl: noteUrl,
    imageUrls: imageUrls.slice(0, 5),
    content: description,
    likes,
  };
}

async function resolveCity(lat: number, lng: number): Promise<string> {
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) return '';
    const res = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=locality&key=${key}`
    );
    return res.data.results?.[0]?.address_components?.[0]?.long_name ?? '';
  } catch {
    return '';
  }
}
export default withRequestLogging(handler);
