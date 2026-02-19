// ============================================================
// AuthScreen — Magic link sign-in
// Glassmorphic card. No password. Supabase sends a 6-digit OTP.
// ============================================================

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { supabase } from '../lib/supabase';
import { COLORS, TYPOGRAPHY, SPACING, RADII, GLASS_CARD } from '../theme';

type Step = 'email' | 'otp';

export function AuthScreen() {
  const [step, setStep]       = useState<Step>('email');
  const [email, setEmail]     = useState('');
  const [otp, setOtp]         = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [sentTo, setSentTo]   = useState('');

  const handleSendOtp = useCallback(async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes('@')) { setError('Enter a valid email'); return; }
    setError(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { shouldCreateUser: true },
      });
      if (error) { setError(error.message); return; }
      setSentTo(trimmed);
      setStep('otp');
    } finally {
      setLoading(false);
    }
  }, [email]);

  const handleVerifyOtp = useCallback(async () => {
    if (otp.length < 6) { setError('Enter the 6-digit code'); return; }
    setError(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: sentTo,
        token: otp.trim(),
        type: 'email',
      });
      if (error) setError(error.message);
      // On success, onAuthStateChange in AppNavigator will switch to Home
    } finally {
      setLoading(false);
    }
  }, [otp, sentTo]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[COLORS.bg, '#0D1526', COLORS.bg]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFillObject}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.kav}
      >
        {/* Wordmark */}
        <Animated.View entering={FadeInDown.delay(100).springify()} style={styles.wordmarkRow}>
          <Text style={styles.wordmark}>SwiftClear</Text>
          <Text style={[TYPOGRAPHY.bodySmall, { textAlign: 'center', marginTop: SPACING.xs }]}>
            Real-time TSA wait times + crowdsourced reports
          </Text>
        </Animated.View>

        {/* Card */}
        <Animated.View entering={FadeInUp.delay(200).springify()} style={GLASS_CARD}>
          <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFillObject} />
          <LinearGradient
            colors={['rgba(59,130,246,0.10)', 'rgba(8,12,20,0.00)']}
            style={StyleSheet.absoluteFillObject}
          />

          <View style={styles.cardContent}>
            {step === 'email' ? (
              <>
                <Text style={TYPOGRAPHY.headline}>Sign In</Text>
                <Text style={[TYPOGRAPHY.bodySmall, { marginTop: 4, marginBottom: SPACING.lg }]}>
                  We'll send a one-time code to your email.
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="you@email.com"
                  placeholderTextColor={COLORS.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={email}
                  onChangeText={setEmail}
                  onSubmitEditing={handleSendOtp}
                  returnKeyType="go"
                />
                {error && <Text style={styles.errorText}>{error}</Text>}
                <Pressable onPress={handleSendOtp} disabled={loading} style={styles.btn}>
                  <LinearGradient
                    colors={['#1D4ED8', '#3B82F6']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.btnGradient}
                  >
                    {loading
                      ? <ActivityIndicator color="#fff" />
                      : <Text style={styles.btnText}>Send Code</Text>
                    }
                  </LinearGradient>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={TYPOGRAPHY.headline}>Check Your Email</Text>
                <Text style={[TYPOGRAPHY.bodySmall, { marginTop: 4, marginBottom: SPACING.lg }]}>
                  Enter the 6-digit code sent to{'\n'}
                  <Text style={{ color: COLORS.accent }}>{sentTo}</Text>
                </Text>
                <TextInput
                  style={[styles.input, styles.otpInput]}
                  placeholder="000000"
                  placeholderTextColor={COLORS.textMuted}
                  keyboardType="number-pad"
                  maxLength={6}
                  value={otp}
                  onChangeText={setOtp}
                  onSubmitEditing={handleVerifyOtp}
                  returnKeyType="go"
                />
                {error && <Text style={styles.errorText}>{error}</Text>}
                <Pressable onPress={handleVerifyOtp} disabled={loading} style={styles.btn}>
                  <LinearGradient
                    colors={['#1D4ED8', '#3B82F6']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.btnGradient}
                  >
                    {loading
                      ? <ActivityIndicator color="#fff" />
                      : <Text style={styles.btnText}>Verify</Text>
                    }
                  </LinearGradient>
                </Pressable>
                <Pressable
                  onPress={() => { setStep('email'); setOtp(''); setError(null); }}
                  style={{ marginTop: SPACING.md, alignItems: 'center' }}
                >
                  <Text style={[TYPOGRAPHY.bodySmall, { color: COLORS.accent }]}>
                    Wrong email? Go back
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  kav: {
    flex: 1,
    justifyContent: 'center',
    gap: SPACING.xl,
  },
  wordmarkRow: {
    alignItems: 'center',
  },
  wordmark: {
    fontFamily: 'Courier New',
    fontSize: 34,
    fontWeight: '700',
    color: COLORS.textPrimary,
    letterSpacing: -1,
  },
  cardContent: {
    padding: SPACING.lg,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: COLORS.borderGlass,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 4,
    color: COLORS.textPrimary,
    fontSize: 16,
    marginBottom: SPACING.md,
  },
  otpInput: {
    fontSize: 28,
    letterSpacing: 12,
    textAlign: 'center',
    fontFamily: 'Courier New',
  },
  btn: {
    borderRadius: RADII.lg,
    overflow: 'hidden',
  },
  btnGradient: {
    paddingVertical: SPACING.md,
    alignItems: 'center',
    borderRadius: RADII.lg,
  },
  btnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 13,
    marginBottom: SPACING.sm,
  },
});
