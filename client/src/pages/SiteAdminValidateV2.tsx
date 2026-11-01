import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type DayStatus = 'red' | 'green' | 'none';
type AdminLocation = { name: string };
type AdminEquipment = { equipment_id: string };
type ValidationActivity = {
  id: number;
  user_name?: string;
  user_email?: string;
  dn?: string;
  activity?: string;
  sub_activity?: string;
  payload_json?: any;
};
type SummaryMetric = {
  key: string;
  label: string;
  section: 'DEVELOPMENT' | 'PRODUCTION' | 'HOISTING';
  unit?: string;
};

const METRICS: SummaryMetric[] = [
  { key: 'headings_supported', label: 'Headings Supported', section: 'DEVELOPMENT' },
  { key: 'headings_drilled', label: 'Headings Drilled', section: 'DEVELOPMENT' },
  { key: 'headings_charged', label: 'Headings Charged', section: 'DEVELOPMENT' },
  { key: 'headings_fired', label: 'Headings Fired', section: 'DEVELOPMENT' },
  { key: 'dev_ore_tonnes', label: 'Dev Ore Tonnes', section: 'DEVELOPMENT', unit: 't' },
  { key: 'dev_waste_tonnes', label: 'Dev Waste Tonnes', section: 'DEVELOPMENT', unit: 't' },
  { key: 'dev_ore_buckets', label: 'Dev Ore Buckets', section: 'DEVELOPMENT' },
  { key: 'dev_waste_buckets', label: 'Dev Waste Buckets', section: 'DEVELOPMENT' },
  { key: 'rehandle', label: 'Rehandle', section: 'DEVELOPMENT' },
  { key: 'tonnes_fired', label: 'Tonnes Fired', section: 'PRODUCTION', unit: 't' },
  { key: 'ore_tonnes', label: 'Ore Tonnes', section: 'PRODUCTION', unit: 't' },
  { key: 'stope_buckets', label: 'Stope Buckets', section: 'PRODUCTION' },
  { key: 'production_drill_m', label: 'Production Drill m', section: 'PRODUCTION', unit: 'm' },
  { key: 'surface_backfill_m3', label: 'Surface Backfill m³', section: 'PRODUCTION', unit: 'm³' },
  { key: 'ug_backfill_buckets', label: 'UG Backfill Buckets', section: 'PRODUCTION' },
  { key: 'hoist_ore_tonnes', label: 'Ore Tonnes', section: 'HOISTING', unit: 't' },
  { key: 'hoist_waste_tonnes', label: 'Waste Tonnes', section: 'HOISTING', unit: 't' },
];

const ACTIVITY_ORDER = [
  'Development',
  'Production Drilling',
  'Charging',
  'Firing',
  'Loading',
  'Hauling',
  'Backfilling',
  'Hoisting',
];
const DETAIL_KEYS = ['loads', 'holes', 'bolts', 'items', 'rows'];

const obj = (v: any) => {
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return typeof v === 'object' ? v : {};
};
const num = (v: any) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const text = (v: any) => String(v ?? '').trim();
const lower = (v: any) => text(v).toLowerCase();
const isDS = (v: any) => {
  const s = lower(v);
  return s === 'd' || s === 'ds' || s.startsWith('day');
};
const shiftLabel = (v: any) => (isDS(v) ? 'DS' : 'NS');
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const activityName = (r: ValidationActivity, p: any) => text(p?.activity || r.activity || 'Other');
const subName = (r: ValidationActivity, p: any) => text(p?.sub || p?.sub_activity || r.sub_activity || 'Other');
const values = (p: any) => (p?.values && typeof p.values === 'object' ? p.values : {});

function findValue(v: any, keys: string[]) {
  for (const k of keys) {
    if (v?.[k] !== undefined && v?.[k] !== null && text(v[k]) !== '') return v[k];
  }
  const keyMap = new Map(Object.keys(v || {}).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const actual = keyMap.get(k.toLowerCase());
    if (actual) return v[actual];
  }
  return '';
}

