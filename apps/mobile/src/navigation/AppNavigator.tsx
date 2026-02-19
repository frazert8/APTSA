// ============================================================
// AppNavigator
// Root navigator: shows AuthScreen if no session, HomeScreen
// if authenticated, and FlightInputScreen as a modal.
// ============================================================

import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { HomeScreen } from '../screens/HomeScreen';
import { AuthScreen } from '../screens/AuthScreen';
import { FlightInputScreen } from '../screens/FlightInputScreen';
import { COLORS } from '../theme';

// ── Route param types ─────────────────────────────────────────

export type RootStackParamList = {
  Auth: undefined;
  Home: undefined;
  FlightInput: undefined;
};

export type HomeScreenProps     = NativeStackScreenProps<RootStackParamList, 'Home'>;
export type FlightInputProps    = NativeStackScreenProps<RootStackParamList, 'FlightInput'>;

const Stack = createNativeStackNavigator<RootStackParamList>();

// ── Navigator ─────────────────────────────────────────────────

export function AppNavigator() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: COLORS.bg },
          animation: 'fade_from_bottom',
        }}
      >
        {session == null ? (
          <Stack.Screen name="Auth" component={AuthScreen} />
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen
              name="FlightInput"
              component={FlightInputScreen}
              options={{
                presentation: 'modal',
                animation: 'slide_from_bottom',
              }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
