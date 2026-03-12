// Safely expose the Google Maps API key to the frontend.
// The key never appears in the HTML source — only returned at runtime.
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const key = process.env['GOOGLE_MAPS_API_KEY'] ?? '';
  return res.status(200).json({ key });
}
