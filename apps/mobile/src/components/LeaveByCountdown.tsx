// ============================================================
// LeaveByCountdown
// The centrepiece card — glassmorphic panel showing the
// leave-by time, live countdown, and time breakdown pills.
// Pulses on "critical"; fades in on mount with Reanimated 3.
// ============================================================

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { useWaitTimeStore, selectLeaveByDisplay, selectIsReady } from '../stores/waitTimeStore';
import { useLeaveByCountdown } from '../hooks/useLeaveByCountdown';
import {
  COLORS, URGENCY_COLORS, TYPOGRAPHY, SPACING, RADII, GLASS_CARD,
} from '../theme';

// ── Breakdown Pill ────────────────────────────────────────────

interface PillProps { label: string; value: string; accent: string }

function BreakdownPill({ label, value, accent }: PillProps) {
  return (
    <View style={[styles.pill, { borderColor: accent + '40' }]}>
      <Text style={[TYPOGRAPHY.pillLabel, { color: accent }]}>{label}</Text>
      <Text style={[styles.pillValue, { color: COLORS.textPrimary }]}>{value}</Text>
    </View>
  );
}

// ── Confidence Meter ──────────────────────────────────────────

function ConfidenceMeter({ score }: { score: number }) {
  const fillColor =
    score > 0.7 ? COLORS.confHigh :
    score > 0.4 ? COLORS.confMed  :
                  COLORS.confLow;

  const width = useSharedValue(0);
  const animStyle = useAnimatedStyle(() => ({ width: `${width.value}%` as `${number}%` }));

  useEffect(() => {
    width.value = withSpring(score * 100, { damping: 18 });
  }, [score, width]);

  return (
    <View style={styles.meterTrack}>
      <Animated.View style={[styles.meterFill, animStyle, { backgroundColor: fillColor }]} />
    </View>
  );
}

// ── Main Component ────────────────────────────────────────────

