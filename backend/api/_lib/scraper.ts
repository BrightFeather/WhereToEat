import axios from 'axios';

const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export async function fetchWithRetry(
  url: string,
  options: { retries?: number; delayMs?: number; headers?: Record<string, string> } = {}
): Promise<string> {
  const { retries = 3, delayMs = 1000, headers = {} } = options;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await axios.get<string>(url, {
        headers: {
          'User-Agent': randomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          ...headers,
        },
        timeout: 15000,
        responseType: 'text',
      });
      return response.data;
    } catch (err) {
      if (attempt < retries - 1) {
        await sleep(delayMs * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

export function parseOpenGraph(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  const ogRegex = /<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*)["'][^>]*\/?>/gi;
  let match;
  while ((match = ogRegex.exec(html)) !== null) {
    result[match[1]] = match[2];
  }
  // Also handle reversed attribute order
  const ogRegex2 = /<meta[^>]+content=["']([^"']*)["'][^>]+property=["'](og:[^"']+)["'][^>]*\/?>/gi;
  while ((match = ogRegex2.exec(html)) !== null) {
    result[match[2]] = match[1];
  }
  return result;
}

export function extractSchemaOrg(html: string): Record<string, unknown> {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      if (data['@type'] && ['Restaurant', 'FoodEstablishment', 'LocalBusiness'].includes(data['@type'])) {
        return data;
      }
      if (Array.isArray(data)) {
        const restaurant = data.find(
          (d: Record<string, unknown>) =>
            d['@type'] && ['Restaurant', 'FoodEstablishment', 'LocalBusiness'].includes(d['@type'] as string)
        );
        if (restaurant) return restaurant;
      }
    } catch {
      // skip invalid JSON
    }
  }
  return {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractTextFromHtml(html: string, selector?: string): string {
  // Simple text extraction without cheerio for basic cases
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
