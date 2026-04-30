/**
 * Refine neighborhood for rows that fell back to borough-level ("Manhattan",
 * "Brooklyn", "Queens", etc.) or null. Uses Claude to map street address →
 * specific NYC neighborhood name (e.g. "Chinatown", "SoHo", "Long Island City",
 * "Bed-Stuy", "Downtown Brooklyn").
 *
 *   npx ts-node scripts/refine-neighborhoods.ts
 */
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';

const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BOROUGHS = new Set([
  'Manhattan',
  'Brooklyn',
  'Queens',
  'Bronx',
  'Staten Island',
  'The Bronx',
  'Central',
  'Southside',
]);

interface Row {
  id: string;
  restaurant_name: string;
  address: string | null;
  borough: string | null;
  neighborhood: string | null;
}

const SYSTEM = `You are a New York City neighborhood classifier. Given a restaurant name, its full street address, and an optional hint, return ONLY the specific NYC neighborhood name in English (e.g. "Chinatown", "SoHo", "East Village", "West Village", "Upper East Side", "Long Island City", "Bedford-Stuyvesant", "Downtown Brooklyn", "Williamsburg", "Flushing", "Elmhurst", "Astoria"). Never return just a borough ("Manhattan", "Brooklyn", "Queens"). If the address is in New Jersey or outside NYC, return "Outside NYC". If unknown, return "Unknown". Return ONLY the neighborhood name, no punctuation, no explanation.`;

async function classify(r: Row): Promise<string | null> {
  if (!r.address && !r.borough) return null;
  const user = `Restaurant: ${r.restaurant_name}
Address: ${r.address ?? '(unknown)'}
Borough: ${r.borough ?? '(none)'}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 40,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    });
    const text = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
    if (!text || text === 'Unknown' || text === 'Outside NYC') return null;
    if (BOROUGHS.has(text)) return null;
    return text;
  } catch (e) {
    console.log(`  ! LLM failed for ${r.restaurant_name}: ${String(e).substring(0, 80)}`);
    return null;
  }
}

async function main() {
  const rows = db.prepare(
    `SELECT id, restaurant_name, address, borough, neighborhood
     FROM xhs_restaurants
     WHERE neighborhood IS NULL
        OR neighborhood = ''
        OR neighborhood IN ('Manhattan','Brooklyn','Queens','Bronx','Staten Island','The Bronx','Central','Southside')`
  ).all() as Row[];

  console.log(`Rows to refine via LLM: ${rows.length}`);

  const update = db.prepare('UPDATE xhs_restaurants SET neighborhood = ? WHERE id = ?');
  let refined = 0;
  let unchanged = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const hood = await classify(r);
    if (hood && hood !== r.neighborhood) {
      update.run(hood, r.id);
      refined++;
      console.log(`  [${i + 1}/${rows.length}] ${r.restaurant_name}: ${r.neighborhood ?? '(null)'} → ${hood}`);
    } else {
      unchanged++;
      console.log(`  [${i + 1}/${rows.length}] ${r.restaurant_name} → (kept: ${r.neighborhood ?? 'null'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(`\nDone. Refined: ${refined}, unchanged: ${unchanged}`);
  db.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
