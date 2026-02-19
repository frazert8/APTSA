// ============================================================
// WaitTimeCard
// Shows current wait time for a checkpoint with a live
// activity indicator that pulses while data is fresh.
// ============================================================

import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSpring,
  FadeInUp,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { COLORS, URGENCY_COLORS, TYPOGRAPHY, SPACING, RADII, GLASS_CARD } from '../theme';
import type { WaitTimeData } from '../stores/waitTimeStore';

interface WaitTimeCardProps {
  data: WaitTimeData;
  terminalName: string;
  isPrecheck?: boolean;
  index?: number;
}

export function WaitTimeCard({ data, terminalName, isPrecheck = false, index = 0 }: WaitTimeCardProps) {
  const minutes = data.estimatedWaitMinutes;

  // Map wait time to urgency-style color
  const urgency =
    minutes < 15 ? 'safe' :
    minutes < 30 ? 'soon' :
    minutes < 50 ? 'urgent' :
    'critical' as const;

  const colors = URGENCY_COLORS[urgency];

  // "Live" dot pulse
  const dotOpacity = useSharedValue(1);
  useEffect(() => {
    dotOpacity.value = withRepeat(withTiming(0.2, { duration: 1200 }), -1, true);
  }, [dotOpacity]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: dotOpacity.value }));

  // Fresh data flash
  const bgHighlight = useSharedValue(0);
  useEffect(() => {
    bgHighlight.value = 1;
    bgHighlight.value = withTiming(0, { duration: 1500 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.lastUpdated.getTime()]);
  const flashStyle = useAnimatedStyle(() => ({
    opacity: bgHighlight.value * 0.12,
  }));

  return (
    <Animated.View entering={FadeInUp.delay(index * 80).springify()}>
      <View style={[GLASS_CARD, styles.card]}>
        <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFillObject} />

        {/* Flash overlay on new data */}
        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: colors.primary },
            flashStyle,
          ]}
        />

        <LinearGradient
          colors={['rgba(255,255,255,0.04)', 'rgba(255,255,255,0.00)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {/* Left: terminal info */}
        <View style={styles.infoCol}>
          <View style={styles.titleRow}>
            {isPrecheck && (
              <View style={styles.precheckBadge}>
                <Text style={styles.precheckText}>PRE✓</Text>
              </View>
            )}
            <Text style={TYPOGRAPHY.body} numberOfLines={1}>{terminalName}</Text>
          </View>
          <Text style={TYPOGRAPHY.bodySmall}>
            {data.sampleSize > 0
              ? `${data.sampleSize} reports · ${data.source}`
              : 'TSA official'}
          </Text>
        </View>

        {/* Right: wait time + live indicator */}
        <View style={styles.waitCol}>
          <Animated.View style={[styles.liveDot, { backgroundColor: colors.primary }, dotStyle]} />
          <Text style={[styles.waitMinutes, { color: colors.primary }]}>
            {minutes}
          </Text>
          <Text style={[TYPOGRAPHY.label, { color: colors.secondary }]}>min</Text>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  infoCol: {
    flex: 1,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  precheckBadge: {
    backgroundColor: 'rgba(34, 211, 238, 0.15)',
    borderRadius: RADII.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.40)',
  },
  precheckText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.confHigh,
    letterSpacing: 0.5,
  },
  waitCol: {
    alignItems: 'center',
    gap: 2,
  },
  waitMinutes: {
    fontFamily: 'Courier New',
    fontSize: 40,
    fontWeight: '700',
    lineHeight: 44,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginBottom: 2,
  },
});
