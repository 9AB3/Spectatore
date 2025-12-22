import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

type DayStatus = 'red' | 'green' | 'none';

type ShiftRow = {
  shift_id: number;
  user_id: number;
  user_name: string;
  user_email: string;
  site: string;
  date: string;
  dn: string;
  totals_json: string;
  finalized_at: string;
};

type AdminLocationRow = { id?: number; site: string; name: string; type: 'Heading' | 'Stope' | 'Stockpile' | '' };
type AdminEquipmentRow = { id?: number; site: string; equipment_id: string; type: string };

type ActRow = {
  id: number;
  shift_id: number;
  user_id: number;
  site: string;
  dn: string;
  activity: string;
  sub_activity: string;
  payload_json: string;
};

type FlatKV = { path: string; label: string; value: any; kind: 'primitive' | 'json' };

// ----- subtle/pro change indicators for edited cells -----
function changedCellTdClass(isChanged: boolean) {
  if (!isChanged) return '';
  // Left 3px accent bar + barely-visible tint.
  // Keep it professional: muted amber + slate.
  return [
    'relative',
    'bg-amber-50/40',
    "before:content-['']",
    'before:absolute',
    'before:left-0',
    'before:top-0',
    'before:bottom-0',
    'before:w-[3px]',
    'before:bg-amber-400/70',
  ].join(' ');
}

function ChangedBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="absolute top-1 right-1 text-[10px] leading-none px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-700">
      Edited
    </span>
  );
}

function isPlainObject(v: any) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function n(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}

// Mirrors server totals logic (authoritative) but computed from VALIDATED payloads.
function computeTotalsBySubFromPayloads(payloads: any[]) {
  const totals: Record<string, Record<string, Record<string, number>>> = {};
  for (const p0 of payloads) {
    const p: any = p0 || {};
    const activity = p.activity || '(No Activity)';
    const subActivity = p.sub || p.sub_activity || '(No Sub Activity)';
    totals[activity] ||= {};
    totals[activity][subActivity] ||= {};

    for (const [k, v] of Object.entries(p.values || {})) {
      // Bolt Length is an input field (used for GS Drillm), but it should NOT be summed in shift totals.
      if (activity === 'Development' && String(k).toLowerCase() === 'bolt length') continue;

      // For Hauling shift totals:
      // - Distance should be Σ(trucks × distance)
      // - Weight should be Σ(trucks × weight)
      // We compute those weighted totals separately so the raw per-load inputs don't get summed.
      const kl = String(k || '').toLowerCase();
      if (activity === 'Hauling' && (kl === 'distance' || kl === 'weight')) continue;

      const num = typeof v === 'number' ? v : parseFloat(String(v));
      if (!Number.isNaN(num)) totals[activity][subActivity][k] = (totals[activity][subActivity][k] || 0) + num;
    }

    if (activity === 'Development' && subActivity === 'Face Drilling') {
      const holes = n((p.values || {})['No of Holes']);
      const cut = n((p.values || {})['Cut Length']);
      totals[activity][subActivity]['Dev Drillm'] = (totals[activity][subActivity]['Dev Drillm'] || 0) + holes * cut;
    }
    if (activity === 'Development' && (subActivity === 'Ground Support' || subActivity === 'Rehab')) {
      const bolts = n((p.values || {})['No. of Bolts']);
      const blRaw = String((p.values || {})['Bolt Length'] ?? '').replace('m', '');
      const bl = n(blRaw);
      totals[activity][subActivity]['GS Drillm'] = (totals[activity][subActivity]['GS Drillm'] || 0) + bolts * bl;
    }
    if (activity === 'Hauling' && (subActivity === 'Production' || subActivity === 'Development')) {
      const wt = n((p.values || {})['Weight']);
      const dist = n((p.values || {})['Distance']);
      const trucks = n((p.values || {})['Trucks']);

      // Weighted totals
      totals[activity][subActivity]['Weight'] = (totals[activity][subActivity]['Weight'] || 0) + wt * trucks;
      totals[activity][subActivity]['Distance'] = (totals[activity][subActivity]['Distance'] || 0) + dist * trucks;

      // TKMs stays weighted by wt × dist × trucks
      totals[activity][subActivity]['TKMs'] = (totals[activity][subActivity]['TKMs'] || 0) + wt * dist * trucks;
    }
  }
  return totals;
}

