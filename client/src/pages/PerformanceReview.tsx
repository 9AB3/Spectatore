import Header from '../components/Header';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
// (milestones card no longer uses a background image)

type ShiftRow = { id: number; date: string; dn: string; totals_json: any };
type Rollup = Record<string, Record<string, Record<string, number>>>;
type CrewMember = { id: number; name: string };

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10);
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function lc(s: string) {
  return (s || '').toLowerCase();
}

// ----- date helpers for calendar -----
function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((v) => parseInt(v, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}
function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatDMY(ymd: string) {
  if (!ymd) return '–';
  const [y, m, d] = ymd.split('-');
  if (!y || !m || !d) return ymd;
  return `${d}/${m}/${y.slice(2)}`;
}

// Allowed metrics per activity (display filter)
const allowedByActivity: Record<string, string[]> = {
  development: [
    'No. of bolts',
    'GS Drillm',
    'Agi Volume',
    'Spray Volume',
    'No of Holes',
    'No of reamers',
    'Dev Drillm',
    'Cut Length',
  ],
  'production drilling': ['Metres drilled', 'Cleanouts drilled', 'Redrills'],
  hauling: ['Total Trucks', 'Total Distance', 'Total Weight', 'Total TKMS'],

  // Loading buckets
  loading: [
    'Primary Dev Buckets',
    'Rehandle Dev Buckets',
    'Primary Stope Buckets',
    'Rehandle Stope Buckets',
  ],

  charging: ['No holes charged', 'Chargem', 'Charge kg', 'Cut Length'],
  hoisting: ['Ore Tonnes', 'Waste Tonnes'],
};

// Aliases to canonical activity keys
const activityAliases: Record<string, string> = {
  dev: 'development',
  development: 'development',
  'face drilling': 'development',
  gs: 'development',
  rehab: 'development',
  production: 'production drilling',
  'production drilling': 'production drilling',
  stope: 'production drilling',
  'service hole': 'production drilling',
  hauling: 'hauling',
  trucking: 'hauling',
  loading: 'loading',
  charging: 'charging',
  hoisting: 'hoisting',
};
function canonAct(name: string) {
  const k = lc(name);
  return activityAliases[k] || k;
}

// Display-name normalization
const keyDisplayMap: Record<string, string> = {
  // Hauling
  trucks: 'Total Trucks',
  'no of trucks': 'Total Trucks',
  distance: 'Total Distance',
  'total km': 'Total Distance',
  weight: 'Total Weight',
  'total weight': 'Total Weight',
  tkms: 'Total TKMS',
  'total tkms': 'Total TKMS',

  // Development
  'gs drillm': 'GS Drillm',
  'no of bolts': 'No. of bolts',
  'no. of bolts': 'No. of bolts',
  'agi volume': 'Agi Volume',
  'spray volume': 'Spray Volume',
  'no of holes': 'No of Holes',
  'no of reamers': 'No of reamers',
  'dev drillm': 'Dev Drillm',
  'cut length': 'Cut Length',

  // Production drilling
  'metres drilled': 'Metres drilled',
  'cleanouts drilled': 'Cleanouts drilled',
  redrills: 'Redrills',

  // Loading buckets
  'primary dev buckets': 'Primary Dev Buckets',
  'rehandle dev buckets': 'Rehandle Dev Buckets',
  'primary stope buckets': 'Primary Stope Buckets',
  'rehandle stope buckets': 'Rehandle Stope Buckets',

  // Charging
  'no holes charged': 'No holes charged',
  chargem: 'Chargem',
  'charge kg': 'Charge kg',

  // Hoisting
  'ore tonnes': 'Ore Tonnes',
  'waste tonnes': 'Waste Tonnes',
};

function displayNameFor(raw: string) {
  return keyDisplayMap[lc(raw)] || raw;
}

function isAllowedMetric(activityCanonical: string, metricDisplayName: string) {
  const list = allowedByActivity[lc(activityCanonical)];
  return !!(list && list.some((m) => lc(m) === lc(metricDisplayName)));
}

// ----- calendar dropdown component -----
type CalendarDropdownProps = {
  label: string;
  value: string; // "YYYY-MM-DD"
  onChange: (v: string) => void;
  datesWithData: Set<string>;
};

function CalendarDropdown({ label, value, onChange, datesWithData }: CalendarDropdownProps) {
  const [open, setOpen] = useState(false);

  const baseDate = value ? parseYmd(value) : new Date();
  const [month, setMonth] = useState(baseDate.getMonth());
  const [year, setYear] = useState(baseDate.getFullYear());

  useEffect(() => {
    if (value) {
      const d = parseYmd(value);
      setMonth(d.getMonth());
      setYear(d.getFullYear());
    }
  }, [value]);

  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const weeks: (Date | null)[][] = [];
  let currentWeek: (Date | null)[] = [];

  for (let i = 0; i < startDay; i++) currentWeek.push(null);

  for (let day = 1; day <= daysInMonth; day++) {
    currentWeek.push(new Date(year, month, day));
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  function handleSelect(d: Date) {
    const ymd = formatYmd(d);
    onChange(ymd);
    setOpen(false);
  }

  function prevMonth() {
    const d = new Date(year, month - 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  function nextMonth() {
    const d = new Date(year, month + 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  const labelText = value || 'Select date';

  return (
    <div className="relative inline-block">
      <div className="block text-xs text-slate-600 mb-1">{label}</div>
      <button
        type="button"
        className="input flex items-center justify-between min-w-[9rem]"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{labelText}</span>
        <span className="ml-2 text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 bg-white border border-slate-300 rounded shadow-lg p-2 w-64">
          <div className="flex items-center justify-between mb-2">
            <button type="button" className="px-2 text-sm text-slate-600" onClick={prevMonth}>
              ‹
            </button>
            <div className="text-sm font-medium">
              {new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(
                new Date(year, month, 1),
              )}
            </div>
            <button type="button" className="px-2 text-sm text-slate-600" onClick={nextMonth}>
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 text-center text-[11px] mb-1 text-slate-500">
            <div>S</div>
            <div>M</div>
            <div>T</div>
            <div>W</div>
            <div>T</div>
            <div>F</div>
            <div>S</div>
          </div>

          <div className="grid grid-cols-7 text-center gap-y-1">
            {weeks.map((week, wi) =>
              week.map((d, di) => {
                if (!d) {
                  return (
                    <div
                      key={`${wi}-${di}`}
                      className="w-8 h-8 inline-flex items-center justify-center"
                    />
                  );
                }
                const ymd = formatYmd(d);
                const isSelected = value === ymd;
                const hasData = datesWithData.has(ymd);

                let base =
                  'w-8 h-8 inline-flex items-center justify-center rounded-full text-xs cursor-pointer';
                let extra = ' text-slate-700 hover:bg-slate-100';

                if (hasData) extra = ' bg-green-200 text-green-900 hover:bg-green-300';
                if (isSelected) extra += ' ring-2 ring-slate-500';

                return (
                  <button
                    key={`${wi}-${di}`}
                    type="button"
                    className={base + extra}
                    onClick={() => handleSelect(d)}
                  >
                    {d.getDate()}
                  </button>
                );
              }),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// helper to fetch crew graph data on-demand
async function fetchCrewGraphData(
  userId: string,
  from: string,
  to: string,
  setRows: (rows: ShiftRow[]) => void,
) {
  if (!userId) {
    setRows([]);
    return;
  }
  try {
    const res = await api(`/api/reports/summary?from=${from}&to=${to}&user_id=${userId}`);
    setRows(res.rows || []);
  } catch (e) {
    console.error('Failed to load crew graph data', e);
    setRows([]);
  }
}

export default function PerformanceReview() {
  const nav = useNavigate();
  // separate date ranges
  const [fromTable, setFromTable] = useState(formatDate(startOfMonth(new Date())));
  const [toTable, setToTable] = useState(formatDate(new Date()));
  const [fromGraph, setFromGraph] = useState(formatDate(startOfMonth(new Date())));
  const [toGraph, setToGraph] = useState(formatDate(new Date()));

  // table data
  const [rowsTable, setRowsTable] = useState<ShiftRow[]>([]);
  const [rollupTable, setRollupTable] = useState<Rollup>({});

  // graph data (current user)
  const [rowsGraph, setRowsGraph] = useState<ShiftRow[]>([]);
  const [rollupGraph, setRollupGraph] = useState<Rollup>({}); // date-range rollup (kept for reference)

  // ✅ options rollup (all time) so graph date range never changes dropdown availability
  const [rollupGraphOptions, setRollupGraphOptions] = useState<Rollup>({});

  // graph data (crew)
  const [rowsGraphCrew, setRowsGraphCrew] = useState<ShiftRow[]>([]);

  // milestones (all-time, hidden fetch)
  const [rowsMilestones, setRowsMilestones] = useState<ShiftRow[]>([]);
  const [rowsMilestonesCrew, setRowsMilestonesCrew] = useState<ShiftRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // ✅ Make graph the default left-most tab
  const [tab, setTab] = useState<'graph' | 'table' | 'milestones'>('graph');

  // global dates-with-any-data (useful for Table calendars)
  const [datesWithData, setDatesWithData] = useState<Set<string>>(() => new Set());

  // crew list + selection + current user name
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [selectedCrewId, setSelectedCrewId] = useState<string>('');
  const [currentUserName, setCurrentUserName] = useState<string>('You');

  // graph-specific state (BLANK until user selects)
  const [graphActivity, setGraphActivity] = useState<string>('');
  const [graphSub, setGraphSub] = useState<string>('');
  const [graphMetric, setGraphMetric] = useState<string>('');

  async function fetchTableData(f: string, t: string) {
    setLoading(true);
    try {
      setError(undefined);
      const res = await api(`/api/reports/summary?from=${f}&to=${t}`);
      setRowsTable(res.rows || []);
      setRollupTable(res.rollup || {});
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function fetchGraphData(f: string, t: string) {
    setLoading(true);
    try {
      setError(undefined);
      const res = await api(`/api/reports/summary?from=${f}&to=${t}`);
      setRowsGraph(res.rows || []);
      setRollupGraph(res.rollup || {});
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  // initial load for table (still load so tab switch is instant)
  useEffect(() => {
    fetchTableData(fromTable, toTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ initial load for graph data (selectors stay blank until user chooses)
  useEffect(() => {
    fetchGraphData(fromGraph, toGraph);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ AUTO graph refresh on date range change (no Apply needed)
  useEffect(() => {
    const t = setTimeout(() => {
      fetchGraphData(fromGraph, toGraph);
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromGraph, toGraph]);

  // ✅ AUTO crew series refresh on crew OR date range change (no Apply needed)
  useEffect(() => {
    if (!selectedCrewId) {
      setRowsGraphCrew([]);
      return;
    }
    const t = setTimeout(() => {
      fetchCrewGraphData(selectedCrewId, fromGraph, toGraph, setRowsGraphCrew);
    }, 200);
    return () => clearTimeout(t);
  }, [selectedCrewId, fromGraph, toGraph]);

  // global dates with any data (TABLE calendars)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api('/api/shifts/dates-with-data');
        const arr = (res?.dates || []) as string[];
        if (!cancelled) setDatesWithData(new Set(arr));
      } catch (e) {
        console.error('Failed to load dates-with-data', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // hidden all-time fetch for milestones (current user)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api(`/api/reports/summary?from=0001-01-01&to=9999-12-31`);
        if (!cancelled) setRowsMilestones(res.rows || []);
      } catch (e) {
        console.error('Failed to load all-time milestones data', e);
        if (!cancelled) setRowsMilestones([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ✅ load options rollup once (all-time) so graph date range doesn't affect dropdown availability
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api(`/api/reports/summary?from=0001-01-01&to=9999-12-31`);
        if (!cancelled) setRollupGraphOptions(res.rollup || {});
      } catch (e) {
        console.error('Failed to load graph options rollup', e);
        if (!cancelled) setRollupGraphOptions({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // hidden all-time fetch for milestones (crew) when selected
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedCrewId) {
        setRowsMilestonesCrew([]);
        return;
      }
      try {
        const res = await api(
          `/api/reports/summary?from=0001-01-01&to=9999-12-31&user_id=${selectedCrewId}`,
        );
        if (!cancelled) setRowsMilestonesCrew(res.rows || []);
      } catch (e) {
        console.error('Failed to load crew all-time milestones data', e);
        if (!cancelled) setRowsMilestonesCrew([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCrewId]);

  // load crew list + current user name
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await getDB();
        const session = await db.get('session', 'auth');
        const uid = session?.user_id || 0;

        if (session?.name || session?.email) {
          setCurrentUserName(session.name || session.email);
        }

        if (!uid) {
          setCrew([]);
          return;
        }

        const res = await api(`/api/connections/accepted?user_id=${uid}`);
        if (cancelled) return;

        const items = res.items || [];
        const list: CrewMember[] = items.map((r: any) => ({
          id: r.other_id,
          name: r.name || r.email || 'Unknown',
        }));

        setCrew(list);
      } catch (e) {
        console.error('Failed to load crew list', e);
        if (!cancelled) setCrew([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------- TABLE: non-zero counts for averages --------------------
  const nonZeroCounts = useMemo(() => {
    const counts: Record<string, Record<string, Record<string, number>>> = {};
    const ALLOWED_HAUL = new Set(['Total Trucks', 'Total Distance', 'Total Weight', 'Total TKMS']);

    for (const r of rowsTable) {
      const t = r.totals_json || {};
      for (const rawAct of Object.keys(t || {})) {
        const canAct = canonAct(rawAct);
        for (const sub of Object.keys(t[rawAct] || {})) {
          for (const rawK of Object.keys(t[rawAct][sub] || {})) {
            if (lc(canAct) === 'hauling') {
              const rk = lc(rawK);
              if (rk === 'trucks' || rk === 'weight' || rk === 'distance') continue;
              if (!ALLOWED_HAUL.has(rawK)) continue;
            }
            const disp = displayNameFor(rawK);
            if (!isAllowedMetric(canAct, disp)) continue;
            const v = Number(t[rawAct][sub][rawK] ?? 0);
            if (v > 0) {
              counts[canAct] ||= {};
              counts[canAct][sub] ||= {};
              counts[canAct][sub][disp] = (counts[canAct][sub][disp] || 0) + 1;
            }
          }
        }
      }
    }
    return counts;
  }, [rowsTable]);

  // filtered rollup for table
  const filteredRollupTable: Rollup = useMemo(() => {
    const out: Rollup = {};
    for (const rawAct of Object.keys(rollupTable || {})) {
      const canAct = canonAct(rawAct);
      if (!allowedByActivity[lc(canAct)]) continue;

      for (const sub of Object.keys(rollupTable[rawAct] || {})) {
        for (const rawK of Object.keys(rollupTable[rawAct][sub] || {})) {
          if (lc(canAct) === 'hauling') {
            const rk = lc(rawK);
            if (rk === 'trucks' || rk === 'weight' || rk === 'distance') continue;
          }
          const disp = displayNameFor(rawK);
          if (!isAllowedMetric(canAct, disp)) continue;
          const v = Number(rollupTable[rawAct][sub][rawK] ?? 0);

          out[canAct] ||= {};
          out[canAct][sub] ||= {};
          out[canAct][sub][disp] = (out[canAct][sub][disp] || 0) + v;
        }
      }
    }
    return out;
  }, [rollupTable]);

  const activityOptionsTable = useMemo(() => Object.keys(filteredRollupTable), [filteredRollupTable]);

  // -------------------- GRAPH: options rollup (INDEPENDENT OF GRAPH DATES) --------------------
  const filteredRollupGraph: Rollup = useMemo(() => {
    const out: Rollup = {};
    for (const rawAct of Object.keys(rollupGraphOptions || {})) {
      const canAct = canonAct(rawAct);
      if (!allowedByActivity[lc(canAct)]) continue;

      for (const sub of Object.keys(rollupGraphOptions[rawAct] || {})) {
        for (const rawK of Object.keys(rollupGraphOptions[rawAct][sub] || {})) {
          if (lc(canAct) === 'hauling') {
            const rk = lc(rawK);
            if (rk === 'trucks' || rk === 'weight' || rk === 'distance') continue;
          }
          const disp = displayNameFor(rawK);
          if (!isAllowedMetric(canAct, disp)) continue;
          const v = Number(rollupGraphOptions[rawAct][sub][rawK] ?? 0);

          out[canAct] ||= {};
          out[canAct][sub] ||= {};
          out[canAct][sub][disp] = (out[canAct][sub][disp] || 0) + v;
        }
      }
    }
    return out;
  }, [rollupGraphOptions]);

  const activityOptionsGraph = useMemo(
    () => Object.keys(filteredRollupGraph),
    [filteredRollupGraph],
  );

  const subsByActivityGraph = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [act, subs] of Object.entries(filteredRollupGraph)) {
      out[act] = Object.keys(subs);
    }
    return out;
  }, [filteredRollupGraph]);

  const metricOptionsGraph = useMemo(() => {
    if (!graphActivity || !graphSub) return [];
    return Object.keys(filteredRollupGraph[graphActivity]?.[graphSub] || {});
  }, [filteredRollupGraph, graphActivity, graphSub]);

  // -------------------- ✅ Your rule: changing Activity blanks everything else --------------------
  function handleGraphActivityChange(newAct: string) {
    setGraphActivity(newAct);

    // blank all dependent dropdowns (forced re-select)
    setGraphSub('');
    setGraphMetric('');

    // blank crew matchup so comparison doesn't stay skewed
    setSelectedCrewId('');
    setRowsGraphCrew([]);
    setRowsMilestonesCrew([]);
  }

  // when Sub-activity changes, blank metric (forced re-select)
  function handleGraphSubChange(newSub: string) {
    setGraphSub(newSub);
    setGraphMetric('');

    // also drop crew matchup (metric meaning changes)
    setSelectedCrewId('');
    setRowsGraphCrew([]);
    setRowsMilestonesCrew([]);
  }

  // when Metric changes, also drop crew matchup (forced to reselect)
  useEffect(() => {
    setSelectedCrewId('');
    setRowsGraphCrew([]);
    setRowsMilestonesCrew([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphMetric]);

  // -------------------- Milestones helpers --------------------
  function getShiftValueForSelection(row: ShiftRow): number {
    if (!graphActivity || !graphSub || !graphMetric) return 0;
    const t = row.totals_json || {};
    let sum = 0;

    for (const rawAct of Object.keys(t || {})) {
      const canAct = canonAct(rawAct);
      if (canAct !== graphActivity) continue;

      for (const sub of Object.keys(t[rawAct] || {})) {
        if (sub !== graphSub) continue;

        for (const rawK of Object.keys(t[rawAct][sub] || {})) {
          if (lc(canAct) === 'hauling') {
            const rk = lc(rawK);
            if (rk === 'trucks' || rk === 'weight' || rk === 'distance') continue;
          }
          const disp = displayNameFor(rawK);
          if (disp !== graphMetric) continue;
          if (!isAllowedMetric(canAct, disp)) continue;

          const v = Number(t[rawAct][sub][rawK] ?? 0);
          if (!v) continue;
          sum += v;
        }
      }
    }

    return sum;
  }

  function buildDailyAcc(rows: ShiftRow[]): Record<string, number> {
    const acc: Record<string, number> = {};
    for (const r of rows) {
      const v = getShiftValueForSelection(r);
      if (!v) continue;
      acc[r.date] = (acc[r.date] || 0) + v;
    }
    return acc;
  }

  function computeMilestonesAllTime(rows: ShiftRow[]) {
    if (!graphActivity || !graphSub || !graphMetric) return null;

    const acc = buildDailyAcc(rows);
    const dates = Object.keys(acc).sort();
    if (!dates.length) return null;

    // Record shift
    let bestDayVal = -Infinity;
    let bestDayDate = dates[0];
    for (const d of dates) {
      const v = acc[d] || 0;
      if (v > bestDayVal) {
        bestDayVal = v;
        bestDayDate = d;
      }
    }
    if (!Number.isFinite(bestDayVal)) bestDayVal = 0;

    // Build continuous calendar series (min->max), fill missing days with 0
    const start = parseYmd(dates[0]);
    const end = parseYmd(dates[dates.length - 1]);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return null;

    const allDays: { date: string; value: number }[] = [];
    {
      const cur = new Date(start);
      while (cur <= end) {
        const ymd = formatYmd(cur);
        allDays.push({ date: ymd, value: acc[ymd] || 0 });
        cur.setDate(cur.getDate() + 1);
      }
    }

    // Record week (best rolling calendar window, up to 7 days)
    const window = Math.min(7, allDays.length);
    let best7Val = -Infinity;
    let best7Start = allDays[0]?.date || '';
    let best7End = allDays[allDays.length - 1]?.date || '';
    let windowSum = 0;

    for (let i = 0; i < allDays.length; i++) {
      windowSum += allDays[i].value;
      if (i >= window) windowSum -= allDays[i - window].value;

      if (i >= window - 1) {
        if (windowSum > best7Val) {
          best7Val = windowSum;
          best7Start = allDays[i - window + 1].date;
          best7End = allDays[i].date;
        }
      }
    }
    if (!Number.isFinite(best7Val)) best7Val = 0;

    // Record month
    const byMonth: Record<string, number> = {};
    for (const pt of allDays) {
      const ym = pt.date.slice(0, 7);
      byMonth[ym] = (byMonth[ym] || 0) + pt.value;
    }
    let bestMonthVal = -Infinity;
    let bestMonthKey = Object.keys(byMonth)[0] || '';
    for (const [ym, v] of Object.entries(byMonth)) {
      if (v > bestMonthVal) {
        bestMonthVal = v;
        bestMonthKey = ym;
      }
    }
    if (!Number.isFinite(bestMonthVal)) bestMonthVal = 0;

    const bestMonthShort = (() => {
      if (!bestMonthKey) return '–';
      const [y, m] = bestMonthKey.split('-');
      return `${m}/${y.slice(2)}`;
    })();

    // DS/NS averages (avg per NON-ZERO shift)
    let dsSum = 0,
      nsSum = 0;
    let dsNonZero = 0,
      nsNonZero = 0;

    for (const r of rows) {
      const dn = String(r.dn || '').toUpperCase();
      const v = getShiftValueForSelection(r);

      if (dn === 'DS') {
        if (v > 0) {
          dsNonZero += 1;
          dsSum += v;
        }
      } else if (dn === 'NS') {
        if (v > 0) {
          nsNonZero += 1;
          nsSum += v;
        }
      }
    }

    const dsAvg = dsNonZero ? dsSum / dsNonZero : NaN;
    const nsAvg = nsNonZero ? nsSum / nsNonZero : NaN;

    let bestShiftLabel = '–';
    if (Number.isFinite(dsAvg) || Number.isFinite(nsAvg)) {
      if (!Number.isFinite(nsAvg)) bestShiftLabel = 'DS';
      else if (!Number.isFinite(dsAvg)) bestShiftLabel = 'NS';
      else if (dsAvg === nsAvg) bestShiftLabel = 'DS = NS';
      else bestShiftLabel = dsAvg > nsAvg ? 'DS' : 'NS';
    }

    return {
      bestDay: { total: bestDayVal, date: bestDayDate },
      best7: { total: best7Val, start: best7Start, end: best7End },
      bestMonth: { total: bestMonthVal, ym: bestMonthKey, label: bestMonthShort },
      shiftCompare: { dsAvg, nsAvg, bestShiftLabel },
    };
  }

  const milestonesAllTime = useMemo(
    () => computeMilestonesAllTime(rowsMilestones),
    [rowsMilestones, graphActivity, graphSub, graphMetric],
  );

  const milestonesAllTimeCrew = useMemo(
    () => (selectedCrewId ? computeMilestonesAllTime(rowsMilestonesCrew) : null),
    [rowsMilestonesCrew, selectedCrewId, graphActivity, graphSub, graphMetric],
  );

  function pctDiff(user: number, crewVal: number) {
    if (!Number.isFinite(user) || !Number.isFinite(crewVal)) return null;
    if (crewVal === 0) {
      if (user === 0) return 0;
      return null;
    }
    return ((user - crewVal) / Math.abs(crewVal)) * 100;
  }

  function PctPill({ value }: { value: number | null }) {
    if (value === null || !Number.isFinite(value)) return <span className="text-slate-400">–</span>;
    const cls = value > 0 ? 'text-emerald-700' : value < 0 ? 'text-red-600' : 'text-slate-600';
    const sign = value > 0 ? '+' : '';
    return <span className={cls}>{`${sign}${value.toFixed(0)}%`}</span>;
  }

  function CompareRowWithPct({
    userNum,
    userText,
    crewNum,
    crewText,
  }: {
    userNum: number;
    userText: string;
    crewNum?: number;
    crewText?: string;
  }) {
    const showCrew = !!selectedCrewId;
    const p = showCrew && typeof crewNum === 'number' ? pctDiff(userNum, crewNum) : null;

    const rowCls = 'grid items-center gap-2 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem]';

    return (
      <div className={rowCls}>
        <div className="text-left font-semibold truncate">{userText}</div>
        <div className="text-right truncate">{showCrew ? crewText || '–' : ''}</div>
        <div className="text-right tabular-nums">{showCrew ? <PctPill value={p} /> : ''}</div>
      </div>
    );
  }

  function fmtAvg(v: number) {
    return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '–';
  }

  // ✅ dates-with-data for the CURRENT selection (graph calendars should be green only for selected metric)
  const datesWithDataForSelection = useMemo(() => {
    const s = new Set<string>();
    if (!graphActivity || !graphSub || !graphMetric) return s;
    for (const r of rowsMilestones) {
      const v = getShiftValueForSelection(r);
      if (v > 0) s.add(r.date);
    }
    return s;
  }, [rowsMilestones, graphActivity, graphSub, graphMetric]);

  // helper to build daily + cumulative series for a given set of rows (graph range)
  const computeSeries = (rows: ShiftRow[]) => {
    if (!graphActivity || !graphSub || !graphMetric) return [];
    const acc: Record<string, number> = {};

    for (const r of rows) {
      const date = r.date;
      if (date < fromGraph || date > toGraph) continue;

      const t = r.totals_json || {};
      for (const rawAct of Object.keys(t || {})) {
        const canAct = canonAct(rawAct);
        if (canAct !== graphActivity) continue;

        for (const sub of Object.keys(t[rawAct] || {})) {
          if (sub !== graphSub) continue;

          for (const rawK of Object.keys(t[rawAct][sub] || {})) {
            if (lc(canAct) === 'hauling') {
              const rk = lc(rawK);
              if (rk === 'trucks' || rk === 'weight' || rk === 'distance') continue;
            }
            const disp = displayNameFor(rawK);
            if (disp !== graphMetric) continue;
            if (!isAllowedMetric(canAct, disp)) continue;

            const v = Number(t[rawAct][sub][rawK] ?? 0);
            if (!v) continue;
            acc[date] = (acc[date] || 0) + v;
          }
        }
      }
    }

    // build continuous date range so zero days still appear
    const start = new Date(fromGraph);
    const end = new Date(toGraph);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

    const series: { date: string; value: number; cumulative: number }[] = [];
    let current = new Date(start);
    let cum = 0;

    while (current <= end) {
      const ymd = formatYmd(current);
      const value = acc[ymd] || 0;
      cum += value;
      series.push({ date: ymd, value, cumulative: cum });
      current.setDate(current.getDate() + 1);
    }

    return series;
  };

  const seriesCurrent = useMemo(
    () => computeSeries(rowsGraph),
    [rowsGraph, graphActivity, graphSub, graphMetric, fromGraph, toGraph],
  );

  const seriesCrew = useMemo(
    () => (selectedCrewId ? computeSeries(rowsGraphCrew) : []),
    [rowsGraphCrew, selectedCrewId, graphActivity, graphSub, graphMetric, fromGraph, toGraph],
  );

  const dailyMax = useMemo(() => {
    let m = 0;
    for (const pt of seriesCurrent) if (pt.value > m) m = pt.value;
    for (const pt of seriesCrew) if (pt.value > m) m = pt.value;
    return m;
  }, [seriesCurrent, seriesCrew]);

  const cumMax = useMemo(() => {
    let m = 0;
    for (const pt of seriesCurrent) if (pt.cumulative > m) m = pt.cumulative;
    for (const pt of seriesCrew) if (pt.cumulative > m) m = pt.cumulative;
    return m;
  }, [seriesCurrent, seriesCrew]);

  // chart geometry
  const chartPaddingLeft = 48;
  const chartPaddingRight = 48;
  const chartPaddingTop = 16;
  const chartPaddingBottom = 56; // room for x-axis title
  const innerHeight = 180;
  const svgHeight = chartPaddingTop + innerHeight + chartPaddingBottom;
  const barWidth = 24;
  const gap = 16;
  const minWidth = 320;
  const svgWidth =
    seriesCurrent.length > 0
      ? Math.max(
          chartPaddingLeft + chartPaddingRight + seriesCurrent.length * (barWidth + gap) - gap,
          minWidth,
        )
      : minWidth;

  function yDaily(v: number) {
    const max = dailyMax || 1;
    const b = chartPaddingTop + innerHeight;
    return b - (v / max) * innerHeight;
  }

  function yCum(v: number) {
    const max = cumMax || 1;
    const b = chartPaddingTop + innerHeight;
    return b - (v / max) * innerHeight;
  }

  function buildCumPath(series: { date: string; value: number; cumulative: number }[]) {
    if (!series.length) return '';
    const parts: string[] = [];
    series.forEach((pt, i) => {
      const xCenter = chartPaddingLeft + i * (barWidth + gap) + barWidth / 2;
      const y = yCum(pt.cumulative);
      parts.push(`${i === 0 ? 'M' : 'L'} ${xCenter} ${y}`);
    });
    return parts.join(' ');
  }

  const cumPathCurrent = buildCumPath(seriesCurrent);
  const cumPathCrew = buildCumPath(seriesCrew);

  // -------- graph hover tooltip --------
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const [hoverTip, setHoverTip] = useState<
    | null
    | {
        x: number;
        y: number;
        title: string;
        valueLabel: string;
      }
  >(null);

  function fmtDdMmm(ymd: string) {
    try {
      const d = parseYmd(ymd);
      const dd = String(d.getDate()).padStart(2, '0');
      const mmm = d.toLocaleString(undefined, { month: 'short' });
      return `${dd}/${mmm}`;
    } catch {
      return ymd;
    }
  }

  function showTip(e: ReactMouseEvent, title: string, valueLabel: string) {
    const r = chartWrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setHoverTip({ x: e.clientX - r.left, y: e.clientY - r.top, title, valueLabel });
  }

  const crewMatch = crew.find((c) => c.id === Number(selectedCrewId || 0));
  const crewName = crewMatch?.name || '';

  // ✅ don’t show milestones/graph until the user has fully selected the chain
  const selectionReady = !!graphActivity && !!graphSub && !!graphMetric;

  return (
    <div>
      <Header />
      <div className="p-4 max-w-5xl mx-auto">
        <div className="card space-y-4">
          <h2 className="text-xl font-semibold">Performance Review</h2>

          {error && <div className="text-sm text-red-600">{error}</div>}
          {loading && <div className="text-sm text-slate-600">Loading…</div>}

          <div className="flex gap-2 border-b border-slate-200">
            <button
              onClick={() => setTab('graph')}
              className={`px-3 py-2 text-sm ${
                tab === 'graph' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Graph data view
            </button>
            <button
              onClick={() => setTab('milestones')}
              className={`px-3 py-2 text-sm ${
                tab === 'milestones' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Milestones
            </button>
            <button
              onClick={() => setTab('table')}
              className={`px-3 py-2 text-sm ${
                tab === 'table' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Tabulated data view
            </button>
          </div>

          {tab === 'milestones' && (
            <div className="space-y-4">
              {!selectionReady ? (
                <div className="text-sm text-slate-600">
                  Select an <b>Activity</b>, <b>Sub-activity</b>, and <b>Metric</b> to view milestones.
                </div>
              ) : !milestonesAllTime ? (
                <div className="text-sm text-slate-600">No milestone data found for this selection.</div>
              ) : (
                <div className="card p-4">
                  <div className="text-sm font-semibold mb-3">All-time milestones (You)</div>

                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-slate-600">
                          <th className="py-2 pr-4">Milestone</th>
                          <th className="py-2 pr-4">Achieved</th>
                          <th className="py-2 pr-4 text-right">Value</th>
                        </tr>
                      </thead>
                      <tbody className="align-top">
                        <tr className="border-t border-slate-200">
                          <td className="py-2 pr-4 font-medium">Record shift</td>
                          <td className="py-2 pr-4">{formatDMY(milestonesAllTime.bestDay.date)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">
                            {Number(milestonesAllTime.bestDay.total || 0).toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })}
                          </td>
                        </tr>
                        <tr className="border-t border-slate-200">
                          <td className="py-2 pr-4 font-medium">Record week</td>
                          <td className="py-2 pr-4">
                            {formatDMY(milestonesAllTime.best7.start)} – {formatDMY(milestonesAllTime.best7.end)}
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums">
                            {Number(milestonesAllTime.best7.total || 0).toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })}
                          </td>
                        </tr>
                        <tr className="border-t border-slate-200">
                          <td className="py-2 pr-4 font-medium">Record month</td>
                          <td className="py-2 pr-4">{milestonesAllTime.bestMonth.label || '–'}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">
                            {Number(milestonesAllTime.bestMonth.total || 0).toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'graph' && (
            <div className="space-y-4">
              {/* 1) Selectors */}
              <div className="flex flex-wrap gap-2 items-end">
                <div>
                  <div className="text-xs text-slate-600 mb-1">Activity</div>
                  <select
                    className="input text-sm"
                    value={graphActivity}
                    onChange={(e) => handleGraphActivityChange(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {activityOptionsGraph.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="text-xs text-slate-600 mb-1">Sub-activity</div>
                  <select
                    className="input text-sm"
                    value={graphSub}
                    disabled={!graphActivity}
                    onChange={(e) => handleGraphSubChange(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {(graphActivity ? subsByActivityGraph[graphActivity] || [] : []).map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="text-xs text-slate-600 mb-1">Metric</div>
                  <select
                    className="input text-sm"
                    value={graphMetric}
                    disabled={!graphActivity || !graphSub}
                    onChange={(e) => setGraphMetric(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {metricOptionsGraph.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="text-xs text-slate-600 mb-1">Crew Match-Up</div>
                  <select
                    className="input text-sm"
                    value={selectedCrewId}
                    disabled={!selectionReady}
                    onChange={(e) => setSelectedCrewId(e.target.value)}
                  >
                    <option value="">None</option>
                    {crew.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 2) Milestones */}
              {selectionReady && milestonesAllTime && (
                <div className="border rounded p-3">
                  <div className="font-semibold mb-2">Milestones</div>

                  {selectedCrewId && (
                    <div className="grid items-center gap-2 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem] text-[11px] text-slate-500 mb-2">
                      <div className="truncate">{currentUserName}</div>
                      <div className="text-right truncate">{crewName || 'Crew'}</div>
                      <div className="text-right">Δ</div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-2 text-sm">
                    {/* Record Shift */}
                    <div className="bg-white border rounded p-2">
                      <div className="text-xs text-slate-600">Record Shift</div>
                      <CompareRowWithPct
                        userNum={milestonesAllTime.bestDay.total}
                        userText={`${milestonesAllTime.bestDay.total.toLocaleString()}`}
                        crewNum={milestonesAllTimeCrew?.bestDay.total}
                        crewText={
                          milestonesAllTimeCrew
                            ? `${milestonesAllTimeCrew.bestDay.total.toLocaleString()}`
                            : undefined
                        }
                      />
                      {/* date below number (like other milestones) */}
                      <div className="grid items-center gap-2 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem] mt-1">
                        <div className="text-xs text-slate-600">
                          {formatDMY(milestonesAllTime.bestDay.date)}
                        </div>
                        <div className="text-xs text-slate-600 text-right">
                          {milestonesAllTimeCrew ? formatDMY(milestonesAllTimeCrew.bestDay.date) : ''}
                        </div>
                        <div />
                      </div>
                    </div>

                    {/* Record Week */}
                    <div className="bg-white border rounded p-2">
                      <div className="text-xs text-slate-600">Record Week</div>
                      <CompareRowWithPct
                        userNum={milestonesAllTime.best7.total}
                        userText={`${milestonesAllTime.best7.total.toLocaleString()}`}
                        crewNum={milestonesAllTimeCrew?.best7.total}
                        crewText={
                          milestonesAllTimeCrew
                            ? `${milestonesAllTimeCrew.best7.total.toLocaleString()}`
                            : undefined
                        }
                      />
                      <div className="grid items-center gap-2 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem] mt-1">
                        <div className="text-xs text-slate-600">
                          {milestonesAllTime.best7.start && milestonesAllTime.best7.end
                            ? `${formatDMY(milestonesAllTime.best7.start)} → ${formatDMY(
                                milestonesAllTime.best7.end,
                              )}`
                            : '–'}
                        </div>
                        <div className="text-xs text-slate-600 text-right">
                          {milestonesAllTimeCrew &&
                          milestonesAllTimeCrew.best7.start &&
                          milestonesAllTimeCrew.best7.end
                            ? `${formatDMY(milestonesAllTimeCrew.best7.start)} → ${formatDMY(
                                milestonesAllTimeCrew.best7.end,
                              )}`
                            : selectedCrewId
                              ? '–'
                              : ''}
                        </div>
                        <div />
                      </div>
                    </div>

                    {/* Record Month */}
                    <div className="bg-white border rounded p-2">
                      <div className="text-xs text-slate-600">Record Month</div>
                      <CompareRowWithPct
                        userNum={milestonesAllTime.bestMonth.total}
                        userText={`${milestonesAllTime.bestMonth.total.toLocaleString()}`}
                        crewNum={milestonesAllTimeCrew?.bestMonth.total}
                        crewText={
                          milestonesAllTimeCrew
                            ? `${milestonesAllTimeCrew.bestMonth.total.toLocaleString()}`
                            : undefined
                        }
                      />
                      <div className="grid items-center gap-2 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem] mt-1">
                        <div className="text-xs text-slate-600">
                          {milestonesAllTime.bestMonth.label || '–'}
                        </div>
                        <div className="text-xs text-slate-600 text-right">
                          {milestonesAllTimeCrew ? milestonesAllTimeCrew.bestMonth.label || '–' : ''}
                        </div>
                        <div />
                      </div>
                    </div>

                    {/* Most Productive Shift (RESTORED DS/NS AVG) */}
                    <div className="bg-white border rounded p-2">
                      <div className="flex items-baseline justify-between">
                        <div className="text-xs text-slate-600">Most Productive Shift</div>
                        <div className="text-xs text-slate-500">
                          Winner:{' '}
                          <span className="font-semibold text-slate-700">
                            {milestonesAllTime.shiftCompare.bestShiftLabel}
                          </span>
                          {selectedCrewId && milestonesAllTimeCrew ? (
                            <>
                              {' '}
                              | Crew:{' '}
                              <span className="font-semibold text-slate-700">
                                {milestonesAllTimeCrew.shiftCompare.bestShiftLabel}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-1 space-y-1">
                        <CompareRowWithPct
                          userNum={milestonesAllTime.shiftCompare.dsAvg}
                          userText={`DS avg: ${fmtAvg(milestonesAllTime.shiftCompare.dsAvg)}`}
                          crewNum={milestonesAllTimeCrew?.shiftCompare.dsAvg}
                          crewText={
                            milestonesAllTimeCrew
                              ? `DS avg: ${fmtAvg(milestonesAllTimeCrew.shiftCompare.dsAvg)}`
                              : undefined
                          }
                        />
                        <CompareRowWithPct
                          userNum={milestonesAllTime.shiftCompare.nsAvg}
                          userText={`NS avg: ${fmtAvg(milestonesAllTime.shiftCompare.nsAvg)}`}
                          crewNum={milestonesAllTimeCrew?.shiftCompare.nsAvg}
                          crewText={
                            milestonesAllTimeCrew
                              ? `NS avg: ${fmtAvg(milestonesAllTimeCrew.shiftCompare.nsAvg)}`
                              : undefined
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 3) Graph date range (green depends on selected metric; does NOT affect dropdown availability) */}
              <div className="flex flex-wrap gap-2 items-end">
                <CalendarDropdown
                  label="From"
                  value={fromGraph}
                  onChange={setFromGraph}
                  datesWithData={selectionReady ? datesWithDataForSelection : new Set()}
                />
                <CalendarDropdown
                  label="To"
                  value={toGraph}
                  onChange={setToGraph}
                  datesWithData={selectionReady ? datesWithDataForSelection : new Set()}
                />
              </div>

              {/* 4) Legend */}
              {selectionReady && (
                <div className="flex flex-wrap gap-4 text-xs text-slate-600 mb-2">
                  <div>
                    <span className="inline-block w-3 h-3 rounded bg-slate-600 mr-1" />
                    Daily ({currentUserName})
                  </div>
                  {selectedCrewId && (
                    <div>
                      <span className="inline-block w-3 h-3 rounded bg-orange-500 mr-1" />
                      Daily ({crewName})
                    </div>
                  )}
                  <div>
                    <span className="inline-block w-3 h-0.5 bg-emerald-700 mr-1" />
                    Cumulative ({currentUserName})
                  </div>
                  {selectedCrewId && (
                    <div>
                      <span className="inline-block w-3 h-0.5 bg-orange-500 mr-1" />
                      Cumulative ({crewName})
                    </div>
                  )}
                </div>
              )}

              {/* 5) Graph */}
              {!selectionReady ? (
                <div className="text-sm text-slate-500">
                  Select Activity → Sub-activity → Metric to generate the graph.
                </div>
              ) : seriesCurrent.length === 0 && seriesCrew.length === 0 ? (
                <div className="text-sm text-slate-500">No data for this selection</div>
              ) : (
                <div ref={chartWrapRef} className="border rounded p-3 overflow-x-auto relative">
                  {/* tooltip */}
                  {hoverTip && (
                    <div
                      className="absolute z-10 pointer-events-none bg-white border border-slate-300 rounded shadow px-2 py-1 text-xs"
                      style={{ left: Math.min(hoverTip.x + 10, svgWidth - 120), top: Math.max(hoverTip.y - 40, 0) }}
                    >
                      <div className="font-semibold">{hoverTip.title}</div>
                      <div>{hoverTip.valueLabel}</div>
                    </div>
                  )}

                  <svg
                    width={svgWidth}
                    height={svgHeight}
                    className="block"
                    onMouseLeave={() => setHoverTip(null)}
                  >
                    {/* axes */}
                    <line
                      x1={chartPaddingLeft - 6}
                      y1={chartPaddingTop}
                      x2={chartPaddingLeft - 6}
                      y2={chartPaddingTop + innerHeight}
                      stroke="#94a3b8"
                      strokeWidth={1}
                    />
                    <line
                      x1={svgWidth - chartPaddingRight + 6}
                      y1={chartPaddingTop}
                      x2={svgWidth - chartPaddingRight + 6}
                      y2={chartPaddingTop + innerHeight}
                      stroke="#94a3b8"
                      strokeWidth={1}
                    />

                    {/* y-axis titles (rotated, bold) */}
                    <text
                      x={16}
                      y={chartPaddingTop + innerHeight / 2}
                      fontSize={11}
                      fontWeight={700}
                      fill="#475569"
                      textAnchor="middle"
                      transform={`rotate(-90 16 ${chartPaddingTop + innerHeight / 2})`}
                    >
                      Daily total
                    </text>
                    <text
                      x={svgWidth - 16}
                      y={chartPaddingTop + innerHeight / 2}
                      fontSize={11}
                      fontWeight={700}
                      fill="#475569"
                      textAnchor="middle"
                      transform={`rotate(90 ${svgWidth - 16} ${chartPaddingTop + innerHeight / 2})`}
                    >
                      Cumulative
                    </text>

                    {/* left ticks (daily) */}
                    {Array.from({ length: 4 }).map((_, i) => {
                      const frac = i / 3;
                      const v = dailyMax * frac;
                      const y = chartPaddingTop + innerHeight - frac * innerHeight;
                      return (
                        <g key={`lt-${i}`}>
                          <line
                            x1={chartPaddingLeft - 8}
                            y1={y}
                            x2={chartPaddingLeft - 6}
                            y2={y}
                            stroke="#94a3b8"
                            strokeWidth={1}
                          />
                          <text
                            x={chartPaddingLeft - 12}
                            y={y + 3}
                            fontSize={9}
                            fill="#64748b"
                            textAnchor="end"
                          >
                            {Math.round(v).toLocaleString()}
                          </text>
                        </g>
                      );
                    })}

                    {/* right ticks (cumulative) */}
                    {Array.from({ length: 4 }).map((_, i) => {
                      const frac = i / 3;
                      const v = cumMax * frac;
                      const y = chartPaddingTop + innerHeight - frac * innerHeight;
                      return (
                        <g key={`rt-${i}`}>
                          <line
                            x1={svgWidth - chartPaddingRight + 6}
                            y1={y}
                            x2={svgWidth - chartPaddingRight + 8}
                            y2={y}
                            stroke="#94a3b8"
                            strokeWidth={1}
                          />
                          <text
                            x={svgWidth - chartPaddingRight + 12}
                            y={y + 3}
                            fontSize={9}
                            fill="#64748b"
                            textAnchor="start"
                          >
                            {Math.round(v).toLocaleString()}
                          </text>
                        </g>
                      );
                    })}

                    {/* bars for daily totals: you + comparison */}
                    {seriesCurrent.map((pt, i) => {
                      const xCenter = chartPaddingLeft + i * (barWidth + gap) + barWidth / 2;

                      const userVal = pt.value;
                      const crewVal = seriesCrew[i]?.value ?? 0;

                      const baseY = chartPaddingTop + innerHeight;
                      const singleWidth = barWidth / 2 - 1;

                      // Your bar (left)
                      const xUser = xCenter - singleWidth - 1;
                      const yUser = yDaily(userVal);
                      const hUser = Math.max(baseY - yUser, 0);

                      // Crew bar (right)
                      const xCrew = xCenter + 1;
                      const yCrew = yDaily(crewVal);
                      const hCrew = Math.max(baseY - yCrew, 0);

                      return (
                        <g key={`bar-${pt.date}`}>
                          <rect
                            x={xUser}
                            y={yUser}
                            width={singleWidth}
                            height={hUser}
                            fill="#64748b"
                            onMouseMove={(e) =>
                              showTip(e, fmtDdMmm(pt.date), `Daily (You): ${userVal.toLocaleString()}`)
                            }
                            onMouseLeave={() => setHoverTip(null)}
                          />
                          {selectedCrewId && (
                            <rect
                              x={xCrew}
                              y={yCrew}
                              width={singleWidth}
                              height={hCrew}
                              fill="#f59e0b"
                              onMouseMove={(e) =>
                                showTip(
                                  e,
                                  fmtDdMmm(pt.date),
                                  `Daily (${crewName || 'Crew'}): ${crewVal.toLocaleString()}`,
                                )
                              }
                              onMouseLeave={() => setHoverTip(null)}
                            />
                          )}
                        </g>
                      );
                    })}

                    {/* cumulative line (you) */}
                    {cumPathCurrent && (
                      <path d={cumPathCurrent} fill="none" stroke="#0f766e" strokeWidth={2} />
                    )}

                    {/* cumulative line (crew) */}
                    {selectedCrewId && cumPathCrew && (
                      <path
                        d={cumPathCrew}
                        fill="none"
                        stroke="#f97316"
                        strokeWidth={2}
                        strokeDasharray="4 3"
                      />
                    )}

                    {/* points on cumulative lines */}
                    {seriesCurrent.map((pt, i) => {
                      const xCenter = chartPaddingLeft + i * (barWidth + gap) + barWidth / 2;
                      const y = yCum(pt.cumulative);
                      return (
                        <circle
                          key={`dot-me-${pt.date}`}
                          cx={xCenter}
                          cy={y}
                          r={3}
                          fill="#0f766e"
                          onMouseMove={(e) =>
                            showTip(e, fmtDdMmm(pt.date), `Cumulative (You): ${pt.cumulative.toLocaleString()}`)
                          }
                          onMouseLeave={() => setHoverTip(null)}
                        />
                      );
                    })}
                    {selectedCrewId &&
                      seriesCrew.map((pt, i) => {
                        const xCenter = chartPaddingLeft + i * (barWidth + gap) + barWidth / 2;
                        const y = yCum(pt.cumulative);
                        return (
                          <circle
                            key={`dot-crew-${pt.date}`}
                            cx={xCenter}
                            cy={y}
                            r={2}
                            fill="#f97316"
                            onMouseMove={(e) =>
                              showTip(
                                e,
                                fmtDdMmm(pt.date),
                                `Cumulative (${crewName || 'Crew'}): ${pt.cumulative.toLocaleString()}`,
                              )
                            }
                            onMouseLeave={() => setHoverTip(null)}
                          />
                        );
                      })}

                    {/* x-axis labels */}
                    {seriesCurrent.map((pt, i) => {
                      const xCenter = chartPaddingLeft + i * (barWidth + gap) + barWidth / 2;
                      return (
                        <text
                          key={`lbl-${pt.date}`}
                          x={xCenter}
                          y={chartPaddingTop + innerHeight + 14}
                          fontSize={9}
                          fill="#64748b"
                          textAnchor="middle"
                        >
                          {fmtDdMmm(pt.date)}
                        </text>
                      );
                    })}

                    {/* x-axis title */}
                    <text
                      x={svgWidth / 2}
                      y={svgHeight - 6}
                      fontSize={11}
                      fontWeight={700}
                      fill="#475569"
                      textAnchor="middle"
                    >
                      Date
                    </text>
                  </svg>
                </div>
              )}
            </div>
          )}

          {tab === 'table' && (
            <div className="space-y-4">
              {/* date selection for TABLE */}
              <div className="flex flex-wrap gap-2 items-end">
                <CalendarDropdown
                  label="From"
                  value={fromTable}
                  onChange={setFromTable}
                  datesWithData={datesWithData}
                />
                <CalendarDropdown
                  label="To"
                  value={toTable}
                  onChange={setToTable}
                  datesWithData={datesWithData}
                />
                <button
                  className="btn"
                  onClick={() => fetchTableData(fromTable, toTable)}
                  disabled={loading}
                >
                  Apply
                </button>
              </div>

              {activityOptionsTable.length === 0 ? (
                <div className="text-sm text-slate-500">No data</div>
              ) : (
                Object.entries(filteredRollupTable).map(([act, subs]) => {
                  return (
                    <div key={act}>
                      <div className="font-bold mb-1">{act}</div>
                      {Object.entries(subs).map(([sub, sums]) => (
                        <div key={sub} className="ml-3">
                          <div className="font-medium">{sub}</div>
                          <table className="w-full text-sm mt-2 table-fixed">
                            <thead>
                              <tr className="text-left text-slate-600">
                                <th className="py-1 pr-4 w-1/4">Metric</th>
                                <th className="py-1 pr-4 w-1/4 text-right">Sum</th>
                                <th className="py-1 pr-4 w-1/4 text-right">Shift Avg</th>
                                <th className="py-1 pr-4 w-1/4 text-right">Non-zero shifts</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(sums).map(([dispKey, sum]) => {
                                const denom =
                                  (nonZeroCounts[act] &&
                                    nonZeroCounts[act][sub] &&
                                    nonZeroCounts[act][sub][dispKey]) ||
                                  0;
                                const avg = denom ? (Number(sum) || 0) / denom : NaN;
                                return (
                                  <tr key={dispKey}>
                                    <td className="py-1 pr-4 w-1/4 text-slate-700">{dispKey}</td>
                                    <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                      {Number(sum).toLocaleString()}
                                    </td>
                                    <td className="py-1 pr-4 w-1/4 text-right">
                                      {Number.isFinite(avg)
                                        ? avg.toLocaleString(undefined, { maximumFractionDigits: 2 })
                                        : '–'}
                                    </td>
                                    <td className="py-1 pr-4 w-1/4 text-right">{denom}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}

            </div>
          )}
        </div>

        {/* Back button sits below the main card so it shows for both tabs */}
        <div className="mt-4">
          <button className="btn w-full" onClick={() => nav('/Main')}>
            BACK
          </button>
        </div>
      </div>
    </div>
  );
}
