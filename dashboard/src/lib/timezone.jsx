// ─── Timezone context ─────────────────────────────────────────────────────────
// Single source of truth for the user's selected timezone.
// Persists to localStorage. All components read from useTimezone().
// formatTs(isoString) returns a consistently formatted local timestamp.

import { createContext, useContext, useState, useCallback } from 'react';

const STORAGE_KEY = 'swarmtrade_timezone';
const DEFAULT_TZ  = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Build a curated list of timezone options grouped by region
export const TIMEZONE_GROUPS = [
  {
    label: 'Australia & Pacific',
    zones: [
      { value: 'Australia/Perth',    label: 'Perth (AWST)         UTC+8'  },
      { value: 'Australia/Adelaide', label: 'Adelaide (ACST)      UTC+9:30' },
      { value: 'Australia/Sydney',   label: 'Sydney / Melbourne   UTC+10/11' },
      { value: 'Australia/Brisbane', label: 'Brisbane (AEST)      UTC+10' },
      { value: 'Pacific/Auckland',   label: 'Auckland (NZST)      UTC+12/13' },
    ],
  },
  {
    label: 'Asia',
    zones: [
      { value: 'Asia/Singapore',  label: 'Singapore (SGT)   UTC+8'  },
      { value: 'Asia/Tokyo',      label: 'Tokyo (JST)       UTC+9'  },
      { value: 'Asia/Shanghai',   label: 'Shanghai (CST)    UTC+8'  },
      { value: 'Asia/Dubai',      label: 'Dubai (GST)       UTC+4'  },
      { value: 'Asia/Kolkata',    label: 'Mumbai (IST)      UTC+5:30' },
    ],
  },
  {
    label: 'Europe',
    zones: [
      { value: 'Europe/London',   label: 'London (GMT/BST)  UTC+0/1' },
      { value: 'Europe/Paris',    label: 'Paris (CET/CEST)  UTC+1/2' },
      { value: 'Europe/Berlin',   label: 'Berlin (CET/CEST) UTC+1/2' },
      { value: 'Europe/Moscow',   label: 'Moscow (MSK)      UTC+3'  },
    ],
  },
  {
    label: 'Americas',
    zones: [
      { value: 'America/New_York',    label: 'New York (EST/EDT)   UTC-5/4' },
      { value: 'America/Chicago',     label: 'Chicago (CST/CDT)    UTC-6/5' },
      { value: 'America/Denver',      label: 'Denver (MST/MDT)     UTC-7/6' },
      { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT) UTC-8/7' },
      { value: 'America/Sao_Paulo',   label: 'São Paulo (BRT)      UTC-3'  },
    ],
  },
  {
    label: 'Universal',
    zones: [
      { value: 'UTC', label: 'UTC  UTC+0' },
    ],
  },
];

// Flatten for lookups
export const ALL_ZONES = TIMEZONE_GROUPS.flatMap(g => g.zones);

function loadSaved() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && ALL_ZONES.find(z => z.value === saved)) return saved;
  } catch {}
  return DEFAULT_TZ;
}

const TimezoneContext = createContext(null);

export function TimezoneProvider({ children }) {
  const [timezone, setTimezoneState] = useState(loadSaved);

  const setTimezone = useCallback((tz) => {
    setTimezoneState(tz);
    try { localStorage.setItem(STORAGE_KEY, tz); } catch {}
  }, []);

  // Format an ISO timestamp string into the user's local time
  const formatTs = useCallback((isoString, opts = {}) => {
    if (!isoString) return '—';
    const { dateStyle = 'short', timeStyle = 'short' } = opts;
    return new Date(isoString).toLocaleString('en-AU', {
      timeZone: timezone,
      dateStyle,
      timeStyle,
    });
  }, [timezone]);

  // Short timezone label for display (e.g. "AWST", "EST")
  const tzLabel = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    timeZoneName: 'short',
  }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? timezone;

  return (
    <TimezoneContext.Provider value={{ timezone, setTimezone, formatTs, tzLabel }}>
      {children}
    </TimezoneContext.Provider>
  );
}

export function useTimezone() {
  const ctx = useContext(TimezoneContext);
  if (!ctx) throw new Error('useTimezone must be used inside <TimezoneProvider>');
  return ctx;
}
