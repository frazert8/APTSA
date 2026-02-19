// ============================================================
// SwiftClear API — Shared Types
// ============================================================

export interface Airport {
  id: string;
  iata_code: string;
  name: string;
  city: string;
  timezone: string;
  location: { lng: number; lat: number };
}

export interface Terminal {
  id: string;
  airport_id: string;
  terminal_code: string;
  checkpoint_name: string;
  is_precheck: boolean;
  walk_to_gate_avg_minutes: number;
}

export interface WaitTimeSnapshot {
  id: string;
  terminal_id: string;
  source: 'tsa_official' | 'crowd_aggregate' | 'hybrid';
  wait_minutes: number;
  confidence_score: number;
  sample_size: number;
  tsa_raw_minutes: number | null;
  captured_at: string;
}

export interface LiveCheck {
  id: string;
  terminal_id: string;
  user_id: string;
  wait_minutes: number;
  user_location: { lng: number; lat: number } | null;
  is_geofenced: boolean;
  trust_weight: number;
  submitted_at: string;
  expires_at: string;
}

export interface UserTrustProfile {
  user_id: string;
  reputation_score: number;
  total_checks: number;
  accurate_checks: number;
}

// Trust algorithm intermediates
export interface EnrichedLiveCheck extends LiveCheck {
  reputation_score: number; // joined from user_trust_profiles
}

export interface WeightedWaitResult {
  estimatedWaitMinutes: number;
  confidenceScore: number;
  sampleSize: number;
  source: 'tsa_official' | 'crowd_aggregate' | 'hybrid' | 'no_data';
  tsaRawMinutes: number | null;
  lastUpdated: string;
}

// Routing
export interface RouteRequest {
  originLat: number;
  originLng: number;
  airportIata: string;
  terminalId: string;
}

export interface RouteResult {
  drivingMinutes: number;
  drivingDistanceKm: number;
  walkToGateMinutes: number;
  lastCalculated: string;
}
