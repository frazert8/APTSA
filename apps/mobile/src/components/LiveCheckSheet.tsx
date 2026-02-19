// ============================================================
// LiveCheckSheet
// Bottom sheet for submitting a crowdsourced wait time.
// Slider input (0–120 min) with animated tick marks.
// Geofence status shown inline — green badge if detected.
// ============================================================

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../lib/supabase';
import { useWaitTimeStore } from '../stores/waitTimeStore';
import { COLORS, URGENCY_COLORS, TYPOGRAPHY, SPACING, RADII } from '../theme';

const API_BASE = process.env['EXPO_PUBLIC_API_URL'] ?? '';
const STEPS = [0, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120];

interface Props {
  onClose: () => void;
}

export function LiveCheckSheet({ onClose }: Props) {
  const selectedTerminal  = useWaitTimeStore((s) => s.selectedTerminal);
  const [waitMinutes, setWaitMinutes]   = useState(15);
  const [submitting, setSubmitting]     = useState(false);
  const [submitted, setSubmitted]       = useState(false);
  const [error, setError]               = useState<string | null>(null);

  const handleStepSelect = useCallback((val: number) => setWaitMinutes(val), []);

  const handleSubmit = useCallback(async () => {
    if (!selectedTerminal) return;

    setSubmitting(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('Sign in to submit a check');
        return;
      }

      const resp = await fetch(`${API_BASE}/api/checks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          terminalId:  selectedTerminal.id,
          waitMinutes,
          // Location: fetched separately by useRoute; pass null here for privacy
          // The backend verifies geofence server-side if coords are provided
        }),
      });

      const body = await resp.json() as { error?: string };

      if (!resp.ok) {
        setError(body.error ?? 'Submission failed');
        return;
      }

      setSubmitted(true);
      setTimeout(onClose, 1800);
    } catch {
      setError('Network error — check your connection');
    } finally {
      setSubmitting(false);
    }
  }, [selectedTerminal, waitMinutes, onClose]);

  const color = URGENCY_COLORS[
    waitMinutes < 15 ? 'safe' :
    waitMinutes < 30 ? 'soon' :
    waitMinutes < 50 ? 'urgent' : 'critical'
  ];

  return (
    <Animated.View
      entering={FadeInDown.springify().damping(22)}
      exiting={FadeOutDown.duration(250)}
      style={styles.sheet}
    >
      <BlurView intensity={36} tint="dark" style={StyleSheet.absoluteFillObject} />
      <LinearGradient
        colors={['rgba(14,20,34,0.92)', 'rgba(8,12,20,0.98)']}
        style={StyleSheet.absoluteFillObject}
      />

      {/* Handle bar */}
      <View style={styles.handle} />

      <Text style={[TYPOGRAPHY.headline, styles.title]}>Report Wait Time</Text>
      {selectedTerminal && (
        <Text style={TYPOGRAPHY.bodySmall}>{selectedTerminal.checkpointName}</Text>
      )}

      {/* Wait time display */}
      <View style={styles.bigNumberRow}>
        <Text style={[styles.bigNumber, { color: color.primary }]}>{waitMinutes}</Text>
        <Text style={[TYPOGRAPHY.label, { color: color.secondary, alignSelf: 'flex-end', marginBottom: 12 }]}>
          minutes
        </Text>
      </View>

      {/* Step selector */}
      <View style={styles.stepRow}>
        {STEPS.map((val) => {
          const active = val === waitMinutes;
          return (
            <Pressable
              key={val}
              onPress={() => handleStepSelect(val)}
              style={({ pressed }) => [
                styles.stepBtn,
                active && { backgroundColor: color.primary + '25', borderColor: color.primary + '70' },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={[
                  TYPOGRAPHY.pillLabel,
                  active && { color: color.primary, fontWeight: '700' },
                ]}
              >
                {val === 0 ? 'None' : `${val}`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Submit */}
      {error && (
        <Text style={styles.errorText}>{error}</Text>
      )}

      <Pressable
        onPress={handleSubmit}
        disabled={submitting || submitted}
        style={({ pressed }) => [styles.submitBtn, pressed && { opacity: 0.85 }]}
      >
        <LinearGradient
          colors={submitted ? ['#16A34A', '#22C55E'] : [color.gradient[0], color.gradient[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.submitGradient}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitText}>
              {submitted ? 'Thanks! Reported.' : 'Submit Report'}
            </Text>
          )}
        </LinearGradient>
      </Pressable>

      <Text style={[TYPOGRAPHY.bodySmall, styles.disclaimerText]}>
        Reports expire after 45 min. Being physically at the checkpoint
        boosts your report's trust weight.
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: RADII.xl,
    borderTopRightRadius: RADII.xl,
    borderTopWidth: 1,
    borderColor: COLORS.borderGlass,
    padding: SPACING.lg,
    paddingBottom: SPACING.xxl,
    overflow: 'hidden',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.borderGlass,
    alignSelf: 'center',
    marginBottom: SPACING.md,
  },
  title: {
    marginBottom: SPACING.xs,
  },
  bigNumberRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: SPACING.sm,
    marginVertical: SPACING.lg,
    justifyContent: 'center',
  },
  bigNumber: {
    fontFamily: 'Courier New',
    fontSize: 80,
    fontWeight: '700',
    lineHeight: 84,
  },
  stepRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    justifyContent: 'center',
    marginBottom: SPACING.lg,
  },
  stepBtn: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  submitBtn: {
    borderRadius: RADII.lg,
    overflow: 'hidden',
  },
  submitGradient: {
    paddingVertical: SPACING.md,
    alignItems: 'center',
    borderRadius: RADII.lg,
  },
  submitText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.3,
  },
  disclaimerText: {
    textAlign: 'center',
    marginTop: SPACING.md,
    opacity: 0.45,
    lineHeight: 18,
  },
  errorText: {
    color: URGENCY_COLORS.critical.primary,
    textAlign: 'center',
    marginBottom: SPACING.sm,
    fontSize: 13,
  },
});
