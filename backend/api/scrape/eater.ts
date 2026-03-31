import { VercelRequest, VercelResponse } from '@vercel/node';
import * as cheerio from 'cheerio';
import { fetchWithRetry } from '../_lib/scraper';
import { ok, err, EaterItem } from '../_lib/types';

// Map city names to Eater subdomain slugs
const CITY_MAP: Record<string, string> = {
  'san francisco': 'sf',
  'sf': 'sf',
  'new york': 'ny',
  'new york city': 'ny',
  'nyc': 'ny',
  'los angeles': 'la',
  'la': 'la',
  'chicago': 'chicago',
  'seattle': 'seattle',
  'portland': 'portland',
  'boston': 'boston',
  'miami': 'miami',
  'austin': 'austin',
  'denver': 'denver',
  'washington': 'dc',
  'dc': 'dc',
  'philadelphia': 'philly',
  'atlanta': 'atlanta',
  'houston': 'houston',
  'dallas': 'dallas',
  'nashville': 'nashville',
  'new orleans': 'neworleans',
  'portland': 'portland',
  'minneapolis': 'twin-cities',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { city } = req.query;
  if (!city) {
    return res.status(400).json(err('Missing city param', 'BAD_REQUEST'));
  }

  try {
    const items = await scrapeEater(city as string);
    return res.status(200).json(ok(items));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Eater scrape failed';
    console.error('Eater scrape error:', e);
    return res.status(200).json(ok([]));
  }
}

async function scrapeEater(cityInput: string): Promise<EaterItem[]> {
  const slug = resolveSlug(cityInput);
  if (!slug) return [];

  const results: EaterItem[] = [];

  // 1. RSS feed
  try {
    const rssUrl = `https://${slug}.eater.com/rss/index.xml`;
    const rssXml = await fetchWithRetry(rssUrl);
    const rssItems = parseRSS(rssXml, slug);
    results.push(...rssItems);
  } catch {
    // skip RSS failure
  }

  // 2. Best restaurants map page
  try {
    const mapUrl = `https://${slug}.eater.com/maps/best-restaurants-${slug}`;
    const html = await fetchWithRetry(mapUrl);
    const mapItems = parseMapPage(html, slug);
    results.push(...mapItems);
  } catch {
    // try alternate URL pattern
    try {
      const mapUrl2 = `https://${slug}.eater.com/maps/best-new-restaurants-${slug}`;
      const html = await fetchWithRetry(mapUrl2);
      const mapItems = parseMapPage(html, slug);
      results.push(...mapItems);
    } catch {
      // skip
    }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return results.filter((item) => {
    const key = item.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveSlug(city: string): string | null {
  const normalized = city.toLowerCase().split(',')[0].trim();
  return CITY_MAP[normalized] ?? null;
}

function parseRSS(xml: string, slug: string): EaterItem[] {
  const items: EaterItem[] = [];
  const $ = cheerio.load(xml, { xmlMode: true });

  $('item').each((_, el) => {
    const title = $(el).find('title').text().trim();
    const link = $(el).find('link').text().trim() || $(el).find('guid').text().trim();
    const description = $(el).find('description').text().trim();

    // Filter for restaurant-related articles
    const lower = title.toLowerCase();
    if (!lower.includes('restaurant') && !lower.includes('eat') &&
        !lower.includes('food') && !lower.includes('best') &&
        !lower.includes('open') && !lower.includes('bar')) {
      return;
    }

    const imageMatch = description.match(/<img[^>]+src=["']([^"']+)["']/);
    const cleanDesc = description.replace(/<[^>]+>/g, '').trim().slice(0, 300);

    items.push({
      name: title,
      sourceUrl: link,
      description: cleanDesc || undefined,
      imageUrl: imageMatch?.[1],
    });
  });

  return items.slice(0, 20);
}

function parseMapPage(html: string, slug: string): EaterItem[] {
  const items: EaterItem[] = [];
  const $ = cheerio.load(html);

  // Eater map pages use "c-mapstack__card" or similar components
  $('[class*="mapstack__card"], [class*="venue-card"], .c-mapstack__card').each((_, el) => {
    const name = $(el).find('h1, h2, h3, [class*="title"], [class*="name"]').first().text().trim();
    const address = $(el).find('[class*="address"], address').first().text().trim();
    const description = $(el).find('p').first().text().trim().slice(0, 300);
    const imageUrl = $(el).find('img').first().attr('src');
    const href = $(el).find('a').first().attr('href');
    const sourceUrl = href
      ? href.startsWith('http') ? href : `https://${slug}.eater.com${href}`
      : `https://${slug}.eater.com`;

    if (!name) return;

    items.push({
      name,
      address: address || undefined,
      sourceUrl,
      description: description || undefined,
      imageUrl,
    });
  });

  // Fallback: article links with restaurant-flavored titles
  if (items.length === 0) {
    $('h2 a, h3 a').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') ?? '';
      if (!name || name.length > 60) return;
      items.push({
        name,
        sourceUrl: href.startsWith('http') ? href : `https://${slug}.eater.com${href}`,
      });
    });
  }

  return items.slice(0, 30);
}
