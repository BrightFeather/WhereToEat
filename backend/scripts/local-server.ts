/**
 * Local dev server — bypasses `vercel dev`.
 * Routes requests to the same handler files used in production.
 * Usage: ts-node scripts/local-server.ts
 */
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import http from 'http';
import { URL } from 'url';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const PHOTOS_DIR = path.resolve(__dirname, '../data/photos');

const PORT = 3000;

// Map URL patterns to handler modules.
// Dynamic segments like [id] are captured as named groups.
const routes: Array<{ method: string | null; pattern: RegExp; params: string[]; module: string }> = [
  { method: 'GET',   pattern: /^\/api\/restaurants\/weekly$/, params: [], module: '../api/restaurants/weekly' },
  { method: 'PATCH', pattern: /^\/api\/restaurants\/([^/]+)\/unavailable$/, params: ['id'], module: '../api/restaurants/[id]/unavailable' },
  { method: 'POST',  pattern: /^\/api\/restaurants\/pipeline\/run$/, params: [], module: '../api/restaurants/pipeline/run' },
  { method: 'POST',  pattern: /^\/api\/restaurants\/import-xhs$/, params: [], module: '../api/restaurants/import-xhs' },
  { method: 'POST',  pattern: /^\/api\/places\/enrich$/, params: [], module: '../api/places/enrich' },
  { method: 'GET',   pattern: /^\/api\/scrape\/eater$/, params: [], module: '../api/scrape/eater' },
  { method: 'GET',   pattern: /^\/api\/scrape\/xiaohongshu$/, params: [], module: '../api/scrape/xiaohongshu' },
  { method: 'GET',   pattern: /^\/api\/locations$/, params: [], module: '../api/locations/index' },

  // Auth (Apple / Google identity token exchange; see api/_lib/{appleAuth,googleAuth}.ts)
  { method: 'POST',   pattern: /^\/api\/auth\/login$/, params: [], module: '../api/auth/login' },

  // User (anonymous device-UUID in X-User-Id header; see api/_lib/withUser.ts)
  { method: 'POST',   pattern: /^\/api\/user\/ensure$/, params: [], module: '../api/user/ensure' },
  { method: null,     pattern: /^\/api\/user\/reservations$/, params: [], module: '../api/user/reservations/index' },
  { method: 'DELETE', pattern: /^\/api\/user\/reservations\/([^/]+)$/, params: ['id'], module: '../api/user/reservations/[id]' },
  { method: null,     pattern: /^\/api\/user\/favorites$/, params: [], module: '../api/user/favorites/index' },
  { method: 'DELETE', pattern: /^\/api\/user\/favorites\/([^/]+)$/, params: ['restaurantId'], module: '../api/user/favorites/[restaurantId]' },
  { method: null,     pattern: /^\/api\/user\/blocks$/, params: [], module: '../api/user/blocks/index' },
  { method: 'DELETE', pattern: /^\/api\/user\/blocks\/([^/]+)$/, params: ['restaurantId'], module: '../api/user/blocks/[restaurantId]' },
];

function buildVercelReq(
  req: http.IncomingMessage,
  url: URL,
  params: Record<string, string>,
  body: unknown
): VercelRequest {
  const query: Record<string, string | string[]> = {};
  url.searchParams.forEach((v, k) => {
    const existing = query[k];
    if (existing === undefined) query[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else query[k] = [existing, v];
  });

  return Object.assign(req, { query: { ...query, ...params }, body }) as VercelRequest;
}

function buildVercelRes(res: http.ServerResponse): VercelResponse {
  // Save originals before overriding — vRes IS res, so calling res.X inside
  // the override would recurse infinitely without this.
  const origSetHeader = res.setHeader.bind(res);
  const origEnd = res.end.bind(res);

  const vRes = res as unknown as VercelResponse;

  vRes.status = (code: number) => { res.statusCode = code; return vRes; };
  vRes.json = (data: unknown) => {
    origSetHeader('Content-Type', 'application/json');
    origEnd(JSON.stringify(data));
    return vRes;
  };
  vRes.send = (body: unknown) => {
    if (typeof body === 'string') origEnd(body);
    else origEnd(JSON.stringify(body));
    return vRes;
  };
  vRes.setHeader = (name: string, value: string | number | readonly string[]) => {
    origSetHeader(name, value as string);
    return vRes;
  };
  vRes.end = (body?: unknown) => { origEnd(body); return vRes; };

  return vRes;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS for simulator
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve local photos: GET /photos/:filename
  if (method === 'GET' && pathname.startsWith('/photos/')) {
    const filename = path.basename(pathname); // prevent path traversal
    const filePath = path.join(PHOTOS_DIR, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Match route
  const route = routes.find(r =>
    (r.method === null || r.method === method) && r.pattern.test(pathname)
  );

  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No route for ${method} ${pathname}` }));
    return;
  }

  // Extract path params
  const match = pathname.match(route.pattern);
  const params: Record<string, string> = {};
  route.params.forEach((name, i) => { params[name] = match?.[i + 1] ?? ''; });

  try {
    const body = await readBody(req);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const handler = require(route.module).default;
    const vReq = buildVercelReq(req, url, params, body);
    const vRes = buildVercelRes(res);
    await handler(vReq, vRes);
  } catch (err) {
    console.error(`[server] Error handling ${method} ${pathname}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[server] Local dev server running on http://localhost:${PORT}`);
  console.log('[server] Routes:');
  routes.forEach(r => console.log(`  ${r.method ?? '*'} ${r.module.replace('../api', '/api')}`));
});
