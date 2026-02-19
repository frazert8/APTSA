// ============================================================
// FlightInputScreen (modal)
// User picks: airport → terminal → departure date/time.
// Sets flightDepartureTime in the Zustand store and dismisses.
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useNavigation } from '@react-navigation/native';
import { useWaitTimeStore } from '../stores/waitTimeStore';
import { COLORS, TYPOGRAPHY, SPACING, RADII, GLASS_CARD } from '../theme';
import type { Terminal } from '../stores/waitTimeStore';

const API_BASE = process.env['EXPO_PUBLIC_API_URL'] ?? '';

// ── Time picker helpers ───────────────────────────────────────

const HOURS   = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function pad(n: number) { return String(n).padStart(2, '0'); }

// Common US airports for quick-pick
const QUICK_AIRPORTS = [
  { iata: 'ATL', label: 'Atlanta (ATL)' },
  { iata: 'LAX', label: 'Los Angeles (LAX)' },
  { iata: 'ORD', label: 'Chicago O\'Hare (ORD)' },
  { iata: 'DFW', label: 'Dallas/FW (DFW)' },
  { iata: 'DEN', label: 'Denver (DEN)' },
  { iata: 'JFK', label: 'New York JFK (JFK)' },
  { iata: 'SFO', label: 'San Francisco (SFO)' },
  { iata: 'LAS', label: 'Las Vegas (LAS)' },
  { iata: 'SEA', label: 'Seattle (SEA)' },
  { iata: 'MCO', label: 'Orlando (MCO)' },
];