function flattenTotalsWithKey(totals: Record<string, Record<string, Record<string, number>>>) {
  const rows: { k: string; activity: string; sub: string; metric: string; value: number }[] = [];
  for (const [act, subs] of Object.entries(totals)) {
    for (const [sub, mets] of Object.entries(subs)) {
      for (const [metric, value] of Object.entries(mets)) {
        const k = `${act}|||${sub}|||${metric}`;
        rows.push({ k, activity: act, sub, metric, value: Number(value || 0) });
      }
    }
  }
  return rows;
}

function flattenObject(obj: any, prefix = ''): FlatKV[] {
  const out: FlatKV[] = [];
  const push = (path: string, value: any, kind: FlatKV['kind']) => {
    const label = path || '(root)';
    out.push({ path, label, value, kind });
  };

  // primitives
  if (obj == null || typeof obj !== 'object') {
    push(prefix, obj, 'primitive');
    return out;
  }

  // arrays
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      push(prefix, [], 'json');
      return out;
    }
    obj.forEach((v, i) => {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      if (v != null && typeof v === 'object') out.push(...flattenObject(v, p));
      else push(p, v, 'primitive');
    });
    return out;
  }

  // objects
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    push(prefix, {}, 'json');
    return out;
  }
  for (const k of keys) {
    const v = (obj as any)[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object') out.push(...flattenObject(v, p));
    else push(p, v, 'primitive');
  }
  return out;
}

function pathTokens(path: string): (string | number)[] {
  // supports: a.b[0].c
  const tokens: (string | number)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(parseInt(m[2], 10));
  }
  return tokens;
}

function cloneDeep<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

function asObj(v: any) {
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (typeof v === 'object') return v;
  return {};
}

function setDeep(root: any, path: string, raw: string) {
  const tokens = pathTokens(path);
  if (tokens.length === 0) return root;

  const out = cloneDeep(root ?? {});
  let cur: any = out;

  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (typeof t === 'number') {
      if (!Array.isArray(cur)) cur = [];
      if (cur[t] == null) cur[t] = typeof next === 'number' ? [] : {};
      cur = cur[t];
    } else {
      if (cur[t] == null) cur[t] = typeof next === 'number' ? [] : {};
      cur = cur[t];
    }
  }

  const leaf = tokens[tokens.length - 1];

  // coerce value back to number/bool/null where possible
  let v: any = raw;
  if (raw === '') v = '';
  else if (raw === 'null') v = null;
  else if (raw === 'true') v = true;
  else if (raw === 'false') v = false;
  else if (!Number.isNaN(Number(raw)) && raw.trim() !== '') v = Number(raw);

  if (typeof leaf === 'number') {
    if (!Array.isArray(cur)) cur = [];
    cur[leaf] = v;
  } else {
    cur[leaf] = v;
  }
  return out;
}

// Safer updater for payload.values[metricKey] where metricKey may contain dots
// (e.g. "No. of Bolts"). Avoids path parsing splitting on '.' inside metric names.
function setValuesKey(payload: any, metricKey: string, raw: string) {
  const out: any = cloneDeep(payload ?? {});
  if (!out.values || typeof out.values !== 'object') out.values = {};

  // coerce value back to number/bool/null where possible
  let v: any = raw;
  if (raw === '') v = '';
  else if (raw === 'null') v = null;
  else if (raw === 'true') v = true;
  else if (raw === 'false') v = false;
  else if (!Number.isNaN(Number(raw)) && raw.trim() !== '') v = Number(raw);

  out.values[metricKey] = v;
  return out;
}

