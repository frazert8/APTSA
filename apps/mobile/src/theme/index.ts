// ============================================================
// SwiftClear — Design System Tokens
// Aesthetic: Dark Glassmorphism
//   • Frosted dark panels (BlurView + semi-transparent fills)
//   • Thin glowing borders keyed to urgency
//   • Monospaced countdown digits; humanist sans for labels
//   • Urgency color system: Blue → Amber → Orange → Red
// ============================================================

import type { UrgencyLevel } from '../stores/waitTimeStore';

// ── Color Palette ─────────────────────────────────────────────

export const COLORS = {
  // Background — very dark navy, evokes a night terminal
  bg:           '#080C14',
  bgCard:       'rgba(14, 20, 34, 0.75)',   // glass panel fill
  bgElevated:   'rgba(22, 30, 50, 0.85)',

  // Surface borders
  borderSubtle: 'rgba(255,255,255,0.06)',
  borderGlass:  'rgba(255,255,255,0.12)',

  // Text
  textPrimary:   '#F0F4FF',
  textSecondary: 'rgba(180, 195, 230, 0.70)',
  textMuted:     'rgba(130, 150, 190, 0.50)',

  // Accent — electric blue (brand idle state)
  accent:        '#3B82F6',
  accentGlow:    'rgba(59, 130, 246, 0.25)',

  // Confidence meter fill
  confHigh:      '#22D3EE',
  confMed:       '#A78BFA',
  confLow:       '#FB923C',
} as const;

// ── Urgency Color Map ─────────────────────────────────────────
// Each level has a primary glow, secondary label, and gradient pair.

export const URGENCY_COLORS: Record<
  UrgencyLevel,
  { primary: string; secondary: string; gradient: [string, string]; label: string }
> = {
  unknown:  { primary: '#3B82F6', secondary: '#93C5FD', gradient: ['#1D4ED8', '#3B82F6'], label: 'Calculating…' },
  safe:     { primary: '#22D3EE', secondary: '#67E8F9', gradient: ['#0E7490', '#22D3EE'], label: 'Plenty of Time' },
  soon:     { primary: '#FBBF24', secondary: '#FDE68A', gradient: ['#B45309', '#FBBF24'], label: 'Leave Soon' },
  urgent:   { primary: '#F97316', secondary: '#FDBA74', gradient: ['#C2410C', '#F97316'], label: 'Leave Now' },
  critical: { primary: '#EF4444', secondary: '#FCA5A5', gradient: ['#991B1B', '#EF4444'], label: 'Running Late!' },
};

// ── Typography ────────────────────────────────────────────────

export const TYPOGRAPHY = {
  // Countdown digits — monospace for stable layout
  countdownXL: {
    fontFamily: 'Courier New',
    fontWeight: '700' as const,
    fontSize: 72,
    letterSpacing: -2,
    color: COLORS.textPrimary,
  },
  countdownLG: {
    fontFamily: 'Courier New',
    fontWeight: '700' as const,
    fontSize: 48,
    letterSpacing: -1,
    color: COLORS.textPrimary,
  },
  // Labels
  label: {
    fontFamily: 'System',
    fontWeight: '600' as const,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
    color: COLORS.textSecondary,
  },
  body: {
    fontFamily: 'System',
    fontWeight: '400' as const,
    fontSize: 15,
    color: COLORS.textPrimary,
  },
  bodySmall: {
    fontFamily: 'System',
    fontWeight: '400' as const,
    fontSize: 13,
    color: COLORS.textSecondary,
  },
  headline: {
    fontFamily: 'System',
    fontWeight: '700' as const,
    fontSize: 22,
    color: COLORS.textPrimary,
  },
  pillLabel: {
    fontFamily: 'System',
    fontWeight: '600' as const,
    fontSize: 12,
    color: COLORS.textSecondary,
  },
} as const;

// ── Spacing ───────────────────────────────────────────────────

export const SPACING = {
  xs:  4,
  sm:  8,
  md:  16,
  lg:  24,
  xl:  32,
  xxl: 48,
} as const;

// ── Radii ─────────────────────────────────────────────────────

export const RADII = {
  sm:     8,
  md:     14,
  lg:     20,
  xl:     28,
  pill:   100,
} as const;

// ── Glass panel style (shared base) ──────────────────────────

export const GLASS_CARD = {
  backgroundColor: COLORS.bgCard,
  borderRadius:    RADII.xl,
  borderWidth:     1,
  borderColor:     COLORS.borderGlass,
  overflow:        'hidden' as const,
} as const;
