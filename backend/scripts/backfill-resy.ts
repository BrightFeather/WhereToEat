/**
 * Backfill Resy venue IDs and booking URLs for restaurants in the database.
 *
 *   npx ts-node scripts/backfill-resy.ts
 *
 * Searches Resy's /4/find endpoint for each restaurant by name matching,
 * then stores the venue_id and booking URL (https://resy.com/cities/{city}/{slug}).
 */
import Database from 'better-sqlite3';
import path from 'path';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const db = new Database(path.join(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');

const API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5';
const BASE = 'https://api.resy.com';

// NYC default coordinates
const DEFAULT_LAT = 40.7128;
const DEFAULT_LNG = -74.0060;

let authToken: string | null = null;

async function login(): Promise<string> {
  if (authToken) return authToken;
  const res = await axios.post(
    `${BASE}/3/auth/password`,
    new URLSearchParams({
      email: process.env.RESY_EMAIL ?? '',
      password: process.env.RESY_PASSWORD ?? '',
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `ResyAPI api_key="${API_KEY}"`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Origin': 'https://resy.com',
        'Referer': 'https://resy.com/',
      },
    }
  );
  authToken = res.data.token;
  return authToken!;
}

function headers(token: string) {
  return {
    'Authorization': `ResyAPI api_key="${API_KEY}"`,
    'x-resy-auth-token': token,
    'x-resy-universal-auth': token,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': 'https://resy.com',
    'Referer': 'https://resy.com/',
    'X-Origin': 'https://resy.com',
    'Cache-Control': 'no-cache',
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface VenueResult {
  venueId: string;
  name: string;
  urlSlug: string;
  citySlug: string;
  bookingUrl: string;
}

// Cache the full search results to avoid repeated API calls
let cachedVenues: any[] | null = null;

async function loadAllVenues(token: string): Promise<any[]> {
  if (cachedVenues) return cachedVenues;

  const today = new Date().toISOString().split('T')[0];
  console.log(`Fetching all NYC venues from Resy for ${today}...`);

  const res = await axios.get(`${BASE}/4/find`, {
    headers: headers(token),
    params: {
      lat: DEFAULT_LAT,
      long: DEFAULT_LNG,
      day: today,
      party_size: 2,
    },
    timeout: 60000,
  });

  cachedVenues = res.data.results?.venues ?? [];
  console.log(`Loaded ${cachedVenues!.length} venues from Resy`);
  return cachedVenues!;
}

function findMatch(venues: any[], restaurantName: string): VenueResult | null {
  const nameNorm = normalize(restaurantName);

  for (const v of venues) {
    const venue = v.venue;
    const vName = normalize(venue?.name ?? '');

    // Require exact match, or one name fully contains the other
    // with the shorter being at least 60% the length of the longer (avoids "King" matching "Pecking")
    const isExact = vName === nameNorm;
    const shorter = Math.min(vName.length, nameNorm.length);
    const longer = Math.max(vName.length, nameNorm.length);
    const isSubstring = (vName.includes(nameNorm) || nameNorm.includes(vName))
      && shorter >= longer * 0.6;

    if (isExact || isSubstring) {
      if (shorter < 4 && !isExact) continue;

      const venueId = typeof venue.id === 'object' ? venue.id.resy : venue.id;
      const urlSlug = venue.url_slug ?? '';
      const citySlug = venue.location?.url_slug ?? '';

      return {
        venueId: String(venueId),
        name: venue.name,
        urlSlug,
        citySlug,
        bookingUrl: urlSlug && citySlug
          ? `https://resy.com/cities/${citySlug}/venues/${urlSlug}`
          : '',
      };
    }
  }
  return null;
}

async function main() {
  const token = await login();
  const allVenues = await loadAllVenues(token);

  // Get restaurants without Resy data
  const restaurants = db.prepare(`
    SELECT id, restaurant_name, google_display_name, address
    FROM xhs_restaurants
    WHERE resy_booking_url IS NULL
      AND is_available_this_week = 1
  `).all() as { id: string; restaurant_name: string; google_display_name: string | null; address: string | null }[];

  console.log(`\nChecking ${restaurants.length} restaurants against Resy...\n`);

  const update = db.prepare(`
    UPDATE xhs_restaurants
    SET resy_venue_id = ?, resy_booking_url = ?
    WHERE id = ?
  `);

  let matched = 0;
  let skipped = 0;

  for (const r of restaurants) {
    // Try google_display_name first (more accurate), then restaurant_name
    const names = [r.google_display_name, r.restaurant_name].filter(Boolean) as string[];
    let found: VenueResult | null = null;

    for (const name of names) {
      found = findMatch(allVenues, name);
      if (found) break;
    }

    if (found && found.bookingUrl) {
      update.run(found.venueId, found.bookingUrl, r.id);
      console.log(`✓ ${r.restaurant_name} → ${found.name} (${found.bookingUrl})`);
      matched++;
    } else {
      console.log(`· ${r.restaurant_name} — not on Resy`);
      skipped++;
    }
  }

  console.log(`\nDone: ${matched} matched, ${skipped} not found`);
  db.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