const equipment = (p: any) => text(findValue(values(p), ['Equipment', 'Equipment ID', 'equipment_id']) || p?.equipment_id);
const source = (p: any) => text(p?.source || findValue(values(p), ['Source', 'From']));
const locationValue = (p: any) => text(p?.location || p?.to || findValue(values(p), ['Location', 'Heading', 'Stope', 'To']));
function locationHeading(activity: string) {
  const a = lower(activity);
  if (a === 'hauling' || a === 'loading') return 'Source';
  if (a === 'backfilling') return 'To';
  if (a === 'hoisting') return '';
  return 'Location';
}
const groupValue = (activity: string, p: any) => (locationHeading(activity) === 'Source' ? source(p) : locationValue(p));
const material = (p: any) => lower(findValue(values(p), ['Material', 'Material Type', 'Ore/Waste']) || p?.material);
const numericField = (p: any, names: string[]) => num(findValue(values(p), names));
function tonnes(p: any) {
  const loads = Array.isArray(p?.loads) ? p.loads : [];
  return (
    loads.reduce((sum: number, l: any) => sum + num(l?.weight ?? l?.Weight ?? l?.tonnes ?? l?.Tonnes), 0) ||
    numericField(p, ['Tonnes Hauled', 'Tonnes', 'Total Tonnes', 'Weight'])
  );
}
const buckets = (p: any) => numericField(p, ['Buckets', 'No of Buckets', 'No. of Buckets', 'Bucket Count']);
function drillMetres(p: any) {
  const direct = numericField(p, ['Metres Drilled', 'Meters Drilled', 'Drill Metres', 'Drillm', 'Production Drill m']);
  if (direct) return direct;
  return (Array.isArray(p?.holes) ? p.holes : []).reduce(
    (sum: number, h: any) => sum + num(h?.length ?? h?.Length ?? h?.metres ?? h?.Meters),
    0,
  );
}

function contribution(r: ValidationActivity, p: any, key: string) {
  const a = lower(activityName(r, p));
  const s = lower(subName(r, p));
  const m = material(p);
  const t = tonnes(p);
  const b = buckets(p);
  const dev = s.includes('development') || a === 'development';
  const prod = s.includes('production') || a === 'production drilling';

  switch (key) {
    case 'headings_supported':
      return a === 'development' && (s.includes('ground support') || s.includes('rehab')) ? 1 : 0;
    case 'headings_drilled':
      return a === 'development' && s.includes('face drilling') ? 1 : 0;
    case 'headings_charged':
      return a === 'charging' && dev ? 1 : 0;
    case 'headings_fired':
      return a === 'firing' && (dev || !s) ? 1 : 0;
    case 'dev_ore_tonnes':
      return a === 'hauling' && dev && m.includes('ore') ? t : 0;
    case 'dev_waste_tonnes':
      return a === 'hauling' && dev && m.includes('waste') ? t : 0;
    case 'dev_ore_buckets':
      return a === 'loading' && dev && m.includes('ore') ? b : 0;
    case 'dev_waste_buckets':
      return a === 'loading' && dev && m.includes('waste') ? b : 0;
    case 'rehandle':
      return a === 'loading' && (s.includes('rehandle') || lower(source(p)).includes('stockpile')) ? b : 0;
    case 'tonnes_fired':
      return a === 'firing' && prod ? numericField(p, ['Tonnes Fired', 'Tonnes', 'Ore Tonnes']) : 0;
    case 'ore_tonnes':
      return a === 'hauling' && prod && (!m || m.includes('ore')) ? t : 0;
    case 'stope_buckets':
      return a === 'loading' && prod ? b : 0;
    case 'production_drill_m':
      return a === 'production drilling' ? drillMetres(p) : 0;
    case 'surface_backfill_m3':
      return a === 'backfilling' && s.includes('surface')
        ? numericField(p, ['m3', 'm³', 'Volume', 'Cubic Metres', 'Cubic Meters'])
        : 0;
    case 'ug_backfill_buckets':
      return a === 'backfilling' && (s.includes('underground') || s.includes('ug')) ? b : 0;
    case 'hoist_ore_tonnes':
      return a === 'hoisting' && m.includes('ore') ? numericField(p, ['Tonnes', 'Ore Tonnes', 'Weight']) : 0;
    case 'hoist_waste_tonnes':
      return a === 'hoisting' && m.includes('waste') ? numericField(p, ['Tonnes', 'Waste Tonnes', 'Weight']) : 0;
    default:
      return 0;
  }
}

