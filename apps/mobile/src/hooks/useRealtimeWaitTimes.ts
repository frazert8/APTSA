// ============================================================
// useRealtimeWaitTimes
// Subscribes to Supabase Realtime on the wait_time_snapshots table
// for the selected terminal. On INSERT, pushes update into Zustand.
// ============================================================

import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useWaitTimeStore } from '../stores/waitTimeStore';
import type { WaitTimeData } from '../stores/waitTimeStore';

interface WaitTimeSnapshotRow {
  id: string;
  terminal_id: string;
  source: 'tsa_official' | 'crowd_aggregate' | 'hybrid';
  wait_minutes: number;
  confidence_score: number;
  sample_size: number;
  captured_at: string;
}

export function useRealtimeWaitTimes(terminalId: string | null | undefined): void {
  const setWaitTimeData = useWaitTimeStore((s) => s.setWaitTimeData);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!terminalId) return;

    // Unsubscribe from any previous channel
    channelRef.current?.unsubscribe();

    channelRef.current = supabase
      .channel(`terminal_snapshots:${terminalId}`, {
        config: { broadcast: { self: false } },
      })
      .on<WaitTimeSnapshotRow>(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'wait_time_snapshots',
          filter: `terminal_id=eq.${terminalId}`,
        },
        ({ new: snapshot }) => {
          const update: WaitTimeData = {
            estimatedWaitMinutes: snapshot.wait_minutes,
            confidenceScore:      snapshot.confidence_score,
            sampleSize:           snapshot.sample_size,
            source:               snapshot.source,
            lastUpdated:          new Date(snapshot.captured_at),
          };
          setWaitTimeData(update);
        },
      )
      .subscribe();

    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [terminalId, setWaitTimeData]);
}