export function FlightInputScreen() {
  const navigation = useNavigation();
  const setTerminal          = useWaitTimeStore((s) => s.setTerminal);
  const setFlightDeparture   = useWaitTimeStore((s) => s.setFlightDepartureTime);
  const currentTerminal      = useWaitTimeStore((s) => s.selectedTerminal);

  const [selectedIata, setSelectedIata]   = useState(currentTerminal?.airportIata ?? 'ATL');
  const [terminals, setTerminals]         = useState<Terminal[]>([]);
  const [selectedTerminal, setSelected]   = useState<Terminal | null>(currentTerminal);
  const [loadingTerminals, setLoading]    = useState(false);

  // Time state: today's date + user-chosen hour/minute
  const now = new Date();
  const [hour, setHour]     = useState(now.getHours());
  const [minute, setMinute] = useState(Math.ceil(now.getMinutes() / 5) * 5 % 60);
  // +1 day if past chosen time
  const getFlightTime = useCallback(() => {
    const t = new Date();
    t.setHours(hour, minute, 0, 0);
    if (t <= new Date()) t.setDate(t.getDate() + 1);
    return t;
  }, [hour, minute]);

  // ── Fetch terminals when airport changes ─────────────────
  useEffect(() => {
    setLoading(true);
    setSelected(null);
    fetch(`${API_BASE}/api/terminals?airportIata=${selectedIata}`)
      .then((r) => r.json())
      .then((data: Terminal[]) => {
        setTerminals(data);
        if (data[0]) setSelected(data[0]);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedIata]);

  const handleConfirm = useCallback(() => {
    if (!selectedTerminal) return;
    setTerminal(selectedTerminal);
    setFlightDeparture(getFlightTime());
    navigation.goBack();
  }, [selectedTerminal, setTerminal, setFlightDeparture, getFlightTime, navigation]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[COLORS.bg, '#0D1526']}
        style={StyleSheet.absoluteFillObject}
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Handle + title */}
        <View style={styles.handle} />
        <Text style={[TYPOGRAPHY.headline, { marginBottom: 4 }]}>Your Flight</Text>
        <Text style={[TYPOGRAPHY.bodySmall, { marginBottom: SPACING.lg }]}>
          We'll calculate exactly when you need to leave.
        </Text>

        {/* ── Airport quick-pick ── */}
        <Text style={[TYPOGRAPHY.label, styles.sectionLabel]}>Airport</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pillScroll}>
          {QUICK_AIRPORTS.map((ap) => (
            <Pressable
              key={ap.iata}
              onPress={() => setSelectedIata(ap.iata)}
              style={[
                styles.chip,
                selectedIata === ap.iata && styles.chipActive,
              ]}
            >
              <Text style={[
                TYPOGRAPHY.pillLabel,
                selectedIata === ap.iata && { color: COLORS.accent },
              ]}>
                {ap.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {/* ── Terminal picker ── */}
        <Text style={[TYPOGRAPHY.label, styles.sectionLabel]}>Checkpoint</Text>
        {loadingTerminals ? (
          <ActivityIndicator color={COLORS.accent} style={{ marginVertical: SPACING.md }} />
        ) : (
          <View style={styles.terminalList}>
            {terminals.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setSelected(t)}
                style={[GLASS_CARD, styles.terminalRow,
                  selectedTerminal?.id === t.id && {
                    borderColor: COLORS.accent + '70',
                    backgroundColor: COLORS.accent + '12',
                  },
                ]}
              >
                <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFillObject} />
                <View style={styles.terminalRowContent}>
                  {t.isPrecheck && (
                    <View style={styles.precheckBadge}>
                      <Text style={styles.precheckText}>PRE✓</Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={TYPOGRAPHY.body}>{t.terminalCode}</Text>
                    <Text style={TYPOGRAPHY.bodySmall}>{t.checkpointName}</Text>
                  </View>
                  <Text style={[TYPOGRAPHY.bodySmall, { color: COLORS.textMuted }]}>
                    ~{t.walkToGateMinutes}m to gate
                  </Text>
                  {selectedTerminal?.id === t.id && (
                    <Text style={{ color: COLORS.accent, marginLeft: SPACING.sm, fontSize: 18 }}>✓</Text>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        )}

        {/* ── Departure time ── */}
        <Text style={[TYPOGRAPHY.label, styles.sectionLabel]}>Departure Time</Text>
        <Animated.View entering={FadeInDown.springify()} style={[GLASS_CARD, styles.timePicker]}>
          <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFillObject} />

          <View style={styles.timeRow}>
            {/* Hour scroll */}
            <ScrollView
              style={styles.timeColumn}
              showsVerticalScrollIndicator={false}
              snapToInterval={44}
              decelerationRate="fast"
            >
              {HOURS.map((h) => (
                <Pressable key={h} onPress={() => setHour(h)} style={styles.timeItem}>
                  <Text style={[
                    styles.timeItemText,
                    h === hour && { color: COLORS.accent, fontWeight: '700' },
                  ]}>
                    {pad(h)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <Text style={styles.timeSep}>:</Text>

            {/* Minute scroll */}
            <ScrollView
              style={styles.timeColumn}
              showsVerticalScrollIndicator={false}
              snapToInterval={44}
              decelerationRate="fast"
            >
              {MINUTES.map((m) => (
                <Pressable key={m} onPress={() => setMinute(m)} style={styles.timeItem}>
                  <Text style={[
                    styles.timeItemText,
                    m === minute && { color: COLORS.accent, fontWeight: '700' },
                  ]}>
                    {pad(m)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          {/* Preview */}
          <Text style={[TYPOGRAPHY.bodySmall, { textAlign: 'center', marginTop: SPACING.sm }]}>
            Departs at{' '}
            <Text style={{ color: COLORS.accent }}>
              {pad(hour)}:{pad(minute)}
            </Text>
            {' '}· {getFlightTime().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          </Text>
        </Animated.View>

        {/* ── Confirm ── */}
        <Pressable
          onPress={handleConfirm}
          disabled={!selectedTerminal}
          style={({ pressed }) => [styles.confirmBtn, pressed && { opacity: 0.85 }]}
        >
          <LinearGradient
            colors={selectedTerminal ? ['#1D4ED8', '#3B82F6'] : ['#1e2a3a', '#1e2a3a']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.confirmGradient}
          >
            <Text style={styles.confirmText}>
              {selectedTerminal ? 'Calculate Leave Time →' : 'Select a checkpoint'}
            </Text>
          </LinearGradient>
        </Pressable>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  scroll: { padding: SPACING.lg, paddingBottom: SPACING.xxl },
  handle: {
    width: 40, height: 4,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.borderGlass,
    alignSelf: 'center',
    marginBottom: SPACING.lg,
  },
  sectionLabel: { marginBottom: SPACING.sm, marginTop: SPACING.md },
  pillScroll: { marginBottom: SPACING.sm },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    marginRight: SPACING.xs,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  chipActive: {
    borderColor: COLORS.accent + '70',
    backgroundColor: COLORS.accent + '15',
  },
  terminalList: { gap: SPACING.sm },
  terminalRow: {
    overflow: 'hidden',
    padding: SPACING.md,
  },
  terminalRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  precheckBadge: {
    backgroundColor: 'rgba(34,211,238,0.15)',
    borderRadius: RADII.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.40)',
  },
  precheckText: {
    fontSize: 10, fontWeight: '700',
    color: '#22D3EE', letterSpacing: 0.5,
  },
  timePicker: {
    padding: SPACING.md,
    overflow: 'hidden',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 180,
  },
  timeColumn: { width: 80, height: 180 },
  timeItem: {
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  timeItemText: {
    fontFamily: 'Courier New',
    fontSize: 22,
    color: COLORS.textMuted,
  },
  timeSep: {
    fontFamily: 'Courier New',
    fontSize: 30,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginHorizontal: SPACING.sm,
    marginBottom: 8,
  },
  confirmBtn: {
    borderRadius: RADII.lg,
    overflow: 'hidden',
    marginTop: SPACING.xl,
  },
  confirmGradient: {
    paddingVertical: SPACING.md + 2,
    alignItems: 'center',
    borderRadius: RADII.lg,
  },
  confirmText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.2,
  },
});
