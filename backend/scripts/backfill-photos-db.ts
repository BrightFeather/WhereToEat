import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
import Database from 'better-sqlite3';
import axios from 'axios';

const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
const apiKey = process.env.GOOGLE_PLACES_API_KEY!;

async function main() {
  const missing = db.prepare(
    'SELECT id, restaurant_name, google_place_id FROM xhs_restaurants WHERE google_place_id IS NOT NULL AND photo_url IS NULL'
  ).all() as { id: string; restaurant_name: string; google_place_id: string }[];

  console.log(`Restaurants missing photos: ${missing.length}`);

  const update = db.prepare('UPDATE xhs_restaurants SET photo_url = ?, photo_urls = ? WHERE id = ?');

  let fixed = 0;
  let noPhotos = 0;

  for (let i = 0; i < missing.length; i++) {
    const r = missing[i];
    try {
      const res = await axios.get(
        `https://places.googleapis.com/v1/places/${r.google_place_id}`,
        {
          headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'photos',
          },
        }
      );
      const photos: string[] = (res.data?.photos ?? [])
        .slice(0, 5)
        .map((p: { name: string }) =>
          `https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=800&key=${apiKey}`
        );

      if (photos.length > 0) {
        update.run(photos[0], JSON.stringify(photos), r.id);
        fixed++;
        if (fixed % 10 === 0) console.log(`  Fixed ${fixed}/${missing.length}`);
      } else {
        noPhotos++;
        console.log(`  No photos: ${r.restaurant_name}`);
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (e: any) {
      noPhotos++;
      console.log(`  Error: ${r.restaurant_name}: ${e.message?.substring(0, 80)}`);
    }
  }

  console.log(`\nDone! Fixed: ${fixed}, No photos available: ${noPhotos}`);
  db.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
