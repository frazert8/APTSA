// ============================================================
// SwiftClear — Weighted Trust Algorithm
//
// Conflict Resolution Strategy:
//   1. Remove statistical outliers (Z-score filter)
//   2. Apply per-check composite weight:
//        weight = recency_decay × geofence_boost × reputation_multiplier
//   3. Compute weighted mean of crowdsourced reports
//   4. Blend with TSA official data using log-scaled crowdsource confidence
//   5. Emit final estimate + confidence score → written to wait_time_snapshots
// ============================================================

import type { EnrichedLiveCheck, WeightedWaitResult } from '../types/index.js';

const WEIGHTS = {
  // A user physically inside the terminal geofence carries 2.5× the trust
  GEOFENCED_MULTIPLIER: 2.5,

  // Exponential half-life: a check submitted 20 min ago weighs 50% of fresh
  RECENCY_HALF_LIFE_MINUTES: 20,

  // Reputation clamp — prevents single super-user domination
  MAX_REPUTATION_MULTIPLIER: 3.0,
  MIN_REPUTATION_MULTIPLIER: 0.2,

  // Remove checks whose Z-score exceeds this (likely trolls / errors)
  OUTLIER_ZSCORE_THRESHOLD: 2.0,

  // Min crowdsource contribution to the final blend (never fully replace TSA)
  MAX_CROWD_BLEND_WEIGHT: 0.80,
} as const;

// ── Helpers ──────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[], avg: number): number {
  const variance = values.reduce((sq, n) => sq + (n - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function recencyWeight(submittedAt: Date, now: Date): number {
  const ageMinutes = (now.getTime() - submittedAt.getTime()) / 60_000;
  // w = 0.5 ^ (age / half_life)
  return Math.pow(0.5, ageMinutes / WEIGHTS.RECENCY_HALF_LIFE_MINUTES);
}

// ── Main export ───────────────────────────────────────────────

export function computeWeightedWaitTime(
  checks: EnrichedLiveCheck[],
  tsaRawMinutes: number | null,
): WeightedWaitResult {
  const now = new Date();

  // ── No data at all ───────────────────────────────────────
  if (checks.length === 0 && tsaRawMinutes === null) {
    return {
      estimatedWaitMinutes: 0,
      confidenceScore: 0,
      sampleSize: 0,
      source: 'no_data',
      tsaRawMinutes: null,
      lastUpdated: now.toISOString(),
    };
  }

  // ── TSA only (no crowd data yet) ─────────────────────────
  if (checks.length === 0) {
    return {
      estimatedWaitMinutes: tsaRawMinutes!,
      confidenceScore: 0.45,
      sampleSize: 0,
      source: 'tsa_official',
      tsaRawMinutes,
      lastUpdated: now.toISOString(),
    };
  }

  // ── Step 1: Z-score outlier removal ──────────────────────
  const rawValues = checks.map((c) => c.wait_minutes);
  const mu = mean(rawValues);
  const sigma = stdDev(rawValues, mu);

  const filtered = checks.filter((c) => {
    const z = Math.abs((c.wait_minutes - mu) / (sigma || 1));
    return z <= WEIGHTS.OUTLIER_ZSCORE_THRESHOLD;
  });

  if (filtered.length === 0) {
    // All checks were outliers — fall back to TSA
    return {
      estimatedWaitMinutes: tsaRawMinutes ?? Math.round(mu),
      confidenceScore: 0.3,
      sampleSize: 0,
      source: tsaRawMinutes !== null ? 'tsa_official' : 'crowd_aggregate',
      tsaRawMinutes,
      lastUpdated: now.toISOString(),
    };
  }

  // ── Step 2: Compute composite weight per check ───────────
  type Weighted = EnrichedLiveCheck & { _weight: number };

  const weighted: Weighted[] = filtered.map((check) => {
    const rw = recencyWeight(new Date(check.submitted_at), now);
    const gw = check.is_geofenced ? WEIGHTS.GEOFENCED_MULTIPLIER : 1.0;
    const rep = Math.max(
      WEIGHTS.MIN_REPUTATION_MULTIPLIER,
      Math.min(WEIGHTS.MAX_REPUTATION_MULTIPLIER, check.reputation_score),
    );
    return { ...check, _weight: rw * gw * rep };
  });

  const totalWeight = weighted.reduce((s, c) => s + c._weight, 0);
  const crowdEstimate =
    weighted.reduce((s, c) => s + c.wait_minutes * c._weight, 0) / totalWeight;

  // ── Step 3: Blend crowd + TSA ────────────────────────────
  // crowdShare grows with log(n), capped at MAX_CROWD_BLEND_WEIGHT
  const crowdShare = Math.min(
    WEIGHTS.MAX_CROWD_BLEND_WEIGHT,
    0.2 * Math.log1p(filtered.length), // log1p(n) is ln(n+1)
  );

  let estimatedWaitMinutes: number;
  let source: WeightedWaitResult['source'];
  let confidenceScore: number;

  if (tsaRawMinutes !== null) {
    estimatedWaitMinutes = Math.round(
      tsaRawMinutes * (1 - crowdShare) + crowdEstimate * crowdShare,
    );
    source = 'hybrid';
    confidenceScore = 0.50 + crowdShare * 0.45; // 0.5 → 0.86 as crowd grows
  } else {
    estimatedWaitMinutes = Math.round(crowdEstimate);
    source = 'crowd_aggregate';
    confidenceScore = Math.min(0.92, 0.30 + 0.12 * Math.log1p(filtered.length));
  }

  return {
    estimatedWaitMinutes: Math.max(0, estimatedWaitMinutes),
    confidenceScore: Math.round(confidenceScore * 100) / 100,
    sampleSize: filtered.length,
    source,
    tsaRawMinutes,
    lastUpdated: now.toISOString(),
  };
}

// ── Reputation updater (called after ground-truth reconciliation) ──
// If a user's reported wait is within ±5 min of the aggregate,
// bump their accuracy score.
export function evaluateCheckAccuracy(
  reportedMinutes: number,
  aggregateMinutes: number,
): 'accurate' | 'inaccurate' {
  return Math.abs(reportedMinutes - aggregateMinutes) <= 5 ? 'accurate' : 'inaccurate';
}

export function computeNewReputation(
  current: number,
  totalChecks: number,
  accurateChecks: number,
): number {
  if (totalChecks === 0) return 1.0;
  const accuracy = accurateChecks / totalChecks;
  // ELO-style: clamp between 0.2 and 5.0
  const raw = 0.2 + accuracy * 4.8;
  return Math.round(raw * 100) / 100;
}
