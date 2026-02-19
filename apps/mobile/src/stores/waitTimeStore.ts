// ============================================================
// SwiftClear — Wait Time + Leave-By Zustand Store
//
// Reactive state graph:
//   waitTimeData ─┐
//   routeData    ─┼──► recalculateLeaveBy ──► leaveByTime
//   flightTime   ─┘                       ──► minutesUntilLeave
//                                         ──► urgencyLevel
// ============================================================

import { create } from 'zustand';
import { subscribeWithSelector, devtools } from 'zustand/middleware';

// ── Domain types ──────────────────────────────────────────────

export interface Terminal {
  id: string;
  airportIata: string;
  terminalCode: string;
  checkpointName: string;
  isPrecheck: boolean;
  walkToGateMinutes: number;
}

export interface WaitTimeData {
  estimatedWaitMinutes: number;
  confidenceScore: number;       // 0–1
  sampleSize: number;
  source: 'tsa_official' | 'crowd_aggregate' | 'hybrid' | 'no_data';
  lastUpdated: Date;
}

export interface RouteData {
  drivingMinutes: number;
  drivingDistanceKm: number;
  walkToGateMinutes: number;
  lastCalculated: Date;
}

// "Safe" = plenty of time, "Critical" = should have left already
export type UrgencyLevel = 'safe' | 'soon' | 'urgent' | 'critical' | 'unknown';

export interface LeaveByBreakdown {
  driveMinutes: number;
  securityMinutes: number;
  gateWalkMinutes: number;
  bufferMinutes: number;
  totalMinutes: number;
}

// ── Store interface ───────────────────────────────────────────

interface WaitTimeState {
  // Input state
  selectedTerminal: Terminal | null;
  waitTimeData: WaitTimeData | null;
  routeData: RouteData | null;
  flightDepartureTime: Date | null;
  bufferMinutes: number;

  // Derived / computed
  leaveByTime: Date | null;
  minutesUntilLeave: number | null;
  urgencyLevel: UrgencyLevel;
  breakdown: LeaveByBreakdown | null;

  // Loading flags
  isFetchingWaitTime: boolean;
  isFetchingRoute: boolean;
}

interface WaitTimeActions {
  setTerminal: (terminal: Terminal | null) => void;
  setWaitTimeData: (data: WaitTimeData) => void;
  setRouteData: (data: RouteData) => void;
  setFlightDepartureTime: (time: Date | null) => void;
  setBufferMinutes: (minutes: number) => void;
  setFetchingWaitTime: (v: boolean) => void;
  setFetchingRoute: (v: boolean) => void;
  /** Recompute leave-by from current state — called internally on each input change */
  recalculateLeaveBy: () => void;
  /** Tick: refresh minutesUntilLeave + urgencyLevel from current leaveByTime */
  tick: () => void;
  reset: () => void;
}

type WaitTimeStore = WaitTimeState & WaitTimeActions;

// ── Urgency classification ────────────────────────────────────

function classifyUrgency(minutesUntilLeave: number): UrgencyLevel {
  if (minutesUntilLeave > 60)  return 'safe';
  if (minutesUntilLeave > 30)  return 'soon';
  if (minutesUntilLeave > 0)   return 'urgent';
  return 'critical'; // negative = should have left already
}

// ── Initial state ─────────────────────────────────────────────

const INITIAL_STATE: WaitTimeState = {
  selectedTerminal:     null,
  waitTimeData:         null,
  routeData:            null,
  flightDepartureTime:  null,
  bufferMinutes:        15,
  leaveByTime:          null,
  minutesUntilLeave:    null,
  urgencyLevel:         'unknown',
  breakdown:            null,
  isFetchingWaitTime:   false,
  isFetchingRoute:      false,
};

// ── Store ─────────────────────────────────────────────────────

export const useWaitTimeStore = create<WaitTimeStore>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      ...INITIAL_STATE,

      setTerminal: (terminal) => {
        set({ selectedTerminal: terminal, waitTimeData: null, routeData: null });
      },

      setWaitTimeData: (data) => {
        set({ waitTimeData: data });
        get().recalculateLeaveBy();
      },

      setRouteData: (data) => {
        set({ routeData: data });
        get().recalculateLeaveBy();
      },

      setFlightDepartureTime: (time) => {
        set({ flightDepartureTime: time });
        get().recalculateLeaveBy();
      },

      setBufferMinutes: (minutes) => {
        set({ bufferMinutes: Math.max(0, Math.min(60, minutes)) });
        get().recalculateLeaveBy();
      },

      setFetchingWaitTime: (v) => set({ isFetchingWaitTime: v }),
      setFetchingRoute: (v) => set({ isFetchingRoute: v }),

      // ── Core computation ────────────────────────────────────
      recalculateLeaveBy: () => {
        const { waitTimeData, routeData, flightDepartureTime, bufferMinutes } = get();

        if (!waitTimeData || !routeData || !flightDepartureTime) {
          set({ leaveByTime: null, minutesUntilLeave: null, urgencyLevel: 'unknown', breakdown: null });
          return;
        }

        const breakdown: LeaveByBreakdown = {
          driveMinutes:    routeData.drivingMinutes,
          securityMinutes: waitTimeData.estimatedWaitMinutes,
          gateWalkMinutes: routeData.walkToGateMinutes,
          bufferMinutes,
          totalMinutes:
            routeData.drivingMinutes +
            waitTimeData.estimatedWaitMinutes +
            routeData.walkToGateMinutes +
            bufferMinutes,
        };

        const leaveByTime = new Date(
          flightDepartureTime.getTime() - breakdown.totalMinutes * 60_000,
        );

        const minutesUntilLeave = Math.round(
          (leaveByTime.getTime() - Date.now()) / 60_000,
        );

        set({
          leaveByTime,
          minutesUntilLeave,
          urgencyLevel: classifyUrgency(minutesUntilLeave),
          breakdown,
        });
      },

      // ── Called by a 30-second interval in the UI ─────────────
      tick: () => {
        const { leaveByTime } = get();
        if (!leaveByTime) return;

        const minutesUntilLeave = Math.round(
          (leaveByTime.getTime() - Date.now()) / 60_000,
        );
        set({
          minutesUntilLeave,
          urgencyLevel: classifyUrgency(minutesUntilLeave),
        });
      },

      reset: () => set(INITIAL_STATE),
    })),
    { name: 'WaitTimeStore' },
  ),
);

// ── Selectors (memoised slices for component consumers) ───────

export const selectLeaveByDisplay = (s: WaitTimeStore) => ({
  leaveByTime:       s.leaveByTime,
  minutesUntilLeave: s.minutesUntilLeave,
  urgencyLevel:      s.urgencyLevel,
  breakdown:         s.breakdown,
});

export const selectIsReady = (s: WaitTimeStore) =>
  s.waitTimeData !== null && s.routeData !== null && s.flightDepartureTime !== null;
