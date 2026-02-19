// ============================================================
// useRoute — expo-location version
// Requests location permissions, watches position, fetches
// driving time from the Mapbox Matrix API via /api/route.
// Re-fetches when terminal changes or user moves >500m.
// ============================================================

import { useEffect, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import { useWaitTimeStore } from '../stores/waitTimeStore';
import type { RouteData } from '../stores/waitTimeStore';

const API_BASE = process.env['EXPO_PUBLIC_API_URL'] ?? '';
const REFETCH_DISTANCE_KM = 0.5;
const REFETCH_INTERVAL_MS = 5 * 60_000; // 5 min

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function useRoute(): void {
  const selectedTerminal  = useWaitTimeStore((s) => s.selectedTerminal);
  const setRouteData      = useWaitTimeStore((s) => s.setRouteData);
  const setFetchingRoute  = useWaitTimeStore((s) => s.setFetchingRoute);

  const lastPositionRef   = useRef<{ lat: number; lng: number } | null>(null);
  const lastFetchTimeRef  = useRef<number>(0);
  const terminalIdRef     = useRef<string | null>(null);
  const subRef            = useRef<Location.LocationSubscription | null>(null);

  const fetchRoute = useCallback(
    async (lat: number, lng: number, terminalId: string) => {
      setFetchingRoute(true);
      try {
        const resp = await fetch(`${API_BASE}/api/route`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originLat: lat, originLng: lng, terminalId }),
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as RouteData & { lastCalculated: string };
        setRouteData({
          drivingMinutes:    data.drivingMinutes,
          drivingDistanceKm: data.drivingDistanceKm,
          walkToGateMinutes: data.walkToGateMinutes,
          lastCalculated:    new Date(data.lastCalculated),
        });
        lastFetchTimeRef.current = Date.now();
        lastPositionRef.current  = { lat, lng };
      } catch (err) {
        console.warn('[useRoute] fetch failed', err);
      } finally {
        setFetchingRoute(false);
      }
    },
    [setRouteData, setFetchingRoute],
  );

  useEffect(() => {
    if (!selectedTerminal) return;
    terminalIdRef.current = selectedTerminal.id;

    let active = true;

    async function startWatching() {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || !active) return;

      subRef.current = await Location.watchPositionAsync(
        {
          accuracy:           Location.Accuracy.Balanced,
          distanceInterval:   200,   // metres
          timeInterval:       60_000,
        },
        ({ coords }) => {
          const { latitude: lat, longitude: lng } = coords;
          const terminalId = terminalIdRef.current;
          if (!terminalId) return;

          const elapsed   = Date.now() - lastFetchTimeRef.current;
          const lastPos   = lastPositionRef.current;
          const movedFar  = !lastPos || haversineKm(lastPos.lat, lastPos.lng, lat, lng) >= REFETCH_DISTANCE_KM;
          const isStale   = elapsed >= REFETCH_INTERVAL_MS;

          if (movedFar || isStale) {
            fetchRoute(lat, lng, terminalId).catch(console.error);
          }
        },
      );
    }

    startWatching().catch(console.error);

    return () => {
      active = false;
      subRef.current?.remove();
      subRef.current = null;
    };
  }, [selectedTerminal, fetchRoute]);
}
