import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env['UPSTASH_REDIS_REST_URL']!,
  token: process.env['UPSTASH_REDIS_REST_TOKEN']!,
});

export const CACHE_KEYS = {
  waitTime: (terminalId: string) => `wt:${terminalId}`,
  airport:  (iata: string)       => `airport:${iata}`,
  terminals: (airportId: string) => `terminals:${airportId}`,
  tsaRaw:   (terminalId: string) => `tsa_raw:${terminalId}`,
} as const;

export const CACHE_TTL = {
  WAIT_TIME:  60,   // seconds — volatile, rebuilt each ingest cycle
  AIRPORT:    3600, // 1 hour
  TERMINALS:  3600,
  TSA_RAW:    300,  // 5 min — official TSA data refresh rate
} as const;

export { redis };
