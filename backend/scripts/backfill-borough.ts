/**
 * Populate `borough` column from existing `neighborhood` values. Falls back
 * to Google Places addressComponents (sublocality_level_1) when the
 * neighborhood alone is ambiguous.
 *
 *   npx ts-node scripts/backfill-borough.ts
 */
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import axios from 'axios';

const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
const apiKey = process.env.GOOGLE_PLACES_API_KEY;

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as const;
type Borough = (typeof BOROUGHS)[number];

// Manhattan neighborhoods
const MANHATTAN = new Set([
  'Chinatown', 'Little Italy', 'Lower East Side', 'East Village', 'Greenwich Village',
  'West Village', 'NoLita', 'Nolita', 'NoHo', 'SoHo', 'Tribeca', 'Financial District',
  'Battery Park City', 'Chelsea', 'Flatiron', 'Gramercy', 'Kips Bay', 'Murray Hill',
  'Midtown', 'Midtown East', 'Midtown West', 'Hell\'s Kitchen', 'Koreatown',
  'Times Square', 'Theater District', 'Hudson Yards', 'Upper East Side',
  'Upper West Side', 'Morningside Heights', 'Harlem', 'East Harlem', 'Spanish Harlem',
  'Washington Heights', 'Inwood', 'Roosevelt Island', 'Two Bridges', 'Bowery',
  'Union Square', 'Meatpacking District',
]);

// Brooklyn neighborhoods
const BROOKLYN = new Set([
  'Williamsburg', 'Greenpoint', 'Bushwick', 'Bedford-Stuyvesant', 'Bed-Stuy',
  'Crown Heights', 'Prospect Heights', 'Park Slope', 'Gowanus', 'Red Hook',
  'Carroll Gardens', 'Cobble Hill', 'Boerum Hill', 'Downtown Brooklyn', 'DUMBO',
  'Brooklyn Heights', 'Fort Greene', 'Clinton Hill', 'Prospect Lefferts Gardens',
  'Flatbush', 'Midwood', 'Kensington', 'Borough Park', 'Sunset Park', 'Bay Ridge',
  'Bensonhurst', 'Dyker Heights', 'Bath Beach', 'Coney Island', 'Brighton Beach',
  'Sheepshead Bay', 'East New York', 'Brownsville', 'Canarsie', 'East Flatbush',
  'Southside', // Williamsburg south side — still Brooklyn
]);

// Queens neighborhoods
const QUEENS = new Set([
  'Long Island City', 'Astoria', 'Sunnyside', 'Woodside', 'Jackson Heights',
  'Elmhurst', 'Corona', 'Flushing', 'Whitestone', 'Bayside', 'Fresh Meadows',
  'Forest Hills', 'Rego Park', 'Kew Gardens', 'Richmond Hill', 'Ozone Park',
  'Jamaica', 'South Jamaica', 'Hollis', 'Queens Village', 'Rockaway',
  'Far Rockaway', 'Howard Beach', 'College Point', 'Ridgewood', 'Maspeth',
  'Middle Village', 'Glendale', 'Briarwood',
]);

// Bronx neighborhoods
const BRONX = new Set([
  'Mott Haven', 'Melrose', 'Port Morris', 'Hunts Point', 'Morrisania',
  'Fordham', 'Belmont', 'Pelham Bay', 'Riverdale', 'Kingsbridge', 'Bedford Park',
  'Norwood', 'Woodlawn', 'Throgs Neck', 'Soundview', 'Parkchester', 'Concourse',
  'Highbridge', 'University Heights',
]);

// Staten Island neighborhoods
const STATEN_ISLAND = new Set([
  'St. George', 'Tompkinsville', 'Stapleton', 'Port Richmond', 'New Brighton',
  'West Brighton', 'Tottenville', 'Great Kills', 'New Dorp',
]);

function neighborhoodToBorough(neighborhood: string | null): Borough | null {
  if (!neighborhood) return null;
  if (BOROUGHS.includes(neighborhood as Borough)) return neighborhood as Borough;
  if (neighborhood === 'The Bronx') return 'Bronx';
  if (MANHATTAN.has(neighborhood)) return 'Manhattan';
  if (BROOKLYN.has(neighborhood)) return 'Brooklyn';
  if (QUEENS.has(neighborhood)) return 'Queens';
  if (BRONX.has(neighborhood)) return 'Bronx';
  if (STATEN_ISLAND.has(neighborhood)) return 'Staten Island';
  return null;
}

async function boroughFromPlaces(placeId: string): Promise<Borough | null> {
  if (!apiKey) return null;
  try {
    const res = await axios.get(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'addressComponents',
      },
    });
    const components: Array<{ longText: string; types: string[] }> = res.data?.addressComponents ?? [];
    const subloc = components.find((c) => c.types.includes('sublocality_level_1'))?.longText;
    return neighborhoodToBorough(subloc ?? null);
  } catch {
    return null;
  }
}

interface Row {
  id: string;
  restaurant_name: string;
  address: string | null;
  neighborhood: string | null;
  google_place_id: string | null;
}

async function main() {
  const rows = db.prepare(
    `SELECT id, restaurant_name, address, neighborhood, google_place_id
     FROM xhs_restaurants
     WHERE borough IS NULL OR borough = '' OR borough NOT IN ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')`
  ).all() as Row[];

  console.log(`Rows needing borough: ${rows.length}`);

  const update = db.prepare('UPDATE xhs_restaurants SET borough = ? WHERE id = ?');
  let filled = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let borough: Borough | null = neighborhoodToBorough(r.neighborhood);

    if (!borough && r.google_place_id) {
      borough = await boroughFromPlaces(r.google_place_id);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!borough && r.address?.includes(', NJ')) {
      // Skip NJ addresses — not an NYC borough
      skipped++;
      console.log(`  [${i + 1}/${rows.length}] ${r.restaurant_name} → (NJ, skipped)`);
      continue;
    }

    if (borough) {
      update.run(borough, r.id);
      filled++;
      console.log(`  [${i + 1}/${rows.length}] ${r.restaurant_name}: ${r.neighborhood ?? '(no hood)'} → ${borough}`);
    } else {
      skipped++;
      console.log(`  [${i + 1}/${rows.length}] ${r.restaurant_name}: ${r.neighborhood ?? '(no hood)'} → ? (skipped)`);
    }
  }

  console.log(`\nDone. Filled: ${filled}, skipped: ${skipped}`);
  db.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
