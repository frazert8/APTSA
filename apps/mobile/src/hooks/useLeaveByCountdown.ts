// ============================================================
// useLeaveByCountdown
// Runs a 30-second ticker that calls store.tick() to keep
// minutesUntilLeave fresh without re-triggering recalculation.
// Also triggers haptic + push notification thresholds.
// ============================================================

import { useEffect, useRef } from 'react';
import { useWaitTimeStore } from '../stores/waitTimeStore';

const TICK_INTERVAL_MS = 30_000; // 30 seconds

export function useLeaveByCountdown(): void {
  const tick = useWaitTimeStore((s) => s.tick);
  const urgencyLevel = useWaitTimeStore((s) => s.urgencyLevel);
  const prevUrgencyRef = useRef(urgencyLevel);

  // ── Ticker ────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(tick, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tick]);

  // ── Urgency transition side-effects ──────────────────────
  useEffect(() => {
    const prev = prevUrgencyRef.current;
    prevUrgencyRef.current = urgencyLevel;

    if (prev === urgencyLevel) return;

    // Fire haptic feedback on urgency escalation
    if (urgencyLevel === 'soon'     && prev === 'safe')   triggerHaptic('medium');
    if (urgencyLevel === 'urgent'   && prev === 'soon')   triggerHaptic('heavy');
    if (urgencyLevel === 'critical')                       triggerHaptic('error');
  }, [urgencyLevel]);
}

// ── Haptic helper (expo-haptics) ─────────────────────────────
import * as Haptics from 'expo-haptics';

function triggerHaptic(type: 'medium' | 'heavy' | 'error'): void {
  if (type === 'medium') {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  } else if (type === 'heavy') {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
  } else {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
  }
}