export function LeaveByCountdown() {
  // Activate the ticker
  useLeaveByCountdown();

  const { leaveByTime, minutesUntilLeave, urgencyLevel, breakdown } =
    useWaitTimeStore(selectLeaveByDisplay);
  const isReady     = useWaitTimeStore(selectIsReady);
  const waitTimeData = useWaitTimeStore((s) => s.waitTimeData);

  const colors   = URGENCY_COLORS[urgencyLevel];
  const isPast   = (minutesUntilLeave ?? 1) <= 0;
  const hoursLeft = minutesUntilLeave != null ? Math.floor(Math.abs(minutesUntilLeave) / 60) : 0;
  const minsLeft  = minutesUntilLeave != null ? Math.abs(minutesUntilLeave) % 60 : 0;

  // ── Pulse animation for critical urgency ─────────────────
  const scale = useSharedValue(1);
  const prevUrgency = useRef(urgencyLevel);

  useEffect(() => {
    if (urgencyLevel === 'critical' && prevUrgency.current !== 'critical') {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.03, { duration: 550 }),
          withTiming(1.00, { duration: 550 }),
        ),
        -1, // infinite
        true,
      );
    } else if (urgencyLevel !== 'critical') {
      scale.value = withSpring(1);
    }
    prevUrgency.current = urgencyLevel;
  }, [urgencyLevel, scale]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // ── Skeleton state ────────────────────────────────────────
  if (!isReady) {
    return (
      <Animated.View entering={FadeIn.duration(400)} style={[GLASS_CARD, styles.card, styles.skeletonCard]}>
        <BlurView intensity={24} tint="dark" style={StyleSheet.absoluteFillObject} />
        <Text style={[TYPOGRAPHY.label, { textAlign: 'center' }]}>
          Select terminal + enter flight time
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(500)} style={cardStyle}>
      <View style={[GLASS_CARD, styles.card]}>
        {/* Frosted blur background */}
        <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFillObject} />

        {/* Urgency gradient tint */}
        <LinearGradient
          colors={[colors.gradient[0] + '22', colors.gradient[1] + '08']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {/* Glowing top border */}
        <View style={[styles.topGlow, { backgroundColor: colors.primary + '40' }]} />

        {/* Header label */}
        <View style={styles.headerRow}>
          <Text style={[TYPOGRAPHY.label, { color: colors.secondary }]}>
            {isPast ? '⚠ RUNNING LATE' : 'LEAVE BY'}
          </Text>
          <View style={[styles.urgencyBadge, { backgroundColor: colors.primary + '20', borderColor: colors.primary + '50' }]}>
            <Text style={[TYPOGRAPHY.pillLabel, { color: colors.primary }]}>
              {colors.label}
            </Text>
          </View>
        </View>

        {/* Departure wall-clock time */}
        {leaveByTime && (
          <Text style={[styles.clockTime, { color: colors.primary }]}>
            {leaveByTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}

        {/* Live countdown digits */}
        <View style={styles.countdownRow}>
          {hoursLeft > 0 && (
            <>
              <Text style={[TYPOGRAPHY.countdownXL, { color: colors.primary }]}>
                {hoursLeft}
              </Text>
              <Text style={[styles.countdownUnit, { color: colors.secondary }]}>h </Text>
            </>
          )}
          <Text style={[TYPOGRAPHY.countdownXL, { color: colors.primary }]}>
            {String(minsLeft).padStart(2, '0')}
          </Text>
          <Text style={[styles.countdownUnit, { color: colors.secondary }]}>m</Text>
        </View>

        {/* Breakdown pills */}
        {breakdown && (
          <View style={styles.pillRow}>
            <BreakdownPill label="Drive"    value={`${breakdown.driveMinutes}m`}    accent={colors.secondary} />
            <BreakdownPill label="Security" value={`${breakdown.securityMinutes}m`} accent={colors.secondary} />
            <BreakdownPill label="Gate"     value={`${breakdown.gateWalkMinutes}m`} accent={colors.secondary} />
            <BreakdownPill label="Buffer"   value={`${breakdown.bufferMinutes}m`}   accent={colors.secondary} />
          </View>
        )}

        {/* Confidence meter */}
        {waitTimeData && (
          <View style={styles.confidenceRow}>
            <Text style={[TYPOGRAPHY.label, { flex: 1 }]}>
              Data confidence
            </Text>
            <ConfidenceMeter score={waitTimeData.confidenceScore} />
            <Text style={[TYPOGRAPHY.bodySmall, { marginLeft: SPACING.xs }]}>
              {Math.round(waitTimeData.confidenceScore * 100)}%
            </Text>
          </View>
        )}

        {/* Source + sample size footer */}
        {waitTimeData && (
          <Text style={[TYPOGRAPHY.bodySmall, styles.sourceLabel]}>
            {waitTimeData.source === 'hybrid'
              ? `TSA + ${waitTimeData.sampleSize} live checks`
              : waitTimeData.source === 'crowd_aggregate'
              ? `${waitTimeData.sampleSize} live checks`
              : 'TSA official data'}
            {' · updated '}
            {waitTimeData.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

// ── Styles ────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    padding: SPACING.lg,
    marginHorizontal: SPACING.md,
  },
  skeletonCard: {
    alignItems: 'center',
    paddingVertical: SPACING.xl,
  },
  topGlow: {
    position: 'absolute',
    top: 0,
    left: '10%',
    right: '10%',
    height: 1.5,
    borderRadius: RADII.pill,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  urgencyBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  clockTime: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: SPACING.xs,
    fontFamily: 'Courier New',
  },
  countdownRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginVertical: SPACING.sm,
  },
  countdownUnit: {
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 8,
  },
  pillRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
    marginTop: SPACING.md,
    flexWrap: 'wrap',
  },
  pill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xs,
    borderRadius: RADII.md,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    minWidth: 68,
  },
  pillValue: {
    fontFamily: 'Courier New',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 2,
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.md,
    gap: SPACING.sm,
  },
  meterTrack: {
    flex: 2,
    height: 4,
    borderRadius: RADII.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: RADII.pill,
  },
  sourceLabel: {
    marginTop: SPACING.sm,
    textAlign: 'center',
    opacity: 0.5,
  },
});