const displayNumber = (v: number, unit?: string) => {
  const s = Math.abs(v - Math.round(v)) < 0.0001 ? String(Math.round(v)) : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return unit ? `${s} ${unit}` : s;
};

function calendarCells(year: number, month: number) {
  const offset = new Date(year, month, 1).getDay();
  const count = new Date(year, month + 1, 0).getDate();
  return [...Array(offset).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
}

export default function SiteAdminValidateV2() {
  const nav = useNavigate();
  const routeLocation = useLocation();
  const { Toast, setMsg } = useToast();
  const qs = useMemo(() => new URLSearchParams(routeLocation.search), [routeLocation.search]);
  const now = new Date();

  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState(qs.get('site') || '');
  const [date, setDate] = useState(qs.get('date') || ymd(now));
  const [year, setYear] = useState(Number((qs.get('date') || '').slice(0, 4)) || now.getFullYear());
  const [month, setMonth] = useState((Number((qs.get('date') || '').slice(5, 7)) || now.getMonth() + 1) - 1);
  const [days, setDays] = useState<Record<string, DayStatus>>({});
  const [shifts, setShifts] = useState<any[]>([]);
  const [acts, setActs] = useState<ValidationActivity[]>([]);
  const [edited, setEdited] = useState<Record<number, any>>({});
  const [unlocked, setUnlocked] = useState<Record<number, boolean>>({});
  const [detailOpen, setDetailOpen] = useState<Record<number, boolean>>({});
  const [locs, setLocs] = useState<AdminLocation[]>([]);
  const [equips, setEquips] = useState<AdminEquipment[]>([]);
  const [status, setStatus] = useState<DayStatus>('none');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api('/api/site-admin/sites');
        const list = (r?.sites || []).filter(Boolean);
        setSites(list);
        if (!site && list.length) setSite(list[0]);
      } catch {
        setSites([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (!site) return;
    (async () => {
      try {
        const [a, b] = await Promise.all([
          api(`/api/site-admin/admin-locations?site=${encodeURIComponent(site)}`),
          api(`/api/site-admin/admin-equipment?site=${encodeURIComponent(site)}`),
        ]);
        setLocs(a?.rows || a || []);
        setEquips(b?.rows || b || []);
      } catch {
        setLocs([]);
        setEquips([]);
      }
    })();
  }, [site]);

  async function loadCalendar() {
    if (!site) return;
    try {
      const r = await api(`/api/site-admin/calendar?year=${year}&site=${encodeURIComponent(site)}`);
      const next: Record<string, DayStatus> = {};
      for (const d of r?.days || []) next[String(d.date)] = (d.status || 'none') as DayStatus;
      setDays(next);
    } catch {
      setDays({});
    }
  }

  async function loadDay(d = date) {
    if (!site || !d) return;
    setLoading(true);
    try {
      const r = await api(`/api/site-admin/day?date=${encodeURIComponent(d)}&site=${encodeURIComponent(site)}`);
      setShifts(r?.validated_shifts || []);
      setActs(r?.validated_activities || []);
      setStatus((r?.status || 'none') as DayStatus);
      setEdited({});
      setUnlocked({});
      setDetailOpen({});
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load day');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCalendar();
  }, [site, year]);
  useEffect(() => {
    if (site && date) loadDay(date);
  }, [site, date]);

  const locationSet = useMemo(() => new Set(locs.map((x) => text(x.name)).filter(Boolean)), [locs]);
  const equipmentSet = useMemo(() => new Set(equips.map((x) => text(x.equipment_id)).filter(Boolean)), [equips]);
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of shifts) {
      if (s?.user_email) map.set(String(s.user_email), text(s.user_name) || String(s.user_email));
    }
    return map;
  }, [shifts]);

  const payload = (r: ValidationActivity) => edited[r.id] ?? obj(r.payload_json);
  const setPayload = (r: ValidationActivity, p: any) => setEdited((prev) => ({ ...prev, [r.id]: p }));

  function updateValue(r: ValidationActivity, key: string, raw: string) {
    const p = { ...payload(r) };
    p.values = {
      ...values(p),
      [key]: raw === '' ? '' : !Number.isNaN(Number(raw)) ? Number(raw) : raw,
    };
    setPayload(r, p);
  }

  function updateGroupValue(r: ValidationActivity, key: 'location' | 'source', raw: string) {
    setPayload(r, { ...payload(r), [key]: raw });
  }

  function hasIssue(r: ValidationActivity) {
    const p = payload(r);
    const a = activityName(r, p);
    const e = equipment(p);
    const g = groupValue(a, p);
    if (lower(a) === 'hoisting') return false;
    if (!g || (locationSet.size > 0 && !locationSet.has(g))) return true;
    if (!e || (equipmentSet.size > 0 && !equipmentSet.has(e))) return true;
    return false;
  }

  const summary = useMemo(() => {
    const out: Record<string, { DS: number; NS: number }> = {};
    for (const m of METRICS) out[m.key] = { DS: 0, NS: 0 };
    for (const r of acts) {
      const p = payload(r);
      const shift = shiftLabel(r.dn || p?.dn) as 'DS' | 'NS';
      for (const m of METRICS) out[m.key][shift] += contribution(r, p, m.key);
    }
    return out;
  }, [acts, edited]);

  const unresolved = useMemo(() => acts.filter(hasIssue), [acts, edited, locationSet, equipmentSet]);

  async function persist() {
    const edits = Object.entries(edited).map(([id, payload_json]) => ({ id: Number(id), payload_json }));
    if (!edits.length) return;
    await api('/api/site-admin/update-validated', {
      method: 'POST',
      body: JSON.stringify({ site, date, edits }),
    });
  }

  async function validate() {
    if (unresolved.length) {
      setMsg(`${unresolved.length} activit${unresolved.length === 1 ? 'y' : 'ies'} still require attention.`);
      document.getElementById(`validation-row-${unresolved[0].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    try {
      setLoading(true);
      await persist();
      await api('/api/site-admin/validate', {
        method: 'POST',
        body: JSON.stringify({ date, site }),
      });
      setMsg('24 hours validated');
      await loadDay(date);
      await loadCalendar();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to validate 24 hours');
    } finally {
      setLoading(false);
    }
  }

  async function reopen() {
    try {
      setLoading(true);
      await api('/api/site-admin/unvalidate', {
        method: 'POST',
        body: JSON.stringify({ site, date }),
      });
      await loadDay(date);
      await loadCalendar();
      setMsg('Validation reopened');
    } catch (e: any) {
      setMsg(e?.message || 'Failed to reopen validation');
    } finally {
      setLoading(false);
    }
  }

  async function removeActivity(r: ValidationActivity) {
    const reason = window.prompt('Short reason for removing this activity from validated reporting:')?.trim();
    if (!reason || !window.confirm('Remove this activity from the validated dataset?')) return;
    try {
      await api('/api/site-admin/validated/delete-activity', {
        method: 'POST',
        body: JSON.stringify({ site, date, id: r.id, reason }),
      });
      await loadDay(date);
      await loadCalendar();
      setMsg('Activity removed');
    } catch (e: any) {
      setMsg(e?.message || 'Failed to remove activity');
    }
  }

  const detailKey = (p: any) => DETAIL_KEYS.find((k) => Array.isArray(p?.[k]));
  function updateDetail(r: ValidationActivity, key: string, index: number, field: string, raw: string) {
    const p = { ...payload(r) };
    const rows = [...(Array.isArray(p[key]) ? p[key] : [])];
    rows[index] = {
      ...(rows[index] || {}),
      [field]: raw === '' ? '' : !Number.isNaN(Number(raw)) ? Number(raw) : raw,
    };
    p[key] = rows;
    setPayload(r, p);
  }
  function deleteDetail(r: ValidationActivity, key: string, index: number) {
    const p = { ...payload(r) };
    const rows = [...(Array.isArray(p[key]) ? p[key] : [])];
    rows.splice(index, 1);
    p[key] = rows;
    setPayload(r, p);
  }
  function addDetail(r: ValidationActivity, key: string) {
    const p = { ...payload(r) };
    const rows = [...(Array.isArray(p[key]) ? p[key] : [])];
    const template =
      rows[0] && typeof rows[0] === 'object'
        ? Object.fromEntries(Object.keys(rows[0]).map((field) => [field, '']))
        : { value: '' };
    rows.push(template);
    p[key] = rows;
    setPayload(r, p);
  }

  const grouped = useMemo(() => {
    const activityMap = new Map<string, Map<string, ValidationActivity[]>>();
    for (const r of acts) {
      const p = payload(r);
      const a = activityName(r, p);
      const s = subName(r, p);
      if (!activityMap.has(a)) activityMap.set(a, new Map());
      const subMap = activityMap.get(a)!;
      if (!subMap.has(s)) subMap.set(s, []);
      subMap.get(s)!.push(r);
    }
    return [...activityMap.entries()].sort(([a], [b]) => {
      const ai = ACTIVITY_ORDER.indexOf(a);
      const bi = ACTIVITY_ORDER.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
    });
  }, [acts, edited]);

  function columns(rows: ValidationActivity[]) {
    const set = new Set<string>();
    for (const r of rows) {
      for (const key of Object.keys(values(payload(r)))) {
        if (['equipment', 'location', 'source', 'from', 'to'].includes(key.toLowerCase())) continue;
        set.add(key);
      }
    }
    const preferred = ['Material', 'No of Holes', 'No. of Holes', 'Cut Length', 'Metres Drilled', 'Meters Drilled', 'Buckets', 'No of Buckets', 'No. of Buckets', 'Tonnes', 'Tonnes Hauled', 'Distance'];
    return [...set].sort((a, b) => {
      const ai = preferred.indexOf(a);
      const bi = preferred.indexOf(b);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return a.localeCompare(b);
    });
  }

  const monthName = new Date(year, month, 1).toLocaleString(undefined, { month: 'long' });
  const canEdit = status !== 'green';

  return (
    <div className="max-w-7xl mx-auto px-4 py-4 space-y-5">
      <Toast />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold tracking-[.18em] uppercase text-slate-500">Site validation</div>
          <h1 className="text-2xl font-bold">{site || 'Site'}</h1>
          <div className="text-sm text-slate-500">Review the complete DS / NS operating day before validating.</div>
        </div>
        <div className="flex gap-2">
          <button
            className="btn"
            disabled={!date || !canEdit}
            onClick={() => nav(`/SiteAdmin/AddActivity?date=${encodeURIComponent(date)}&site=${encodeURIComponent(site)}`)}
          >
            + Add activity
          </button>
          {status === 'green' ? (
            <button className="btn" onClick={reopen} disabled={loading}>Reopen validation</button>
          ) : (
            <button
              className="px-4 py-2 rounded-lg bg-slate-900 text-white font-semibold disabled:opacity-40"
              onClick={validate}
              disabled={loading || !acts.length}
            >
              Validate 24 Hours
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
            {sites.map((s) => <option key={s}>{s}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => { const d = new Date(year, month - 1, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); }}>‹</button>
            <div className="font-semibold min-w-[160px] text-center">{monthName} {year}</div>
            <button className="btn" onClick={() => { const d = new Date(year, month + 1, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); }}>›</button>
          </div>
        </div>
        <div className="grid grid-cols-7 text-[11px] uppercase text-slate-500 mb-1">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="px-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 border-t border-l border-[color:var(--hairline)]">
          {calendarCells(year, month).map((d, i) => {
            if (!d) return <div key={i} className="min-h-[58px] border-r border-b border-[color:var(--hairline)]" />;
            const day = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dayStatus = days[day] || 'none';
            return (
              <button
                key={day}
                onClick={() => setDate(day)}
                className={`min-h-[58px] p-2 text-left border-r border-b border-[color:var(--hairline)] hover:bg-slate-50 ${date === day ? 'ring-2 ring-inset ring-slate-700' : ''}`}
              >
                <div className="flex justify-between">
                  <span>{d}</span>
                  <span className="text-slate-500">{dayStatus === 'green' ? '✓' : dayStatus === 'red' ? '×' : ''}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {date && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs uppercase text-slate-500">24 hour review</div>
              <div className="text-xl font-bold">
                {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
            </div>
            <div className="text-sm text-slate-500">
              {acts.length} activities · {unresolved.length ? `${unresolved.length} require attention` : 'ready to validate'}
            </div>
          </div>

          <div className="card">
            <div className="text-[11px] uppercase tracking-[.15em] text-slate-500 mb-3">24-hour totals</div>
            <div className="grid lg:grid-cols-3 gap-6">
              {(['DEVELOPMENT', 'PRODUCTION', 'HOISTING'] as const).map((section) => (
                <div key={section}>
                  <div className="font-bold text-xs tracking-[.14em] pb-2 border-b-2 border-slate-300">{section}</div>
                  <div className="grid grid-cols-[1fr_70px_70px] text-[11px] font-semibold text-slate-500 py-1.5 border-b border-[color:var(--hairline)]">
                    <div>Metric</div><div className="text-right">DS</div><div className="text-right">NS</div>
                  </div>
                  {METRICS.filter((m) => m.section === section).map((m) => (
                    <div key={m.key} className="grid grid-cols-[1fr_70px_70px] py-1.5 border-b border-[color:var(--hairline)] text-sm">
                      <div>{m.label}</div>
                      <div className="text-right font-medium">{displayNumber(summary[m.key]?.DS || 0, m.unit)}</div>
                      <div className="text-right font-medium">{displayNumber(summary[m.key]?.NS || 0, m.unit)}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {unresolved.length > 0 && (
            <div className="card border border-slate-300">
              <div className="font-semibold">{unresolved.length} item{unresolved.length === 1 ? '' : 's'} require attention</div>
              <div className="text-sm text-slate-500">Missing or unmapped equipment/location fields are marked × below.</div>
            </div>
          )}

          <div className="space-y-6">
            {grouped.map(([activity, subMap]) => (
              <section key={activity} className="card p-0 overflow-hidden">
                <div className="px-4 py-3 border-b-2 border-slate-300 bg-slate-50">
                  <div className="font-bold text-sm uppercase tracking-[.12em]">{activity}</div>
                </div>

                <div className="divide-y divide-[color:var(--hairline)]">
                  {[...subMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sub, rows]) => {
                    const cols = columns(rows);
                    const groupLabel = locationHeading(activity);
                    const totals: Record<string, number> = Object.fromEntries(
                      cols.map((c) => [c, rows.reduce((sum, r) => sum + num(values(payload(r))[c]), 0)]),
                    );
                    const colspan = 5 + (groupLabel ? 1 : 0) + cols.length;

                    return (
                      <div key={`${activity}-${sub}`}>
                        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
                          <div>
                            <div className="text-[10px] uppercase tracking-[.14em] text-slate-500">Sub-activity</div>
                            <div className="font-semibold">{sub}</div>
                          </div>
                          <div className="text-xs text-slate-500">{rows.length} task{rows.length === 1 ? '' : 's'}</div>
                        </div>

                        <div className="overflow-auto px-4 pb-4">
                          <table className="w-full min-w-[980px] text-sm border border-[color:var(--hairline)]">
                            <thead>
                              <tr className="bg-slate-50 border-b border-[color:var(--hairline)]">
                                <th className="px-3 py-2 text-left font-semibold">Operator</th>
                                <th className="px-3 py-2 text-left font-semibold">Shift</th>
                                <th className="px-3 py-2 text-left font-semibold">Equipment</th>
                                {groupLabel && <th className="px-3 py-2 text-left font-semibold">{groupLabel}</th>}
                                {cols.map((c) => <th key={c} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{c}</th>)}
                                <th className="px-3 py-2 text-center font-semibold">Status</th>
                                <th className="px-3 py-2 text-right font-semibold">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r) => {
                                const p = payload(r);
                                const v = values(p);
                                const bad = hasIssue(r);
                                const open = !!detailOpen[r.id];
                                const dk = detailKey(p);
                                const editable = canEdit && !!unlocked[r.id];
                                const operator = text(r.user_name) || names.get(text(r.user_email)) || text(r.user_email) || '—';

                                return (
                                  <Fragment key={r.id}>
                                    <tr id={`validation-row-${r.id}`} className="border-b border-[color:var(--hairline)] last:border-b-0">
                                      <td className="px-3 py-2 font-medium">{operator}</td>
                                      <td className="px-3 py-2">{shiftLabel(r.dn || p?.dn)}</td>
                                      <td className="px-3 py-2">
                                        {editable ? (
                                          <select className="input min-w-[120px]" value={equipment(p)} onChange={(e) => updateValue(r, 'Equipment', e.target.value)}>
                                            <option value="">Select…</option>
                                            {equips.map((x) => <option key={x.equipment_id}>{x.equipment_id}</option>)}
                                          </select>
                                        ) : equipment(p) || '—'}
                                      </td>
                                      {groupLabel && (
                                        <td className="px-3 py-2">
                                          {editable ? (
                                            <select
                                              className="input min-w-[150px]"
                                              value={groupValue(activity, p)}
                                              onChange={(e) => updateGroupValue(r, groupLabel === 'Source' ? 'source' : 'location', e.target.value)}
                                            >
                                              <option value="">Select…</option>
                                              {locs.map((x) => <option key={x.name}>{x.name}</option>)}
                                            </select>
                                          ) : groupValue(activity, p) || '—'}
                                        </td>
                                      )}
                                      {cols.map((c) => (
                                        <td key={c} className="px-3 py-2">
                                          {editable ? (
                                            <input className="input min-w-[90px]" value={String(v[c] ?? '')} onChange={(e) => updateValue(r, c, e.target.value)} />
                                          ) : String(v[c] ?? '—')}
                                        </td>
                                      ))}
                                      <td className="px-3 py-2 text-center font-semibold">{bad ? '×' : '✓'}</td>
                                      <td className="px-3 py-2 text-right whitespace-nowrap">
                                        {dk && (
                                          <button className="btn btn-xs mr-1" onClick={() => setDetailOpen((prev) => ({ ...prev, [r.id]: !prev[r.id] }))}>
                                            {open ? 'Hide' : 'Details'}
                                          </button>
                                        )}
                                        <button
                                          className="btn btn-xs"
                                          disabled={!canEdit}
                                          onClick={() => setUnlocked((prev) => ({ ...prev, [r.id]: !prev[r.id] }))}
                                          title={unlocked[r.id] ? 'Lock row' : 'Unlock row'}
                                        >
                                          {unlocked[r.id] ? '🔓' : '🔒'}
                                        </button>
                                        {editable && <button className="btn btn-xs ml-1" onClick={() => removeActivity(r)}>Remove</button>}
                                      </td>
                                    </tr>

                                    {open && dk && (
                                      <tr className="border-b border-[color:var(--hairline)]">
                                        <td colSpan={colspan} className="p-3 bg-slate-50/60">
                                          {(() => {
                                            const detailRows: any[] = Array.isArray(p[dk]) ? p[dk] : [];
                                            const detailCols: string[] = [...new Set<string>(detailRows.flatMap((d: any) => Object.keys(d || {})))].filter((k) => !k.startsWith('_'));
                                            return (
                                              <div className="space-y-2">
                                                <div className="flex justify-between items-center">
                                                  <b className="text-xs uppercase tracking-[.12em]">{dk}</b>
                                                  {editable && <button className="btn btn-xs" onClick={() => addDetail(r, dk)}>+ Add</button>}
                                                </div>
                                                <table className="w-full text-xs bg-white border border-[color:var(--hairline)]">
                                                  <thead>
                                                    <tr className="bg-slate-50">
                                                      {detailCols.map((c) => <th key={c} className="p-2 text-left">{c}</th>)}
                                                      {editable && <th />}
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {detailRows.map((d: any, i: number) => (
                                                      <tr key={i} className="border-t border-[color:var(--hairline)]">
                                                        {detailCols.map((c) => (
                                                          <td key={c} className="p-1.5">
                                                            {editable ? (
                                                              <input className="input w-full" value={String(d?.[c] ?? '')} onChange={(e) => updateDetail(r, dk, i, c, e.target.value)} />
                                                            ) : String(d?.[c] ?? '—')}
                                                          </td>
                                                        ))}
                                                        {editable && <td className="p-1.5 text-right"><button className="btn btn-xs" onClick={() => deleteDetail(r, dk, i)}>×</button></td>}
                                                      </tr>
                                                    ))}
                                                  </tbody>
                                                </table>
                                              </div>
                                            );
                                          })()}
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              })}

                              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                                <td className="px-3 py-2">Total</td>
                                <td className="px-3 py-2" />
                                <td className="px-3 py-2" />
                                {groupLabel && <td className="px-3 py-2" />}
                                {cols.map((c) => (
                                  <td key={c} className="px-3 py-2">{totals[c] ? displayNumber(totals[c]) : '—'}</td>
                                ))}
                                <td className="px-3 py-2" />
                                <td className="px-3 py-2" />
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}

            {!loading && !acts.length && (
              <div className="card text-sm text-slate-500">No validated activities exist for this date. Use <b>+ Add activity</b> to build the missing shift/day.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
