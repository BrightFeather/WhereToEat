import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withRequestLogging } from '../_lib/logger';
import { ok, err } from '../_lib/types';
import { getCityRegions } from '../_lib/cityRegions';

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const city = (req.query.city as string) || 'nyc';
  const regions = getCityRegions(city);

  if (!regions) {
    return res.status(404).json(err(`Unknown city: ${city}`, 'UNKNOWN_CITY'));
  }

  return res.status(200).json(ok(regions));
}

export default withRequestLogging(handler);
