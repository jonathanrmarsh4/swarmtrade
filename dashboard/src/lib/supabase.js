// Supabase client — single instance for the entire dashboard.
// Environment variables must be set on Railway with VITE_ prefix so Vite
// exposes them to the browser bundle:
//   VITE_SUPABASE_URL   → maps to SUPABASE_URL in Railway
//   VITE_SUPABASE_ANON_KEY → public anon key (safe for browser)
// The service key (SUPABASE_SERVICE_KEY) must never be used client-side.

import { createClient } from '@supabase/supabase-js';
import { useState, useEffect, useCallback } from 'react';

// Use placeholders that will be replaced at container startup if build-time vars aren't available
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '__VITE_SUPABASE_URL__';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '__VITE_SUPABASE_ANON_KEY__';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Subscribe to a Supabase table with real-time updates.
 *
 * @param {string} table - Table name to subscribe to.
 * @param {object} options
 * @param {string}  [options.orderBy]    - Column to order results by.
 * @param {boolean} [options.ascending]  - Sort direction (default: false).
 * @param {number}  [options.limit]      - Max rows to return.
 * @param {object}  [options.filter]     - { column, value } equality filter.
 * @returns {{ data: Array, loading: boolean, error: object|null }}
 */
export function useRealtimeTable(table, {
  orderBy,
  ascending = false,
  limit,
  filter,
} = {}) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      let query = supabase.from(table).select('*');
      if (filter) query = query.eq(filter.column, filter.value);
      if (orderBy) query = query.order(orderBy, { ascending });
      if (limit) query = query.limit(limit);

      const { data: rows, error: fetchError } = await query;
      if (fetchError) throw fetchError;
      setData(rows ?? []);
      setError(null);
    } catch (err) {
      console.error(`[supabase] Failed to fetch ${table}:`, err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [table, orderBy, ascending, limit, filter]);

  useEffect(() => {
    fetchData();

    // Re-fetch on any INSERT, UPDATE, or DELETE — simpler than manually
    // splicing ordered arrays and guarantees correct sort order is preserved.
    const channel = supabase
      .channel(`realtime:${table}:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => fetchData(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData, table]);

  return { data, loading, error };
}
