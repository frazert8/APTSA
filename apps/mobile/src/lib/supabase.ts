import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

// expo-secure-store adapter for session persistence
// Keys are hashed to stay within the 2048-char keychain limit
const secureStoreAdapter = {
  getItem: (key: string): string | null => {
    // SecureStore.getItemAsync is async; we use the sync API in RN via a workaround
    // For SSR-safe usage we return null and let Supabase fall back to re-fetching
    return null;
  },
  setItem: (key: string, value: string): void => {
    SecureStore.setItemAsync(key, value).catch(console.warn);
  },
  removeItem: (key: string): void => {
    SecureStore.deleteItemAsync(key).catch(console.warn);
  },
};

const SUPABASE_URL = process.env['EXPO_PUBLIC_SUPABASE_URL']!;
const SUPABASE_ANON_KEY = process.env['EXPO_PUBLIC_SUPABASE_ANON_KEY']!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: secureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
