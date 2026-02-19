// ============================================================
// HomeScreen — Main orchestration screen
// Wires together: terminal selector, realtime subscription,
// route fetching, leave-by card, and wait time list.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  StatusBar,
  SafeAreaView,
  Pressable,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { useNavigation } from '@react-navigation/native';
import { useWaitTimeStore } from '../stores/waitTimeStore';
import { useRealtimeWaitTimes } from '../hooks/useRealtimeWaitTimes';
import { useRoute } from '../hooks/useRoute';
import { LeaveByCountdown } from '../components/LeaveByCountdown';
import { WaitTimeCard } from '../components/WaitTimeCard';
import { LiveCheckSheet } from '../components/LiveCheckSheet';
import { COLORS, TYPOGRAPHY, SPACING, RADII } from '../theme';
import type { Terminal, WaitTimeData } from '../stores/waitTimeStore';

const API_BASE = process.env['EXPO_PUBLIC_API_URL'] ?? '';

export function HomeScreen() {
  const selectedTerminal  = useWaitTimeStore((s) => s.selectedTerminal);
  const setTerminal       = useWaitTimeStore((s) => s.setTerminal);
  const setWaitTimeData   = useWaitTimeStore((s) => s.setWaitTimeData);
  const waitTimeData      = useWaitTimeStore((s) => s.waitTimeData);

  const [terminals, setTerminals]       = useState<Terminal[]>([]);
  const navigation                      = useNavigation<any>();
  const [showSheet, setShowSheet]       = useState(false);
  const flightDepartureTime             = useWaitTimeStore((s) => s.flightDepartureTime);
  const airportIata                     = useWaitTimeStore((s) => s.selectedTerminal?.airportIata ?? 'ATL');

  // ── Wire hooks ────────────────────────────────────────────
  useRealtimeWaitTimes(selectedTerminal?.id);
  useRoute();

  // ── Load terminals for selected airport ─────────────────
  useEffect(() => {
    fetch(`${API_BASE}/api/terminals?airportIata=${airportIata}`)
      .then((r) => r.json())
      .then((data: Terminal[]) => {
        setTerminals(data);
        if (data[0] && !selectedTerminal) setTerminal(data[0]);
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airportIata]);

  // ── Fetch initial wait time on terminal change ───────────
  useEffect(() => {
    if (!selectedTerminal) return;
    fetch(`${API_BASE}/api/wait-times/${selectedTerminal.id}`)
      .then((r) => r.json())
      .then((data: WaitTimeData & { lastUpdated: string; source: string }) => {
        setWaitTimeData({
          estimatedWaitMinutes: data.estimatedWaitMinutes,
          confidenceScore:      data.confidenceScore,
          sampleSize:           data.sampleSize,
          source:               data.source as WaitTimeData['source'],
          lastUpdated:          new Date(data.lastUpdated),
        });
      })
      .catch(console.error);
  }, [selectedTerminal, setWaitTimeData]);

  const handleCloseSheet = useCallback(() => setShowSheet(false), []);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Full-bleed background gradient */}
      <LinearGradient
        colors={[COLORS.bg, '#0D1526', COLORS.bg]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFillObject}
      />

      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <Animated.View entering={FadeIn.duration(600)} style={styles.header}>
            <View>
              <Text style={[TYPOGRAPHY.label, { color: COLORS.textMuted }]}>
                {airportIata} · {selectedTerminal?.terminalCode ?? '—'}
              </Text>
              <Text style={TYPOGRAPHY.headline}>SwiftClear</Text>
            </View>
            <View style={styles.headerButtons}>
              <Pressable
                onPress={() => navigation.navigate('FlightInput')}
                style={[styles.reportBtn, { marginRight: SPACING.xs }]}
              >
                <Text style={styles.reportBtnText}>
                  {flightDepartureTime
                    ? flightDepartureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '✈ Set Flight'}
                </Text>
              </Pressable>
              <Pressable onPress={() => setShowSheet(true)} style={styles.reportBtn}>
                <Text style={styles.reportBtnText}>+ Report</Text>
              </Pressable>
            </View>
          </Animated.View>

          {/* Terminal selector pills */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.terminalPills}
          >
            {terminals.map((t) => {
              const active = t.id === selectedTerminal?.id;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => setTerminal(t)}
                  style={[
                    styles.terminalPill,
                    active && { borderColor: COLORS.accent + '90', backgroundColor: COLORS.accent + '18' },
                  ]}
                >
                  {t.isPrecheck && (
                    <Text style={styles.precheckMark}>✓ </Text>
                  )}
                  <Text
                    style={[
                      TYPOGRAPHY.pillLabel,
                      active && { color: COLORS.accent },
                    ]}
                    numberOfLines={1}
                  >
                    {t.terminalCode} · {t.checkpointName}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Leave By card */}
          <LeaveByCountdown />

          {/* Wait time cards for all terminals */}
          <Text style={[TYPOGRAPHY.label, styles.sectionLabel]}>
            All Checkpoints
          </Text>
          {terminals.map((t, i) => (
            waitTimeData && t.id === selectedTerminal?.id
              ? <WaitTimeCard
                  key={t.id}
                  data={waitTimeData}
                  terminalName={`${t.terminalCode} · ${t.checkpointName}`}
                  isPrecheck={t.isPrecheck}
                  index={i}
                />
              : null
          ))}
        </ScrollView>
      </SafeAreaView>

      {/* Live Check bottom sheet */}
      {showSheet && <LiveCheckSheet onClose={handleCloseSheet} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  safe: { flex: 1 },
  scroll: {
    paddingBottom: SPACING.xxl,
    gap: SPACING.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reportBtn: {
    backgroundColor: COLORS.accent + '20',
    borderWidth: 1,
    borderColor: COLORS.accent + '60',
    borderRadius: RADII.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  reportBtnText: {
    color: COLORS.accent,
    fontWeight: '600',
    fontSize: 14,
  },
  terminalPills: {
    paddingHorizontal: SPACING.md,
    gap: SPACING.sm,
  },
  terminalPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: 'rgba(255,255,255,0.03)',
    maxWidth: 220,
  },
  precheckMark: {
    color: COLORS.confHigh,
    fontWeight: '700',
    fontSize: 12,
  },
  sectionLabel: {
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.sm,
  },
});
