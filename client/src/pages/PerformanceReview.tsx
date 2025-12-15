import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';

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

// ----- milestone date formatting helpers -----
function fmtDdMmYy(ymd: string) {
  if (!ymd) return '–';
  const d = parseYmd(ymd);
  if (isNaN(d.getTime())) return '–';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
function fmtMonthMmYy(ym: string) {
  // ym = "YYYY-MM"
  if (!ym || ym.length < 7) return '–';
  const [y, m] = ym.split('-').map((x) => parseInt(x, 10));
  if (!y || !m) return '–';
  const mm = String(m).padStart(2, '0');
  const yy = String(y).slice(-2);
  return `${mm}/${yy}`;
}
function pctDiff(userVal: number, crewVal: number) {
  // % difference vs crew (crew baseline)
  if (!Number.isFinite(userVal) || !Number.isFinite(crewVal)) return null;
  if (crewVal === 0) return null;
  return ((userVal - crewVal) / crewVal) * 100;
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
  const [rollupGraph, setRollupGraph] = useState<Rollup>({});

  // graph data (crew)
  const [rowsGraphCrew, setRowsGraphCrew] = useState<ShiftRow[]>([]);

  // milestones (all-time, hidden fetch)
  const [rowsMilestones, setRowsMilestones] = useState<ShiftRow[]>([]);
  const [rowsMilestonesCrew, setRowsMilestonesCrew] = useState<ShiftRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tab, setTab] = useState<'table' | 'graph'>('table');
  const [datesWithData, setDatesWithData] = useState<Set<string>>(() => new Set());

  // crew list + selection + current user name
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [selectedCrewId, setSelectedCrewId] = useState<string>('');
  const [currentUserName, setCurrentUserName] = useState<string>('You');

  // graph-specific state
  const [graphActivity, setGraphActivity] = useState<string | undefined>();
  const [graphSub, setGraphSub] = useState<string | undefined>();
  const [graphMetric, setGraphMetric] = useState<string | undefined>();

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

      // also refresh crew series for the same range if a crew member is already selected
      if (selectedCrewId) {
        await fetchCrewGraphData(selectedCrewId, f, t, setRowsGraphCrew);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  // initial load for table
  useEffect(() => {
    fetchTableData(fromTable, toTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // dates with data (used for both calendars)
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

  // hidden all-time fetch for milestones (you)
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

  // hidden all-time fetch for milestones (crew, only when selected)
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

  // non-zero counts for table averages
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

  // filtered rollup for graph (current user) – just for activity/sub/metric options
  const filteredRollupGraph: Rollup = useMemo(() => {
    const out: Rollup = {};
    for (const rawAct of Object.keys(rollupGraph || {})) {
      const canAct = canonAct(rawAct);
      if (!allowedByActivity[lc(canAct)]) continue;

      for (const sub of Object.keys(rollupGraph[rawAct] || {})) {
        for (const rawK of Object.keys(rollupGraph[rawAct][sub] || {})) {
          if (lc(canAct) === 'hauling') {
            const rk = lc(rawK);
            if (rk === 'trucks' || rk === 'weight' || rk === 'distance') continue;
          }
          const disp = displayNameFor(rawK);
          if (!isAllowedMetric(canAct, disp)) continue;
          const v = Number(rollupGraph[rawAct][sub][rawK] ?? 0);

          out[canAct] ||= {};
          out[canAct][sub] ||= {};
          out[canAct][sub][disp] = (out[canAct][sub][disp] || 0) + v;
        }
      }
    }
    return out;
  }, [rollupGraph]);

  const activityOptionsGraph = useMemo(() => Object.keys(filteredRollupGraph), [filteredRollupGraph]);

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

  // keep graph activity/sub/metric in sync with data
  useEffect(() => {
    if (!activityOptionsGraph.length) {
      setGraphActivity(undefined);
      setGraphSub(undefined);
      setGraphMetric(undefined);
      return;
    }

    const act =
      graphActivity && subsByActivityGraph[graphActivity] ? graphActivity : activityOptionsGraph[0];

    const subs = act ? subsByActivityGraph[act] || [] : [];
    const sub = graphSub && subs.includes(graphSub) ? graphSub : subs[0] || undefined;

    const metrics = act && sub ? Object.keys(filteredRollupGraph[act]?.[sub] || {}) : [];
    const metric = graphMetric && metrics.includes(graphMetric) ? graphMetric : metrics[0] || undefined;

    setGraphActivity(act);
    setGraphSub(sub);
    setGraphMetric(metric);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityOptionsGraph, subsByActivityGraph, filteredRollupGraph]);

  // ---------- Milestones helpers (all-time, based on current graph selection) ----------
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

  // ✅ Milestones:
  // - Record Week works even when span < 7 days (uses smaller window)
  // - DS/NS averages are per NON-ZERO shift
  // - Adds bestShiftAvgValue so we can compute % diff for "Most Productive Shift"
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

    // Record week (rolling window, implicit zeros). If span < 7, use span length.
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

    const bestMonthPretty = (() => {
      if (!bestMonthKey) return '';
      const [y, m] = bestMonthKey.split('-').map((x) => parseInt(x, 10));
      const d = new Date(y, (m || 1) - 1, 1);
      return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(d);
    })();

    // DS/NS productivity (avg per NON-ZERO shift)
    let dsSum = 0,
      nsSum = 0;
    let dsN = 0,
      nsN = 0;
    let dsNonZero = 0,
      nsNonZero = 0;

    for (const r of rows) {
      const dn = String(r.dn || '').toUpperCase();
      const v = getShiftValueForSelection(r);

      if (dn === 'DS') {
        dsN += 1;
        if (v > 0) {
          dsNonZero += 1;
          dsSum += v;
        }
      } else if (dn === 'NS') {
        nsN += 1;
        if (v > 0) {
          nsNonZero += 1;
          nsSum += v;
        }
      }
    }

    const dsAvg = dsNonZero ? dsSum / dsNonZero : NaN;
    const nsAvg = nsNonZero ? nsSum / nsNonZero : NaN;

    const dsOk = Number.isFinite(dsAvg);
    const nsOk = Number.isFinite(nsAvg);

    let bestShiftLabel = '–';
    let bestShiftAvgValue = NaN;

    if (dsOk || nsOk) {
      if (dsOk && !nsOk) {
        bestShiftLabel = 'DS';
        bestShiftAvgValue = dsAvg;
      } else if (!dsOk && nsOk) {
        bestShiftLabel = 'NS';
        bestShiftAvgValue = nsAvg;
      } else if (dsOk && nsOk) {
        if (dsAvg === nsAvg) {
          bestShiftLabel = 'DS = NS';
          bestShiftAvgValue = dsAvg;
        } else if (dsAvg > nsAvg) {
          bestShiftLabel = 'DS';
          bestShiftAvgValue = dsAvg;
        } else {
          bestShiftLabel = 'NS';
          bestShiftAvgValue = nsAvg;
        }
      }
    }

    return {
      bestDay: { total: bestDayVal, date: bestDayDate },
      best7: { total: best7Val, start: best7Start, end: best7End },
      bestMonth: { total: bestMonthVal, ym: bestMonthKey, label: bestMonthPretty },
      shiftCompare: {
        dsAvg,
        nsAvg,
        dsN,
        nsN,
        dsNonZero,
        nsNonZero,
        bestShiftLabel,
        bestShiftAvgValue,
      },
    };
  }

  const milestonesAllTime = useMemo(
    () => computeMilestonesAllTime(rowsMilestones),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowsMilestones, graphActivity, graphSub, graphMetric],
  );

  const milestonesCrewAllTime = useMemo(
    () => (selectedCrewId ? computeMilestonesAllTime(rowsMilestonesCrew) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowsMilestonesCrew, selectedCrewId, graphActivity, graphSub, graphMetric],
  );

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
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
      return [];
    }

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
  const chartPaddingBottom = 40;
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

  // no memo here – always rebuild paths from current series
  const cumPathCurrent = buildCumPath(seriesCurrent);
  const cumPathCrew = buildCumPath(seriesCrew);

  const crewMatch = crew.find((c) => c.id === Number(selectedCrewId || 0));
  const crewName = crewMatch?.name || '';

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
              onClick={() => setTab('table')}
              className={`px-3 py-2 text-sm ${
                tab === 'table' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Tabulated data view
            </button>
            <button
              onClick={() => setTab('graph')}
              className={`px-3 py-2 text-sm ${
                tab === 'graph' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Graph data view
            </button>
          </div>

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
                <button className="btn" onClick={() => fetchTableData(fromTable, toTable)} disabled={loading}>
                  Apply
                </button>
              </div>

              {activityOptionsTable.length === 0 ? (
                <div className="text-sm text-slate-500">No data</div>
              ) : (
                Object.entries(filteredRollupTable).map(([act, subs]) => {
                  // SPECIAL DEVELOPMENT LAYOUT (with aligned columns)
                  if (lc(act) === 'development') {
                    const subsAny: any = subs as any;
                    const rehab = subsAny['Rehab'] || {};
                    const gs = subsAny['Ground Support'] || {};
                    const face = subsAny['Face Drilling'] || {};

                    const get = (obj: any, key: string) => Number((obj && obj[key]) ?? 0);

                    const rehabNoBolts = get(rehab, 'No. of bolts');
                    const rehabGsDrillm = get(rehab, 'GS Drillm');
                    const rehabAgi = get(rehab, 'Agi Volume');
                    const rehabSpray = get(rehab, 'Spray Volume');

                    const gsNoBolts = get(gs, 'No. of bolts');
                    const gsGsDrillm = get(gs, 'GS Drillm');
                    const gsAgi = get(gs, 'Agi Volume');
                    const gsSpray = get(gs, 'Spray Volume');

                    const faceDevDrillm = get(face, 'Dev Drillm');
                    const faceHoles = get(face, 'No of Holes');
                    const faceCut = get(face, 'Cut Length');

                    const allTotalDrillm = rehabGsDrillm + gsGsDrillm + faceDevDrillm;
                    const allNoBolts = rehabNoBolts + gsNoBolts;
                    const allCut = faceCut;
                    const allHoles = faceHoles;
                    const allAgi = rehabAgi + gsAgi;
                    const allSpray = rehabSpray + gsSpray;

                    const getCount = (subName: string, metric: string) =>
                      (nonZeroCounts[act] &&
                        nonZeroCounts[act][subName] &&
                        nonZeroCounts[act][subName][metric]) ||
                      0;

                    const rehabNoBoltsCount = getCount('Rehab', 'No. of bolts');
                    const rehabGsDrillmCount = getCount('Rehab', 'GS Drillm');
                    const rehabAgiCount = getCount('Rehab', 'Agi Volume');
                    const rehabSprayCount = getCount('Rehab', 'Spray Volume');

                    const gsNoBoltsCount = getCount('Ground Support', 'No. of bolts');
                    const gsGsDrillmCount = getCount('Ground Support', 'GS Drillm');
                    const gsAgiCount = getCount('Ground Support', 'Agi Volume');
                    const gsSprayCount = getCount('Ground Support', 'Spray Volume');

                    const faceDevDrillmCount = getCount('Face Drilling', 'Dev Drillm');
                    const faceHolesCount = getCount('Face Drilling', 'No of Holes');
                    const faceCutCount = getCount('Face Drilling', 'Cut Length');

                    const allTotalDrillmCount =
                      rehabGsDrillmCount + gsGsDrillmCount + faceDevDrillmCount;
                    const allNoBoltsCount = rehabNoBoltsCount + gsNoBoltsCount;
                    const allCutCount = faceCutCount;
                    const allHolesCount = faceHolesCount;
                    const allAgiCount = rehabAgiCount + gsAgiCount;
                    const allSprayCount = rehabSprayCount + gsSprayCount;

                    const safeAvg = (sum: number, denom: number) => (denom ? sum / denom : NaN);

                    return (
                      <div key={act}>
                        <div className="font-bold mb-1">{act}</div>

                        {/* Rehab */}
                        <div className="ml-3">
                          <div className="font-medium">Rehab</div>
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
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">No. of bolts</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {rehabNoBolts.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(rehabNoBolts, rehabNoBoltsCount))
                                    ? safeAvg(rehabNoBolts, rehabNoBoltsCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{rehabNoBoltsCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">GS Drillm</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {rehabGsDrillm.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(rehabGsDrillm, rehabGsDrillmCount))
                                    ? safeAvg(rehabGsDrillm, rehabGsDrillmCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{rehabGsDrillmCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Agi Volume</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {rehabAgi.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(rehabAgi, rehabAgiCount))
                                    ? safeAvg(rehabAgi, rehabAgiCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{rehabAgiCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Spray Volume</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {rehabSpray.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(rehabSpray, rehabSprayCount))
                                    ? safeAvg(rehabSpray, rehabSprayCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{rehabSprayCount}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        {/* Ground Support */}
                        <div className="ml-3 mt-4">
                          <div className="font-medium">Ground Support</div>
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
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">No. of bolts</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {gsNoBolts.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(gsNoBolts, gsNoBoltsCount))
                                    ? safeAvg(gsNoBolts, gsNoBoltsCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{gsNoBoltsCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">GS Drillm</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {gsGsDrillm.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(gsGsDrillm, gsGsDrillmCount))
                                    ? safeAvg(gsGsDrillm, gsGsDrillmCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{gsGsDrillmCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Agi Volume</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {gsAgi.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(gsAgi, gsAgiCount))
                                    ? safeAvg(gsAgi, gsAgiCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{gsAgiCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Spray Volume</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {gsSpray.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(gsSpray, gsSprayCount))
                                    ? safeAvg(gsSpray, gsSprayCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{gsSprayCount}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        {/* Face Drilling */}
                        <div className="ml-3 mt-4">
                          <div className="font-medium">Face Drilling</div>
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
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Dev Drillm</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {faceDevDrillm.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(faceDevDrillm, faceDevDrillmCount))
                                    ? safeAvg(faceDevDrillm, faceDevDrillmCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{faceDevDrillmCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">No of Holes</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {faceHoles.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(faceHoles, faceHolesCount))
                                    ? safeAvg(faceHoles, faceHolesCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{faceHolesCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Cut Length</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {faceCut.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(faceCut, faceCutCount))
                                    ? safeAvg(faceCut, faceCutCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{faceCutCount}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        {/* All (Development total) */}
                        <div className="ml-3 mt-4">
                          <div className="font-medium">All</div>
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
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Total Drillm</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {allTotalDrillm.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(allTotalDrillm, allTotalDrillmCount))
                                    ? safeAvg(allTotalDrillm, allTotalDrillmCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{allTotalDrillmCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">No. of bolts</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {allNoBolts.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(allNoBolts, allNoBoltsCount))
                                    ? safeAvg(allNoBolts, allNoBoltsCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{allNoBoltsCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Cut Length</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {allCut.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(allCut, allCutCount))
                                    ? safeAvg(allCut, allCutCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{allCutCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">No of Holes</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {allHoles.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(allHoles, allHolesCount))
                                    ? safeAvg(allHoles, allHolesCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{allHolesCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Agi Volume</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {allAgi.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(allAgi, allAgiCount))
                                    ? safeAvg(allAgi, allAgiCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{allAgiCount}</td>
                              </tr>
                              <tr>
                                <td className="py-1 pr-4 w-1/4 text-slate-700">Spray Volume</td>
                                <td className="py-1 pr-4 w-1/4 text-right font-semibold">
                                  {allSpray.toLocaleString()}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">
                                  {Number.isFinite(safeAvg(allSpray, allSprayCount))
                                    ? safeAvg(allSpray, allSprayCount).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    : '–'}
                                </td>
                                <td className="py-1 pr-4 w-1/4 text-right">{allSprayCount}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  }

                  // GENERIC LAYOUT FOR ALL OTHER ACTIVITIES
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
                                        ? avg.toLocaleString(undefined, {
                                            maximumFractionDigits: 2,
                                          })
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

              <div className="flex gap-2">
                <a href="/Main" className="btn flex-1 text-center">
                  BACK
                </a>
              </div>
            </div>
          )}

          {tab === 'graph' && (
            <div className="space-y-4">
              {/* date selection for GRAPH */}
              <div className="flex flex-wrap gap-2 items-end">
                <CalendarDropdown
                  label="From"
                  value={fromGraph}
                  onChange={setFromGraph}
                  datesWithData={datesWithData}
                />
                <CalendarDropdown
                  label="To"
                  value={toGraph}
                  onChange={setToGraph}
                  datesWithData={datesWithData}
                />
                <button className="btn" onClick={() => fetchGraphData(fromGraph, toGraph)} disabled={loading}>
                  Apply
                </button>
              </div>

              {activityOptionsGraph.length === 0 || !graphActivity || !graphSub || !graphMetric ? (
                <div className="text-sm text-slate-500">No data</div>
              ) : (
                <>
                  {/* Graph controls */}
                  <div className="flex flex-wrap gap-2 items-end">
                    <div>
                      <div className="text-xs text-slate-600 mb-1">Activity</div>
                      <select
                        className="input text-sm"
                        value={graphActivity}
                        onChange={(e) => setGraphActivity(e.target.value)}
                      >
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
                        value={graphSub || ''}
                        onChange={(e) => setGraphSub(e.target.value)}
                      >
                        {(subsByActivityGraph[graphActivity] || []).map((s) => (
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
                        value={graphMetric || ''}
                        onChange={(e) => setGraphMetric(e.target.value)}
                      >
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
                        onChange={(e) => {
                          const newId = e.target.value;
                          setSelectedCrewId(newId);
                          fetchCrewGraphData(newId, fromGraph, toGraph, setRowsGraphCrew);
                        }}
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

                  {/* Legend */}
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

                  {/* Milestones (all-time, hidden fetch) */}
                  {milestonesAllTime && (
                    <div className="border rounded p-3 bg-slate-50">
                      <div className="font-semibold mb-2">Milestones</div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                        {/* Record Shift */}
                        <div className="bg-white border rounded p-2">
                          <div className="text-xs text-slate-600">Record Shift</div>

                          <div className="font-semibold">
                            {milestonesAllTime.bestDay.total.toLocaleString()} on{' '}
                            {fmtDdMmYy(milestonesAllTime.bestDay.date)}
                          </div>

                          {selectedCrewId && milestonesCrewAllTime && (
                            <div className="mt-1 text-xs text-slate-700">
                              <span className="font-medium">{crewName}:</span>{' '}
                              {milestonesCrewAllTime.bestDay.total.toLocaleString()} on{' '}
                              {fmtDdMmYy(milestonesCrewAllTime.bestDay.date)}
                              {(() => {
                                const d = pctDiff(
                                  milestonesAllTime.bestDay.total,
                                  milestonesCrewAllTime.bestDay.total,
                                );
                                if (d === null) return null;
                                const cls = d >= 0 ? 'text-green-700' : 'text-red-700';
                                const sign = d >= 0 ? '+' : '';
                                return (
                                  <span className={`ml-2 font-semibold ${cls}`}>
                                    ({sign}
                                    {d.toFixed(1)}%)
                                  </span>
                                );
                              })()}
                            </div>
                          )}
                        </div>

                        {/* Record Week */}
                        <div className="bg-white border rounded p-2">
                          <div className="text-xs text-slate-600">Record Week</div>

                          <div className="font-semibold">
                            {milestonesAllTime.best7.total.toLocaleString()}
                          </div>
                          <div className="text-xs text-slate-600">
                            {milestonesAllTime.best7.start && milestonesAllTime.best7.end
                              ? `${fmtDdMmYy(milestonesAllTime.best7.start)} → ${fmtDdMmYy(
                                  milestonesAllTime.best7.end,
                                )}`
                              : '–'}
                          </div>

                          {selectedCrewId && milestonesCrewAllTime && (
                            <div className="mt-1 text-xs text-slate-700">
                              <span className="font-medium">{crewName}:</span>{' '}
                              {milestonesCrewAllTime.best7.total.toLocaleString()}
                              <span className="text-slate-600">
                                {' '}
                                (
                                {milestonesCrewAllTime.best7.start && milestonesCrewAllTime.best7.end
                                  ? `${fmtDdMmYy(milestonesCrewAllTime.best7.start)} → ${fmtDdMmYy(
                                      milestonesCrewAllTime.best7.end,
                                    )}`
                                  : '–'}
                                )
                              </span>
                              {(() => {
                                const d = pctDiff(
                                  milestonesAllTime.best7.total,
                                  milestonesCrewAllTime.best7.total,
                                );
                                if (d === null) return null;
                                const cls = d >= 0 ? 'text-green-700' : 'text-red-700';
                                const sign = d >= 0 ? '+' : '';
                                return (
                                  <span className={`ml-2 font-semibold ${cls}`}>
                                    ({sign}
                                    {d.toFixed(1)}%)
                                  </span>
                                );
                              })()}
                            </div>
                          )}
                        </div>

                        {/* Record Month */}
                        <div className="bg-white border rounded p-2">
                          <div className="text-xs text-slate-600">Record Month</div>

                          <div className="font-semibold">
                            {milestonesAllTime.bestMonth.total.toLocaleString()}
                          </div>
                          <div className="text-xs text-slate-600">
                            {fmtMonthMmYy(milestonesAllTime.bestMonth.ym)}
                          </div>

                          {selectedCrewId && milestonesCrewAllTime && (
                            <div className="mt-1 text-xs text-slate-700">
                              <span className="font-medium">{crewName}:</span>{' '}
                              {milestonesCrewAllTime.bestMonth.total.toLocaleString()}
                              <span className="text-slate-600">
                                {' '}
                                ({fmtMonthMmYy(milestonesCrewAllTime.bestMonth.ym)})
                              </span>
                              {(() => {
                                const d = pctDiff(
                                  milestonesAllTime.bestMonth.total,
                                  milestonesCrewAllTime.bestMonth.total,
                                );
                                if (d === null) return null;
                                const cls = d >= 0 ? 'text-green-700' : 'text-red-700';
                                const sign = d >= 0 ? '+' : '';
                                return (
                                  <span className={`ml-2 font-semibold ${cls}`}>
                                    ({sign}
                                    {d.toFixed(1)}%)
                                  </span>
                                );
                              })()}
                            </div>
                          )}
                        </div>

                        {/* Most Productive Shift */}
                        <div className="bg-white border rounded p-2">
                          <div className="text-xs text-slate-600">Most Productive Shift</div>

                          <div className="font-semibold">{milestonesAllTime.shiftCompare.bestShiftLabel}</div>

                          <div className="text-xs text-slate-600">
                            DS avg:{' '}
                            {Number.isFinite(milestonesAllTime.shiftCompare.dsAvg)
                              ? milestonesAllTime.shiftCompare.dsAvg.toLocaleString(undefined, {
                                  maximumFractionDigits: 2,
                                })
                              : '–'}
                          </div>
                          <div className="text-xs text-slate-600">
                            NS avg:{' '}
                            {Number.isFinite(milestonesAllTime.shiftCompare.nsAvg)
                              ? milestonesAllTime.shiftCompare.nsAvg.toLocaleString(undefined, {
                                  maximumFractionDigits: 2,
                                })
                              : '–'}
                          </div>

                          {selectedCrewId && milestonesCrewAllTime && (
                            <div className="mt-2 text-xs text-slate-700">
                              <div>
                                <span className="font-medium">{crewName}:</span>{' '}
                                {milestonesCrewAllTime.shiftCompare.bestShiftLabel}
                                {(() => {
                                  const d = pctDiff(
                                    milestonesAllTime.shiftCompare.bestShiftAvgValue,
                                    milestonesCrewAllTime.shiftCompare.bestShiftAvgValue,
                                  );
                                  if (d === null) return null;
                                  const cls = d >= 0 ? 'text-green-700' : 'text-red-700';
                                  const sign = d >= 0 ? '+' : '';
                                  return (
                                    <span className={`ml-2 font-semibold ${cls}`}>
                                      ({sign}
                                      {d.toFixed(1)}%)
                                    </span>
                                  );
                                })()}
                              </div>

                              <div className="text-slate-600">
                                DS avg:{' '}
                                {Number.isFinite(milestonesCrewAllTime.shiftCompare.dsAvg)
                                  ? milestonesCrewAllTime.shiftCompare.dsAvg.toLocaleString(undefined, {
                                      maximumFractionDigits: 2,
                                    })
                                  : '–'}
                              </div>
                              <div className="text-slate-600">
                                NS avg:{' '}
                                {Number.isFinite(milestonesCrewAllTime.shiftCompare.nsAvg)
                                  ? milestonesCrewAllTime.shiftCompare.nsAvg.toLocaleString(undefined, {
                                      maximumFractionDigits: 2,
                                    })
                                  : '–'}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Combo graph: bars (daily) + cumulative lines */}
                  {seriesCurrent.length === 0 && seriesCrew.length === 0 ? (
                    <div className="text-sm text-slate-500">No data for this selection</div>
                  ) : (
                    <div className="border rounded p-3 overflow-x-auto">
                      <svg width={svgWidth} height={svgHeight} className="block">
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

                        {/* left axis label */}
                        <text x={chartPaddingLeft - 24} y={chartPaddingTop - 4} fontSize={10} fill="#475569">
                          Daily total
                        </text>
                        {/* right axis label */}
                        <text
                          x={svgWidth - chartPaddingRight + 10}
                          y={chartPaddingTop - 4}
                          fontSize={10}
                          fill="#475569"
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
                              <text x={chartPaddingLeft - 12} y={y + 3} fontSize={9} fill="#64748b" textAnchor="end">
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
                              <rect x={xUser} y={yUser} width={singleWidth} height={hUser} fill="#64748b" />
                              {selectedCrewId && (
                                <rect x={xCrew} y={yCrew} width={singleWidth} height={hCrew} fill="#f59e0b" />
                              )}
                            </g>
                          );
                        })}

                        {/* cumulative line (you) */}
                        {cumPathCurrent && <path d={cumPathCurrent} fill="none" stroke="#0f766e" strokeWidth={2} />}

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
                          return <circle key={`dot-me-${pt.date}`} cx={xCenter} cy={y} r={3} fill="#0f766e" />;
                        })}
                        {selectedCrewId &&
                          seriesCrew.map((pt, i) => {
                            const xCenter = chartPaddingLeft + i * (barWidth + gap) + barWidth / 2;
                            const y = yCum(pt.cumulative);
                            return <circle key={`dot-crew-${pt.date}`} cx={xCenter} cy={y} r={2} fill="#f97316" />;
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
                              {pt.date.slice(5)}
                            </text>
                          );
                        })}
                      </svg>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