function ymd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function dayClass(st: DayStatus) {
  switch (st) {
    case 'green':
      return 'bg-emerald-500 text-white hover:bg-green-600';
    case 'red':
      return 'bg-rose-500 text-white hover:bg-red-600';
    default:
      return 'bg-slate-100 hover:bg-slate-200 text-slate-700';
  }
}

function monthGrid(year: number, monthIndex0: number) {
  const first = new Date(year, monthIndex0, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday=0
  const daysInMonth = new Date(year, monthIndex0 + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function statusClass(s: DayStatus) {
  if (s === 'green') return 'bg-emerald-500 text-white';
  if (s === 'red') return 'bg-rose-500 text-white';
  return 'bg-transparent';
}

function allowedEquipmentTypes(activity: string, sub: string) {
  const a = String(activity || '');
  // Keep simple and strict where it matters most
  if (a === 'Hauling') return ['Truck'];
  if (a === 'Loading') return ['Loader'];
  if (a === 'Development') return ['Jumbo', 'Spray Rig', 'Agi'];
  if (a === 'Production Drilling') return ['Production Drill'];
  if (a === 'Charging') return ['Charge Rig'];
  return [];
}

function allowedLocationTypes(activity: string, sub: string, fieldName: string) {
  const a = String(activity || '');
  const s = String(sub || '');
  const f = String(fieldName || '');

  // Development
  if (a === 'Development') {
    if (s === 'Face Drilling') return ['Heading'];
    if (s === 'Ground Support') return ['Heading'];
    if (s === 'Rehab') return ['Heading'];
    if (s === 'Service Hole') return ['Heading'];
    if (s === 'Stope') return ['Stope'];
  }
  // Charging
  if (a === 'Charging') {
    if (s === 'Development') return ['Heading'];
    if (s === 'Production') return ['Stope'];
  }
  // Loading
  if (a === 'Loading') {
    if (s === 'Development') return ['Heading'];
    if (s === 'Production') return ['Stope'];
  }
  // Hauling
  if (a === 'Hauling') {
    if (s === 'Development') {
      if (f === 'Source') return ['Heading'];
      if (f === 'From' || f === 'To') return ['Stockpile'];
      return ['Stockpile'];
    }
    if (s === 'Production') {
      if (f === 'Source') return ['Stope'];
      if (f === 'From' || f === 'To') return ['Stockpile'];
      return ['Stockpile'];
    }
  }

  return ['Heading', 'Stope', 'Stockpile'];
}

/** ✅ FIXED TYPES HERE (this resolves TS7006 on Vercel) */
type ActKeyBaseInput = { dn: string; activity: string; sub_activity: string };
function actKeyBase(act: ActKeyBaseInput, userEmail: string, location: string) {
  return `${userEmail}|||${act.dn}|||${act.activity}|||${act.sub_activity}|||${location}`;
}

export default function SiteAdminValidate() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState<string>('');
  const [days, setDays] = useState<Record<string, DayStatus>>({});
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [loadingDay, setLoadingDay] = useState(false);

  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [acts, setActs] = useState<ActRow[]>([]);
  const [editedActs, setEditedActs] = useState<Record<number, any>>({});
  const [adminLocRows, setAdminLocRows] = useState<AdminLocationRow[]>([]);
  const [adminEquipRows, setAdminEquipRows] = useState<AdminEquipmentRow[]>([]);

  const [validatedShifts, setValidatedShifts] = useState<any[]>([]);
  const [validatedActs, setValidatedActs] = useState<any[]>([]);
  const [dayStatus, setDayStatus] = useState<DayStatus>('none');
  const [calendarOpen, setCalendarOpen] = useState<boolean>(true);

  // Ensure logged in
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const sa = await db.get('session', 'site_admin');
      if (sa?.token) return;
      const auth = await db.get('session', 'auth');
      if (auth?.token && auth?.is_admin) return;
      nav('/SiteAdminLogin');
    })();
  }, [nav]);

  // Load site list
  useEffect(() => {
    (async () => {
      try {
        const res = await api('/api/site-admin/sites');
        const list: string[] = (res?.sites || []).filter(Boolean);
        setSites(list);
        if (!site && list.length) setSite(list[0]);
      } catch {
        // ignore
      }
    })();
  }, []);

  // Load calendar status
  useEffect(() => {
    if (!site) return;
    (async () => {
      try {
        const res = await api(`/api/site-admin/calendar?year=${year}&site=${encodeURIComponent(site)}`);
        const map: Record<string, DayStatus> = {};
        for (const d of res?.days || []) map[String(d.date)] = d.status as DayStatus;
        setDays(map);
      } catch {
        setDays({});
      }
    })();
  }, [year, site]);

  // Load SiteAdmin master location list (per-site)
  useEffect(() => {
    if (!site) return;
    (async () => {
      try {
        const r = await api(`/api/site-admin/admin-locations?site=${encodeURIComponent(site)}`);
        setAdminLocRows((r?.rows || []) as any);
      } catch {
        setAdminLocRows([]);
      }
    })();
  }, [site]);

  // Load SiteAdmin master equipment list (per-site)
  useEffect(() => {
    if (!site) return;
    (async () => {
      try {
        const r = await api(`/api/site-admin/admin-equipment?site=${encodeURIComponent(site)}`);
        setAdminEquipRows((r?.rows || []) as any);
      } catch {
        setAdminEquipRows([]);
      }
    })();
  }, [site]);

  async function loadDate(date: string) {
    setSelectedDate(date);
    setLoadingDay(true);
    try {
      const res = await api(`/api/site-admin/day?date=${date}&site=${encodeURIComponent(site)}`);
      setShifts(res.shifts || []);
      setActs(res.activities || []);
      setValidatedShifts(res.validated_shifts || []);
      setValidatedActs(res.validated_activities || []);
      setDayStatus(((res.status as any) || 'none') as DayStatus);
      setEditedActs({});
    } catch {
      setMsg('Failed to load day');
    } finally {
      setLoadingDay(false);
    }
  }

  const actsByActivity = useMemo(() => {
    const m: Record<string, ActRow[]> = {};
    for (const a of validatedActs as any[]) {
      const k = a.activity || 'Other';
      (m[k] ||= []).push(a);
    }
    return m;
  }, [acts]);

  const shiftById = useMemo(() => {
    const m = new Map<number, ShiftRow>();
    for (const s of shifts) m.set(s.shift_id, s);
    return m;
  }, [shifts]);

  const nameByEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of validatedShifts as any[]) {
      const em = String((s as any)?.user_email || '');
      const nm = String((s as any)?.user_name || '').trim();
      if (em) m.set(em, nm || em);
    }
    // fallback from live shifts too
    for (const s of shifts as any[]) {
      const em = String((s as any)?.user_email || '');
      const nm = String((s as any)?.user_name || '').trim();
      if (em && !m.has(em)) m.set(em, nm || em);
    }
    return m;
  }, [validatedShifts, shifts]);

  function getLiveActObj(a: ActRow) {
    return asObj(a.payload_json);
  }

  function getValidatedActObjOriginal(a: any) {
    return asObj(a?.payload_json);
  }

  function getValidatedActObj(a: any) {
    if (a?.id != null && editedActs[Number(a.id)] != null) return editedActs[Number(a.id)];
    return asObj(a?.payload_json);
  }

  function getShiftTotalsObj(shift_id: number) {
    const s = shiftById.get(shift_id);
    if (!s) return {};
    return asObj(s.totals_json);
  }

  function getLocationFromValues(values: any) {
    const v = values || {};
    return String(v.Location ?? v.location ?? v.Heading ?? v.heading ?? v.Area ?? v.area ?? '').trim();
  }

  function getSourceFromValues(values: any) {
    const v = values || {};
    return String(v.Source ?? v.source ?? v.From ?? v.from ?? '').trim();
  }

  function getGroupValue(activity: string, objOrValues: any) {
    const act = String(activity || '').toLowerCase();

    // Accept either a raw `values` object OR the full payload obj (which may have `values` + top-level location/source)
    const values: any =
      objOrValues && typeof objOrValues === 'object' && objOrValues.values && typeof objOrValues.values === 'object'
        ? objOrValues.values
        : objOrValues;

    // Prefer explicit top-level fields if present (these are what the admin edit dropdown updates)
    const top =
      objOrValues && typeof objOrValues === 'object'
        ? act === 'hauling' || act === 'loading'
          ? (objOrValues as any).source
          : (objOrValues as any).location
        : null;

    if (top != null && String(top) !== '') return top;

    // Hauling/Loading group by source instead of location
    if (act === 'hauling' || act === 'loading') {
      return getSourceFromValues(values);
    }
    return getLocationFromValues(values);
  }

  function getActNameFromObj(row: any, obj: any) {
    return String(obj?.activity || row?.activity || '(No Activity)');
  }
  function getSubNameFromObj(row: any, obj: any) {
    return String(obj?.sub || obj?.sub_activity || row?.sub_activity || '(No Sub Activity)');
  }

  const validatedActObjByFullKey = useMemo(() => {
    const m = new Map<string, any>();
    const counts = new Map<string, number>();

    for (const a of validatedActs as any[]) {
      const obj: any = getValidatedActObjOriginal(a) || {};
      const actName = getActNameFromObj(a as any, obj);
      const subName = getSubNameFromObj(a as any, obj);
      const grp = getGroupValue(actName, obj);
      const base = `${String(a?.user_email || '')}|||${String(a?.dn || '')}|||${actName}|||${subName}|||${grp}`;
      const n1 = (counts.get(base) || 0) + 1;
      counts.set(base, n1);
      const full = `${base}|||${n1}`;
      m.set(full, obj);
    }
    return m;
  }, [validatedActs]);

  async function validate() {
    if (!selectedDate) {
      setMsg('Select a date');
      return;
    }
    try {
      await api('/api/site-admin/validate', {
        method: 'POST',
        body: JSON.stringify({ date: selectedDate, site }),
      });
      setMsg('Validated');

      await loadDate(selectedDate);
      const cal = await api(`/api/site-admin/calendar?year=${year}&site=${encodeURIComponent(site)}`);
      const map: Record<string, DayStatus> = {};
      for (const d of cal?.days || []) map[String(d.date)] = (d.status as DayStatus) || 'none';
      setDays(map);
    } catch {
      setMsg('Failed to validate');
    }
  }

  async function saveEdits() {
    if (!selectedDate) {
      setMsg('Select a date');
      return;
    }
    const edits = Object.entries(editedActs).map(([id, payload_json]) => ({
      id: Number(id),
      payload_json,
    }));
    if (!edits.length) {
      setMsg('No edits to save');
      return;
    }
    try {
      await api('/api/site-admin/update-validated', {
        method: 'POST',
        body: JSON.stringify({ date: selectedDate, site, edits }),
      });
      setMsg('Edits saved');

      // Reload to pick up any server-side effects + re-evaluate diffs
      await loadDate(selectedDate);
      const cal = await api(`/api/site-admin/calendar?year=${year}&site=${encodeURIComponent(site)}`);
      const map: Record<string, DayStatus> = {};
      for (const d of cal?.days || []) map[String(d.date)] = (d.status as DayStatus) || 'none';
      setDays(map);
    } catch {
      setMsg('Failed to save edits');
    }
  }

  // --- your existing rest of file continues unchanged ---
  // NOTE: I’m keeping your content exactly as-is; only the TS7006 fix was needed.
  // Paste the remainder of your component below this point from your original file.

  // ------------------------------------------------------------------------
  // ✅ IMPORTANT:
  // Replace your old actKeyBase(...) with the typed one above.
  // Everything else can stay the same.
  // ------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        <Toast />
        {/* ... keep the rest of your JSX exactly as you had it ... */}
      </div>
    </div>
  );
}
