import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Header from '../components/Header';
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
      totals[activity][subActivity]['Distance'] =
        (totals[activity][subActivity]['Distance'] || 0) + dist * trucks;

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
    const v = (obj as any)[k]; // ✅ avoid TS index issues
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
    if (String(s).startsWith('Production')) return ['Stope'];
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

  // Backfilling (Surface + Underground): always "To" a stope.
  if (a === 'Backfilling') {
    if (f === 'To' || f === 'Location') return ['Stope'];
    return ['Stope'];
  }

  return ['Heading', 'Stope', 'Stockpile'];
}

/** ✅ FIX: typed actKeyBase (removes TS7006) */
type ActKeyBaseInput = { dn: string; activity: string; sub_activity: string };

function actKeyBase(act: ActKeyBaseInput, userEmail: string, location: string): string {
  return `${userEmail}|||${act.dn}|||${act.activity}|||${act.sub_activity}|||${location}`;
}


export default function SiteAdminValidate() {
  const isReadonly = false; // safety: local flag used in a few render blocks

  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    function on() { setOnline(true); }
    function off() { setOnline(false); }
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const nav = useNavigate();
  const loc = useLocation();
  const qs = useMemo(() => new URLSearchParams(loc.search), [loc.search]);

  if (!online) {
    return (
      <div>
        <Header />
        <div className="p-6 max-w-xl mx-auto">
          <div className="card">
            <h2 className="text-xl font-semibold mb-2">Validation</h2>
            <div className="text-sm text-[color:var(--muted)]">Connection required. Please connect to the network and try again.</div>
            <div className="mt-4">
              <button className="btn" onClick={() => nav('/SiteAdmin')}>Back</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
  const [holeOpen, setHoleOpen] = useState<Record<string, boolean>>({});
  const [truckOpen, setTruckOpen] = useState<Record<string, boolean>>({});
  const [adminLocRows, setAdminLocRows] = useState<AdminLocationRow[]>([]);
  const [adminEquipRows, setAdminEquipRows] = useState<AdminEquipmentRow[]>([]);

  const [validatedShifts, setValidatedShifts] = useState<any[]>([]);
  const [validatedActs, setValidatedActs] = useState<any[]>([]);
  const [dayStatus, setDayStatus] = useState<DayStatus>('none');
  const [calendarOpen, setCalendarOpen] = useState<boolean>(true);

  // Allow deep-linking back to a specific date (e.g. after adding an activity)
  useEffect(() => {
    const d = String(qs.get('date') || '').trim();
    if (d) setSelectedDate(d);
    const s = String(qs.get('site') || '').trim();
    if (s) setSite(s);
  }, [qs]);

  // Ensure logged in
  useEffect(() => {
    (async () => {
      // Validate access via server truth. This supports:
      //  - users.is_admin (super)
      //  - membership role=admin/validator
      try {
        const me: any = await api('/api/site-admin/me');
        if (me?.ok) return;
      } catch {
        // fall through
      }
      nav('/Home');
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
  }, []); // intentionally once

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
    return String(
      v.Location ??
        v.location ??
        v.To ??
        v.to ??
        v.Heading ??
        v.heading ??
        v.Stope ??
        v.stope ??
        v.Area ??
        v.area ??
        '',
    ).trim();
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
          : act === 'backfilling'
            ? (objOrValues as any).to ?? (objOrValues as any).To
            : (objOrValues as any).location
        : null;

    if (top != null && String(top) !== '') return top;

    // Hauling/Loading group by source instead of location
    if (act === 'hauling' || act === 'loading') return getSourceFromValues(values);
    // Backfilling groups by "To" (which is included in getLocationFromValues as a fallback)
    return getLocationFromValues(values);
  }

  function getActNameFromObj(row: any, obj: any) {
    return String(obj?.activity || row?.activity || '(No Activity)');
  }
  function getSubNameFromObj(row: any, obj: any) {
    const act = String(obj?.activity || row?.activity || '');
    const sub = String(obj?.sub || obj?.sub_activity || row?.sub_activity || '(No Sub Activity)');
    if (act === 'Loading' && sub === 'Production') return 'Production - Conventional';
    return sub;
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
      const nn = (counts.get(base) || 0) + 1;
      counts.set(base, nn);
      const full = `${base}|||${nn}`;
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


async function deleteValidatedActivity(actId: number) {
  if (!selectedDate) return;
  if (!actId) return;
  const ok = window.confirm('Delete this activity from the validated data? This cannot be undone.');
  if (!ok) return;
  try {
    await api('/api/site-admin/validated/delete-activity', {
      method: 'POST',
      body: JSON.stringify({ site, date: selectedDate, id: actId }),
    });
    await loadDate(selectedDate);
    const cal = await api(`/api/site-admin/calendar?year=${year}&site=${encodeURIComponent(site)}`);
    const map: Record<string, DayStatus> = {};
    for (const d of cal?.days || []) map[String(d.date)] = (d.status as DayStatus) || 'none';
    setDays(map);
  } catch {
    setMsg('Failed to delete activity');
  }
}

  const totalRows = useMemo(() => {
    // Build the Shift Totals section from VALIDATED activities (including any local edits).
    const payloadsAll = (validatedActs as any[]).map((a) => getValidatedActObj(a)).filter(Boolean);
    const payloadsDS = (validatedActs as any[])
      .filter((a) => String(a?.dn || '').toUpperCase() === 'DS')
      .map((a) => getValidatedActObj(a))
      .filter(Boolean);
    const payloadsNS = (validatedActs as any[])
      .filter((a) => String(a?.dn || '').toUpperCase() === 'NS')
      .map((a) => getValidatedActObj(a))
      .filter(Boolean);

    const n2 = (v: any) => {
      const num = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
      return Number.isFinite(num) ? num : 0;
    };

    const locOf = (p0: any) => {
      const p: any = p0 || {};
      const v: any = p.values && typeof p.values === 'object' ? p.values : {};
      // Most activities store a single Location, but Firing stores Heading/Stope.
      return String(
        p.location ??
          p.Location ??
          v.Location ??
          v.location ??
          v.Heading ??
          v.heading ??
          v.Stope ??
          v.stope ??
          ''
      ).trim();
    };

    const uniqCount = (vals: string[]) => {
      const s = new Set<string>();
      for (const v of vals) {
        const t = String(v || '').trim();
        if (t) s.add(t);
      }
      return s.size;
    };

    // ---- Haulage (kept as-is, just shown under "Haulage") ----
    function aggHaul(payloads: any[]) {
      const out = {
        oreTrucks: 0,
        oreT: 0,
        wasteTrucks: 0,
        wasteT: 0,
        prodTrucks: 0,
        prodT: 0,
        devOreTrucks: 0,
        devOreT: 0,
        devWasteTrucks: 0,
        devWasteT: 0,
      };
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Hauling') continue;

        const sub = String(p.sub || p.sub_activity || '').toLowerCase();
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};

        
const loads = Array.isArray((p as any).loads) ? (p as any).loads : null;
const trucks = loads ? loads.length : n2(v['No of trucks'] ?? v['No. of trucks'] ?? v['Trucks'] ?? v['No of Trucks']);
const weightPer = n2(v['Weight'] ?? v['weight']); // t/truck (legacy)
const tonnes = loads ? loads.reduce((acc: number, l: any) => acc + n2(l?.weight ?? l?.Weight), 0) : trucks * weightPer;


        let material = String(v['Material'] ?? v.material ?? '').toLowerCase();

        // Production/Development breakdown
        const isProd = sub.includes('production') || sub === 'production';
        const isDev = sub.includes('development') || sub === 'development';

        // Production hauling is always ore (Material dropdown not shown).
        if (!material && isProd) material = 'ore';

        // Ore/Waste totals (by material)
        if (material.includes('ore')) {
          out.oreTrucks += trucks;
          out.oreT += tonnes;
        } else if (material.includes('waste')) {
          out.wasteTrucks += trucks;
          out.wasteT += tonnes;
        }

        if (isProd) {
          out.prodTrucks += trucks;
          out.prodT += tonnes;
        } else if (isDev) {
          if (material.includes('ore')) {
            out.devOreTrucks += trucks;
            out.devOreT += tonnes;
          } else if (material.includes('waste')) {
            out.devWasteTrucks += trucks;
            out.devWasteT += tonnes;
          }
        }
      }
      return out;
    }

    const hds = aggHaul(payloadsDS);
    const hns = aggHaul(payloadsNS);
    const htotal = aggHaul(payloadsAll);

    const fmtTW = (trucks: number, tonnes: number) => `${Math.round(trucks)} (${Math.round(tonnes)})`;

    // ---- Production ----
    function prodDrillm(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Production Drilling') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Stope' && sub !== 'Service Hole') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        sum += n2(v['Metres Drilled']) + n2(v['Cleanouts Drilled']) + n2(v['Redrills']);
      }
      return sum;
    }

    function stopesFired(payloads: any[]) {
      const locs: string[] = [];
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Firing') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Production') continue;
        locs.push(locOf(p));
      }
      return uniqCount(locs);
    }

    function tonnesFired(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Firing') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Production') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        sum += n2(v['Tonnes Fired']);
      }
      return sum;
    }

    // ---- Development ----
    function headingsFired(payloads: any[]) {
      const locs: string[] = [];
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Firing') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Development') continue;
        locs.push(locOf(p));
      }
      return uniqCount(locs);
    }

    function devAdvance(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Firing') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Development') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        sum += n2(v['Cut Length']);
      }
      return sum;
    }

    
    function backfillVolume(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Backfilling') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Surface') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        sum += n2(v['Volume']);
      }
      return sum;
    }

    function backfillBuckets(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Backfilling') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Underground') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        sum += n2(v['Buckets']);
      }
      return sum;
    }

function uniqueLocCountForDevSub(payloads: any[], subWanted: string) {
      const locs: string[] = [];
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Development') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== subWanted) continue;
        locs.push(locOf(p));
      }
      return uniqCount(locs);
    }

    function gsDrillm(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Development') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Ground Support' && sub !== 'Rehab') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        const direct = n2(v['GS Drillm']);
        if (direct > 0) {
          sum += direct;
        } else {
          // Fallback: bolts * bolt length (e.g. "2.4m")
          const bolts = n2(v['No. of Bolts'] ?? v['No of Bolts'] ?? v['No. of bolts'] ?? v['No of bolts']);
          const bl = String(v['Bolt Length'] ?? '').toLowerCase();
          const blNum = n2(bl.replace(/[^0-9.]/g, ''));
          if (bolts > 0 && blNum > 0) sum += bolts * blNum;
        }
      }
      return sum;
    }

    function faceDrillm(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Development') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Face Drilling') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        const direct = n2(v['Face Drillm']);
        if (direct > 0) {
          sum += direct;
        } else {
          const holes = n2(v['No of Holes'] ?? v['No. of Holes']);
          const cut = n2(v['Cut Length']);
          if (holes > 0 && cut > 0) sum += holes * cut;
        }
      }
      return sum;
    }

    function shotcrete(payloads: any[]) {
      let sum = 0;
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Development') continue;
        const sub = String(p.sub || p.sub_activity || '');
        if (sub !== 'Ground Support' && sub !== 'Rehab') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        sum += n2(v['Spray Volume']);
      }
      return sum;
    }

    const rows: any[] = [];

    // ---- Hoisting (always at top) ----
    const hoistSum = (payloads: any[]) => {
      const out = { oreT: 0, wasteT: 0 };
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Hoisting') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        out.oreT += n2(v['Ore Tonnes']);
        out.wasteT += n2(v['Waste Tonnes']);
      }
      return out;
    };
    const hoAll = hoistSum(payloadsAll);
    const hoDS = hoistSum(payloadsDS);
    const hoNS = hoistSum(payloadsNS);

    rows.push(
      { activity: 'Hoisting', sub: 'Ore / Waste', metric: 'Ore', ds: hoDS.oreT, ns: hoNS.oreT, total: hoAll.oreT },
      {
        activity: 'Hoisting',
        sub: 'Ore / Waste',
        metric: 'Waste',
        ds: hoDS.wasteT,
        ns: hoNS.wasteT,
        total: hoAll.wasteT,
      },
    );

    // ---- Haulage (kept as-is) ----
    rows.push(
      {
        activity: 'Haulage',
        sub: 'Ore / Waste',
        metric: 'Ore',
        ds: fmtTW(hds.oreTrucks, hds.oreT),
        ns: fmtTW(hns.oreTrucks, hns.oreT),
        total: fmtTW(htotal.oreTrucks, htotal.oreT),
      },
      {
        activity: 'Haulage',
        sub: 'Ore / Waste',
        metric: 'Waste',
        ds: fmtTW(hds.wasteTrucks, hds.wasteT),
        ns: fmtTW(hns.wasteTrucks, hns.wasteT),
        total: fmtTW(htotal.wasteTrucks, htotal.wasteT),
      },

      {
        activity: 'Haulage',
        sub: 'Production / Development',
        metric: 'Production',
        ds: fmtTW(hds.prodTrucks, hds.prodT),
        ns: fmtTW(hns.prodTrucks, hns.prodT),
        total: fmtTW(htotal.prodTrucks, htotal.prodT),
      },
      {
        activity: 'Haulage',
        sub: 'Production / Development',
        metric: 'Development Ore',
        ds: fmtTW(hds.devOreTrucks, hds.devOreT),
        ns: fmtTW(hns.devOreTrucks, hns.devOreT),
        total: fmtTW(htotal.devOreTrucks, htotal.devOreT),
      },
      {
        activity: 'Haulage',
        sub: 'Production / Development',
        metric: 'Development Waste',
        ds: fmtTW(hds.devWasteTrucks, hds.devWasteT),
        ns: fmtTW(hns.devWasteTrucks, hns.devWasteT),
        total: fmtTW(htotal.devWasteTrucks, htotal.devWasteT),
      },
    );

    // ---- Loading (always shown on left column) ----
    const loadSum = (payloads: any[]) => {
      const out = {
        primStope: 0,
        rehandleStope: 0,
        primDev: 0,
        rehandleDev: 0,
      };
      for (const p0 of payloads || []) {
        const p: any = p0 || {};
        if (String(p.activity || '') !== 'Loading') continue;
        const v: any = p.values && typeof p.values === 'object' ? p.values : {};
        const sub = String(p.sub || p.sub_activity || (p as any).subActivity || '').trim();

        if (sub === 'Production') {
          out.primStope += n2(v['Stope to Truck']) + n2(v['Stope to SP']);
          out.rehandleStope += n2(v['Stope SP to Truck']) + n2(v['Stope SP to SP']);
        } else if (sub === 'Development') {
          out.primDev += n2(v['Heading to Truck']) + n2(v['Heading to SP']);
          out.rehandleDev += n2(v['Dev SP to SP']) + n2(v['Dev SP to Truck']);
        }
      }
      return out;
    };
    const ldAll = loadSum(payloadsAll);
    const ldDS = loadSum(payloadsDS);
    const ldNS = loadSum(payloadsNS);

    rows.push(
      {
        activity: 'Loading',
        sub: 'Production',
        metric: 'Primary stope bogging',
        ds: ldDS.primStope,
        ns: ldNS.primStope,
        total: ldAll.primStope,
      },
      {
        activity: 'Loading',
        sub: 'Production',
        metric: 'Rehandle stope bogging',
        ds: ldDS.rehandleStope,
        ns: ldNS.rehandleStope,
        total: ldAll.rehandleStope,
      },
      {
        activity: 'Loading',
        sub: 'Development',
        metric: 'Primary development bogging',
        ds: ldDS.primDev,
        ns: ldNS.primDev,
        total: ldAll.primDev,
      },
      {
        activity: 'Loading',
        sub: 'Development',
        metric: 'Rehandle development bogging',
        ds: ldDS.rehandleDev,
        ns: ldNS.rehandleDev,
        total: ldAll.rehandleDev,
      },
    );

    // ---- Production ----
    rows.push(
      {
        activity: 'Production',
        sub: '',
        metric: 'Production Drillm',
        ds: prodDrillm(payloadsDS),
        ns: prodDrillm(payloadsNS),
        total: prodDrillm(payloadsAll),
      },
      { activity: 'Production', sub: '', metric: 'Stopes fired', ds: stopesFired(payloadsDS), ns: stopesFired(payloadsNS), total: stopesFired(payloadsAll) },
      { activity: 'Production', sub: '', metric: 'Tonnes fired', ds: tonnesFired(payloadsDS), ns: tonnesFired(payloadsNS), total: tonnesFired(payloadsAll) },
    );

    // ---- Development ----
    const gsAll = gsDrillm(payloadsAll);
    const faceAll = faceDrillm(payloadsAll);
    const gsDS = gsDrillm(payloadsDS);
    const gsNS = gsDrillm(payloadsNS);
    const faceDS = faceDrillm(payloadsDS);
    const faceNS = faceDrillm(payloadsNS);

    rows.push(
      { activity: 'Development', sub: '', metric: 'Headings fired', ds: headingsFired(payloadsDS), ns: headingsFired(payloadsNS), total: headingsFired(payloadsAll) },
      { activity: 'Development', sub: '', metric: 'Development advance', ds: devAdvance(payloadsDS), ns: devAdvance(payloadsNS), total: devAdvance(payloadsAll) },
      { activity: 'Development', sub: '', metric: 'Headings supported', ds: uniqueLocCountForDevSub(payloadsDS, 'Ground Support'), ns: uniqueLocCountForDevSub(payloadsNS, 'Ground Support'), total: uniqueLocCountForDevSub(payloadsAll, 'Ground Support') },
      { activity: 'Development', sub: '', metric: 'Headings rehabbed', ds: uniqueLocCountForDevSub(payloadsDS, 'Rehab'), ns: uniqueLocCountForDevSub(payloadsNS, 'Rehab'), total: uniqueLocCountForDevSub(payloadsAll, 'Rehab') },
      { activity: 'Development', sub: '', metric: 'GS Drillm', ds: gsDS, ns: gsNS, total: gsAll },
      { activity: 'Development', sub: '', metric: 'Face Drillm', ds: faceDS, ns: faceNS, total: faceAll },
      { activity: 'Development', sub: '', metric: 'Total Drillm', ds: gsDS + faceDS, ns: gsNS + faceNS, total: gsAll + faceAll },
      { activity: 'Development', sub: '', metric: 'Shotcrete', ds: shotcrete(payloadsDS), ns: shotcrete(payloadsNS), total: shotcrete(payloadsAll) },
    );

    // ---- Backfilling ----
    rows.push(
      {
        activity: 'Backfilling',
        sub: 'Surface',
        metric: 'Backfill volume',
        ds: backfillVolume(payloadsDS),
        ns: backfillVolume(payloadsNS),
        total: backfillVolume(payloadsAll),
      },
      {
        activity: 'Backfilling',
        sub: 'Underground',
        metric: 'Backfill buckets',
        ds: backfillBuckets(payloadsDS),
        ns: backfillBuckets(payloadsNS),
        total: backfillBuckets(payloadsAll),
      },
    );

    return rows;
  }, [validatedActs, editedActs]);

  const liveActObjByFullKey = useMemo(() => {
    const m = new Map<string, any>();
    const counts = new Map<string, number>();

    for (const a of acts as any[]) {
      const obj: any = getLiveActObj(a as any) || {};
      const actName = getActNameFromObj(a as any, obj);
      const subName = getSubNameFromObj(a as any, obj);
      const grp = getGroupValue(actName, obj);
      const base = `${String((a as any)?.user_email || '')}|||${String((a as any)?.dn || '')}|||${actName}|||${subName}|||${grp}`;
      const nn = (counts.get(base) || 0) + 1;
      counts.set(base, nn);
      const key = `${base}|||${nn}`;
      m.set(key, obj);
    }
    return m;
  }, [acts]);

  const validatedFullKeyById = useMemo(() => {
    const byId = new Map<number, string>();
    const counts = new Map<string, number>();
    for (const a of validatedActs as any[]) {
      const obj: any = getValidatedActObjOriginal(a) || {};
      const actName = getActNameFromObj(a as any, obj);
      const subName = getSubNameFromObj(a as any, obj);
      const grp = getGroupValue(actName, obj);
      const base = `${String((a as any)?.user_email || '')}|||${String((a as any)?.dn || '')}|||${actName}|||${subName}|||${grp}`;
      const nn = (counts.get(base) || 0) + 1;
      counts.set(base, nn);
      const full = `${base}|||${nn}`;
      if (a?.id != null) byId.set(Number(a.id), full);
    }
    return byId;
  }, [validatedActs, editedActs]);

  const liveObjByValidatedId = useMemo(() => {
    // Pair validated rows to live rows (shift_activities) as best-effort.
    // We *always* want the tooltip/baseline to reference the original shift_activities row,
    // even if the validated row's editable fields (eg Location/Source) change.
    //
    // Strategy:
    //  1) Try strict match on (user_email+dn+activity+sub+group/location)
    //  2) Fallback to loose match on (user_email+dn+activity+sub) and pick the next unused row
    //  3) Prefer exact payload match when possible
    const bucketsStrict = new Map<string, { obj: any; used: boolean }[]>();
    const bucketsLoose = new Map<string, { obj: any; used: boolean }[]>();

    function pushBucket(map: Map<string, { obj: any; used: boolean }[]>, key: string, obj: any) {
      const arr = map.get(key) || [];
      arr.push({ obj, used: false });
      map.set(key, arr);
    }

    for (const a of acts as any[]) {
      const obj: any = getLiveActObj(a as any) || {};
      const actName = getActNameFromObj(a as any, obj);
      const subName = getSubNameFromObj(a as any, obj);
      const grp = getGroupValue(actName, obj);
      const em = String((a as any)?.user_email || '');
      const dn = String((a as any)?.dn || '');
      const strictKey = `${em}|||${dn}|||${actName}|||${subName}|||${String(grp ?? '')}`;
      const looseKey = `${em}|||${dn}|||${actName}|||${subName}`;
      pushBucket(bucketsStrict, strictKey, obj);
      pushBucket(bucketsLoose, looseKey, obj);
    }

    const out = new Map<number, any>();

    for (const va of validatedActs as any[]) {
      const vid = Number((va as any)?.id);
      if (!vid) continue;

      // IMPORTANT: use the persisted validated payload_json (not the edited overlay) to find the original live row
      const vObj: any = getValidatedActObjOriginal(va) || {};
      const vActName = getActNameFromObj(va as any, vObj);
      const vSubName = getSubNameFromObj(va as any, vObj);
      const vGrp = getGroupValue(vActName, vObj);

      const em = String((va as any)?.user_email || '');
      const dn = String((va as any)?.dn || '');
      const strictKey = `${em}|||${dn}|||${vActName}|||${vSubName}|||${String(vGrp ?? '')}`;
      const looseKey = `${em}|||${dn}|||${vActName}|||${vSubName}`;

      const vStr = JSON.stringify(vObj || {});

      const tryPick = (arr: { obj: any; used: boolean }[]) => {
        if (!arr || !arr.length) return null;
        let pick = arr.find((x) => !x.used && JSON.stringify(x.obj || {}) === vStr);
        if (!pick) pick = arr.find((x) => !x.used);
        if (pick) pick.used = true;
        return pick ? pick.obj : null;
      };

      let pickObj: any = null;
      pickObj = tryPick(bucketsStrict.get(strictKey) || []);
      if (!pickObj) pickObj = tryPick(bucketsLoose.get(looseKey) || []);

      out.set(vid, pickObj || null);
    }

    return out;
  }, [acts, validatedActs]);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const week = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        <Toast />

        <div className="flex items-center justify-between">
          <div className="font-bold text-lg">Validate Shifts</div>
          <button
            className="btn"
            onClick={() => nav('/siteadmin')}
            type="button"
          >
            Back
          </button>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <div className="font-bold">Calendar</div>
          </div>

          {calendarOpen && (
            <>
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    className="tv-pill"
                    onClick={() => setYear((y) => y - 1)}
                    type="button"
                  >
                    ‹
                  </button>
                  <div className="font-semibold text-lg px-1">{year}</div>
                  <button
                    className="tv-pill"
                    onClick={() => setYear((y) => y + 1)}
                    type="button"
                  >
                    ›
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <div className="text-xs opacity-70">Site</div>
                  <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
                    {sites.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                {Array.from({ length: 12 }).map((_, mi) => {
                  const cells = monthGrid(year, mi);
                  const mm = String(mi + 1).padStart(2, '0');
                  return (
                    <div key={mi} className="tv-tile">
                      <div className="font-bold mb-1">{monthNames[mi]}</div>
                      <div className="grid grid-cols-7 text-[11px] opacity-70 mb-1">
                        {week.map((w) => (
                          <div key={w} className="text-center">
                            {w}
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-7 gap-1">
                        {cells.map((d, idx) => {
                          if (d == null) return <div key={idx} className="h-6" />;
                          const dd = String(d).padStart(2, '0');
                          const dateStr = `${year}-${mm}-${dd}`;
                          const st = days[dateStr] || 'none';
                          const isSel = selectedDate === dateStr;
                          return (
                            <button
                              key={idx}
                              className={`h-6 rounded-md text-[11px] ${dayClass(st)} ${
                                isSel ? 'ring-2 ring-slate-400' : ''
                              }`}
                              onClick={() => loadDate(dateStr)}
                              type="button"
                            >
                              {d}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex gap-4 text-xs mt-3 opacity-70">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-emerald-500" />
                  Validated
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-rose-500" />
                  Unvalidated
                </div>
              </div>

              <div className="flex justify-center mt-2">
                <button
                  className="tv-pill"
                  type="button"
                  onClick={() => setCalendarOpen((o) => !o)}
                  aria-label="Collapse calendar"
                  title="Collapse calendar"
                >
                  −
                </button>
              </div>
            </>
          )}

          {!calendarOpen && (
            <div className="flex justify-center">
              <button
                className="tv-pill"
                type="button"
                onClick={() => setCalendarOpen(true)}
                aria-label="Expand calendar"
                title="Expand calendar"
              >
                +
              </button>
            </div>
          )}
        </div>

        {selectedDate && (
          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <div className="font-bold">{selectedDate}</div>
              <div className="flex items-center gap-2">
                <button
                  className="px-4 py-2 rounded-xl bg-sky-600 text-white shadow-sm hover:bg-sky-700 disabled:opacity-50"
                  onClick={saveEdits}
                  disabled={loadingDay}
                  type="button"
                >
                  Save edits
                </button>
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                  onClick={validate}
                  disabled={loadingDay}
                  type="button"
                >
                  Validate shift
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-[color:var(--card)] border border-[color:var(--hairline)] shadow-sm hover:bg-[color:var(--surface-2)] text-sm"
                  onClick={() => {
                    if (!selectedDate) return;
                    nav(`/SiteAdmin/AddActivity?date=${encodeURIComponent(selectedDate)}&site=${encodeURIComponent(site)}`);
                  }}
                >
                  + Add activity
                </button>
              </div>
            </div>

            {loadingDay ? (
              <div className="p-4 opacity-70">Loading...</div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div>
                    <div className="font-bold mb-2">Shift Totals</div>

                    {totalRows.length ? (
                      <div className="space-y-3">
                        {(() => {
                          // Group into activity blocks (keeps layout familiar)
                          const byAct: Record<string, any[]> = {};
                          for (const r of totalRows as any[]) {
                            const a = String(r.activity || '');
                            if (!byAct[a]) byAct[a] = [];
                            byAct[a].push(r);
                          }

                          const renderTable = (actsList: string[]) => (
                            <div className="overflow-auto">
                              <table className="min-w-full text-sm">
                                <thead>
                                  <tr className="text-xs text-[color:var(--muted)] bg-[color:var(--surface-2)] border-b border-[color:var(--hairline)]">
                                    <th className="text-left p-2 whitespace-nowrap">Metric</th>
                                    <th className="text-right p-2 whitespace-nowrap">DS</th>
                                    <th className="text-right p-2 whitespace-nowrap">NS</th>
                                    <th className="text-right p-2 whitespace-nowrap">24hrs</th>
                                  </tr>
                                </thead>
                                <tbody>
{(() => {
                                    const out: any[] = [];
                                    for (const a of actsList) {
                                      const rows = byAct[a] || [];
                                      if (!rows.length) continue;
                                      let lastS = '__none__';
                                      // activity header
                                      out.push(
                                        <tr key={`act|||${a}`} className="border-b border-[color:var(--hairline)] bg-[color:var(--surface-2)]">
                                          <td className="p-2 font-semibold" colSpan={4}>
                                            {a}
                                          </td>
                                        </tr>,
                                      );
                                      for (const r of rows) {
                                        // sub header (skip blank subs)
                                        if (r.sub && r.sub !== lastS) {
                                          lastS = r.sub;
                                          out.push(
                                            <tr
                                              key={`${a}|||sub|||${r.sub}`}
                                              className="border-b border-[color:var(--hairline)] bg-[color:var(--surface-2)]/60"
                                            >
                                              <td className="p-2 pl-6 font-semibold" colSpan={4}>
                                                {r.sub}
                                              </td>
                                            </tr>,
                                          );
                                        }
                                        out.push(
                                          <tr
                                            key={`${r.activity}|||${r.sub}|||${r.metric}`}
                                            className="border-b last:border-b-0"
                                          >
                                            <td className="p-2 pl-10">{r.metric}</td>
                                            <td className="p-2 text-right whitespace-nowrap">
                                              {typeof r.ds === 'string'
                                                ? r.ds
                                                : Number(r.ds || 0).toLocaleString()}
                                            </td>
                                            <td className="p-2 text-right whitespace-nowrap">
                                              {typeof r.ns === 'string'
                                                ? r.ns
                                                : Number(r.ns || 0).toLocaleString()}
                                            </td>
                                            <td className="p-2 text-right whitespace-nowrap">
                                              {typeof r.total === 'string'
                                                ? r.total
                                                : Number(r.total || 0).toLocaleString()}
                                            </td>
                                          </tr>,
                                        );
                                      }
                                    }
                                    return out;
                                  })()}
                                </tbody>
                              </table>
                            </div>
                          );

                          // Fixed layout:
                          // - Hoisting always at top
                          // - Left column: Haulage, Loading
                          // - Right column: Production, Development
                          return (
                            <>
                              {renderTable(['Hoisting'])}
                              <div className="grid md:grid-cols-2 gap-3">
                                {renderTable(['Haulage', 'Loading', 'Backfilling'])}
                                {renderTable(['Production', 'Development'])}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className="text-sm opacity-70">No totals for this date yet.</div>
                    )}
                  </div>

                  <div className="flex items-center gap-3 mb-2">
                    <div className="font-bold">Activities</div>

                    <div className="text-xs opacity-80 flex items-center gap-2">
                      <span className="inline-block w-4 h-3 rounded-sm bg-amber-50/40 border border-black/10 relative overflow-hidden">
                        <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-amber-400/70" />
                      </span>
                      <span>Edited (changed from finalized)</span>
                    </div>
                  </div>

                  {(() => {
                    // Grouping: Activity -> Sub Activity -> Location/Source
                    const byAct: Record<string, any[]> = {};
                    for (const a of validatedActs as any[]) {
                      const obj: any = getValidatedActObjOriginal(a) || {};
                      const activityName = String(obj?.activity || a?.activity || '(No Activity)');
                      (byAct[activityName] ||= []).push(a);
                    }

                    const desiredOrder = ['Hoisting', 'Hauling', 'Loading', 'Backfilling', 'Development', 'Production Drilling', 'Charging', 'Firing'];
                    const rank = (name: string) => {
                      const i = desiredOrder.indexOf(name);
                      return i === -1 ? 999 : i;
                    };
                    const actNames = Object.keys(byAct).sort((a, b) => {
                      const ra = rank(a);
                      const rb = rank(b);
                      if (ra !== rb) return ra - rb;
                      return a.localeCompare(b);
                    });
                    if (!actNames.length) return <div className="text-sm opacity-70">No activities for this date.</div>;

                    return (
                      <div className="space-y-4">
                        {actNames.map((actName) => {
                          const rowsForAct = byAct[actName] || [];

                          const actLc = String(actName || '').toLowerCase();
                          // Grouping column differs by activity:
                          // - Hauling/Loading: Source
                          // - Backfilling: To
                          // - Others (default): Location
                          const groupKey =
                            actLc === 'hoisting'
                              ? ''
                              : actLc === 'hauling' || actLc === 'loading'
                                ? 'Source'
                                : actLc === 'backfilling'
                                  ? 'To'
                                  : 'Location';

                          // Columns: union across the whole ACTIVITY so headers don't repeat
                          const colSet = new Set<string>();
                          for (const r of rowsForAct) {
                            const objOrig: any = getValidatedActObjOriginal(r) || {};
                            const obj: any = getValidatedActObj(r) || objOrig || {};
                              const values: any = obj?.values && typeof obj.values === 'object' ? obj.values : {};
                            Object.keys(values || {}).forEach((k) => {
                              const kl = String(k).toLowerCase();
                                // Do not repeat grouping keys as normal columns.
                                if (kl === 'location' || kl === 'source' || kl === 'from' || kl === 'to') return;
                              colSet.add(k);
                            });
                          }

                          const prio = (k: string) => {
                            const kl = String(k || '').toLowerCase();
                            if (kl === 'equipment') return 0;
                            if (kl === 'from') return 1;
                            if (kl === 'to') return 2;
                            if (kl === 'material') return 3;
                            return 100;
                          };
  const colsAll = Array.from(colSet).sort((a, b) => {
                            const pa = prio(a);
                            const pb = prio(b);
                            if (pa !== pb) return pa - pb;
                            return a.localeCompare(b);
                          });

                          // Hauling: hide raw Weight column (tonnes hauled is derived from individual trucks)
                          const cols = actLc === 'hauling'
                            ? colsAll.filter((k) => {
                                const kl = String(k || '').toLowerCase();
                                return kl !== 'weight' && kl !== 'total weight';
                              })
                            : colsAll;               // Build Sub -> GroupValue -> rows structure
                          const bySub: Record<string, Record<string, any[]>> = {};
                          for (const r of rowsForAct) {
                            const objOrig: any = getValidatedActObjOriginal(r) || {};
                            const objCur: any = getValidatedActObj(r) || objOrig || {};
                            const values: any = objCur?.values && typeof objCur.values === 'object' ? objCur.values : {};
                            const sub = getSubNameFromObj(r as any, objCur);
                            const grp = String(getGroupValue(actName, values) || '');
                            (bySub[sub] ||= {});
                            (bySub[sub][grp] ||= []).push(r);
                          }

                          const subNames = Object.keys(bySub).sort((a, b) => a.localeCompare(b));
                          const colSpan = 2 + (groupKey ? 1 : 0) + cols.length + 1;


                          return (
                            <div key={actName} className="card">
                              <div className="font-bold mb-2">{actName}</div>

                              <div className="overflow-auto">
                                <table className="min-w-[900px] w-full text-sm">
                                  <thead>
                                    <tr className="border-b border-[color:var(--hairline)]">
                                      <th className="p-2 text-left">User</th>
                                      <th className="p-2 text-left">Shift</th>
                                      {groupKey ? <th className="p-2 text-left">{groupKey}</th> : null}
                                      {cols.map((c) => (
                                        <th key={c} className="p-2 text-left whitespace-nowrap">
                                          {c}
                                        </th>
                                      ))}
                                      <th className="p-2 text-right whitespace-nowrap">Actions</th>
                                    </tr>
                                  </thead>

                                  <tbody>
                                    {subNames.map((sub) => {
                                      const locMap = bySub[sub] || {};
                                      const locNames = Object.keys(locMap).sort((a, b) => a.localeCompare(b));
                                      return (
                                        <Fragment key={sub}>
                                          {sub ? (
                                            <tr className="bg-[color:var(--surface-2)] border-b border-[color:var(--hairline)]">
                                              <td className="p-2 font-bold" colSpan={colSpan}>
                                                {sub}
                                              </td>
                                            </tr>
                                          ) : null}

                                          {locNames.map((loc) => {
                                            const rows = locMap[loc] || [];
                                            return (
                                              <Fragment key={`${sub}|||${loc}`}>
                                                {groupKey && loc ? (
                                                  <tr className="border-b border-[color:var(--hairline)]">
                                                    <td className="p-2 pl-4 font-semibold text-sm" colSpan={colSpan}>
                                                      <div className="flex items-center justify-between gap-2">
                                                        <span>{loc}</span>
                                                        {actName === 'Production Drilling' ? (
                                                          <button
                                                            type="button"
                                                            className="btn btn-xs"
                                                            onClick={() => {
                                                              const k = `${actName}|||${sub}|||${loc}`;
                                                              setHoleOpen((prev) => ({ ...prev, [k]: !prev[k] }));
                                                            }}
                                                          >
                                                            {holeOpen[`${actName}|||${sub}|||${loc}`] ? 'Hide holes' : 'Show holes'}
                                                          </button>
                                                        ) : null}

                                                        {actName === 'Hauling' ? (
                                                          <button
                                                            type="button"
                                                            className="btn btn-xs"
                                                            onClick={() => {
                                                              const k = `${actName}|||${sub}|||${loc}`;
                                                              setTruckOpen((prev) => ({ ...prev, [k]: !prev[k] }));
                                                            }}
                                                          >
                                                            {truckOpen[`${actName}|||${sub}|||${loc}`] ? 'Hide trucks' : 'Show trucks'}
                                                          </button>
                                                        ) : null}
                                                      </div>
                                                    </td>
                                                  </tr>
                                                ) : null}

                                                {actName === 'Hauling' && truckOpen[`${actName}|||${sub}|||${loc}`] ? (
                                                  <tr className="border-b border-[color:var(--hairline)] bg-[color:var(--surface-2)]/50">
                                                    <td className="p-2 pl-6" colSpan={colSpan}>
                                                      {(() => {
                                                        const flat: any[] = [];
                                                        for (const rr of rows) {
                                                          const objOrig: any = getValidatedActObjOriginal(rr) || {};
                                                          const objCur: any = getValidatedActObj(rr) || objOrig || {};
                                                          const loads: any[] = Array.isArray((objCur as any)?.loads)
                                                            ? (objCur as any).loads
                                                            : Array.isArray((objOrig as any)?.loads)
                                                              ? (objOrig as any).loads
                                                              : [];
                                                          loads.forEach((l: any, idx: number) =>
                                                            flat.push({ _act_id: (rr as any).id, _idx: idx, weight: l?.weight ?? l?.Weight ?? '' }),
                                                          );
                                                        }

                                                        const recalc = (baseLoads: any[], baseValues: any) => {
                                                          const tonnes = baseLoads.reduce(
                                                            (acc: number, l: any) => acc + (parseFloat(String(l?.weight ?? l?.Weight ?? 0)) || 0),
                                                            0,
                                                          );
                                                          return { ...baseValues, Trucks: baseLoads.length, ['Tonnes Hauled']: tonnes };
                                                        };

                                                        const setTruck = (actId: number, idx: number, weight: any) => {
                                                          setEditedActs((prev) => {
                                                            const rr = rows.find((x: any) => Number((x as any).id) === actId) || rows[0];
                                                            const objOrig: any = rr ? (getValidatedActObjOriginal(rr) || {}) : {};
                                                            const objCurAny: any = rr ? (getValidatedActObj(rr) || objOrig || {}) : objOrig || {};
                                                            const baseAny = prev[actId] || objCurAny || objOrig || {};
                                                            const base: any = typeof baseAny === 'string' ? JSON.parse(baseAny) : baseAny;
                                                            const baseLoads: any[] = Array.isArray((base as any).loads) ? [...(base as any).loads] : [];
                                                            while (baseLoads.length <= idx) baseLoads.push({ weight: '' });
                                                            baseLoads[idx] = { ...(baseLoads[idx] || {}), weight };
                                                            const baseValues =
                                                              (base as any).values && typeof (base as any).values === 'object' ? { ...(base as any).values } : {};
                                                            const values = recalc(baseLoads, baseValues);
                                                            return { ...prev, [actId]: { ...base, loads: baseLoads, values } };
                                                          });
                                                        };

                                                        const deleteTruck = (actId: number, idx: number) => {
                                                          setEditedActs((prev) => {
                                                            const rr = rows.find((x: any) => Number((x as any).id) === actId) || rows[0];
                                                            const objOrig: any = rr ? (getValidatedActObjOriginal(rr) || {}) : {};
                                                            const objCurAny: any = rr ? (getValidatedActObj(rr) || objOrig || {}) : objOrig || {};
                                                            const baseAny = prev[actId] || objCurAny || objOrig || {};
                                                            const base: any = typeof baseAny === 'string' ? JSON.parse(baseAny) : baseAny;
                                                            const baseLoads: any[] = Array.isArray((base as any).loads) ? [...(base as any).loads] : [];
                                                            baseLoads.splice(idx, 1);
                                                            const baseValues =
                                                              (base as any).values && typeof (base as any).values === 'object' ? { ...(base as any).values } : {};
                                                            const values = recalc(baseLoads, baseValues);
                                                            return { ...prev, [actId]: { ...base, loads: baseLoads, values } };
                                                          });
                                                        };

                                                        const addTruck = () => {
                                                          const first = flat[0] as any;
                                                          const actId = Number(first?._act_id || (rows?.[0] as any)?.id || 0);
                                                          if (!actId) return;
                                                          const rr = rows.find((x: any) => Number((x as any).id) === actId) || rows[0];
                                                          const objOrig: any = rr ? (getValidatedActObjOriginal(rr) || {}) : {};
                                                          const objCurAny: any = rr ? (getValidatedActObj(rr) || objOrig || {}) : objOrig || {};

                                                          setEditedActs((prev) => {
                                                            const baseAny = prev[actId] || objCurAny || objOrig || {};
                                                            const base: any = typeof baseAny === 'string' ? JSON.parse(baseAny) : baseAny;
                                                            const baseLoads: any[] = Array.isArray((base as any).loads) ? [...(base as any).loads] : [];
                                                            baseLoads.push({ weight: '' });
                                                            const baseValues =
                                                              (base as any).values && typeof (base as any).values === 'object' ? { ...(base as any).values } : {};
                                                            const values = recalc(baseLoads, baseValues);
                                                            return { ...prev, [actId]: { ...base, loads: baseLoads, values } };
                                                          });
                                                        };

                                                        return (
                                                          <div className="overflow-auto border rounded-xl bg-[color:var(--card)]">
                                                            <table className="w-full text-xs table-fixed">
                                                              <thead className="bg-[color:var(--surface-2)] border-b">
                                                                <tr>
                                                                  <th className="p-1 text-left w-[72px]">Truck #</th>
                                                                  <th className="p-1 text-left w-[140px]">Weight (t)</th>
                                                                  <th className="p-1 text-left w-[36px]"></th>
                                                                </tr>
                                                              </thead>
                                                              <tbody>
                                                                {flat.length === 0 ? (
                                                                  <tr>
                                                                    <td className="p-2 text-xs opacity-70" colSpan={4}>
                                                                      No truck weights found on these rows.
                                                                    </td>
                                                                  </tr>
                                                                ) : (
                                                                  flat.map((t, ii) => {
                                                                    const actId = Number(t._act_id || 0);
                                                                    const idx = Number(t._idx || 0);
                                                                    return (
                                                                      <tr key={`${actId}|||${idx}|||${ii}`} className="border-b last:border-b-0">
<td className="p-1">{idx + 1}</td>
                                                                        <td className="p-1">
                                                                          <input
                                                                            className="input w-full"
                                                                            value={String(t.weight ?? '')}
                                                                            onChange={(e) => setTruck(actId, idx, e.target.value)}
                                                                          />
                                                                        </td>
                                                                    <td className="p-1 text-xs opacity-80">
                                                                      {(() => {
                                                                        const ts: any = (t as any).time_s;
                                                                        const s = typeof ts === 'number' ? ts : parseFloat(String(ts || ''));
                                                                        if (!Number.isFinite(s)) return <span className="opacity-50">—</span>;
                                                                        const mm = String(Math.floor(s / 60)).padStart(2, '0');
                                                                        const ss = String(Math.round(s % 60)).padStart(2, '0');
                                                                        return `${mm}:${ss}`;
                                                                      })()}
                                                                    </td>
                                                                        <td className="p-1">
                                                                          <button
                                                                            type="button"
                                                                            aria-label="Delete truck"
                                                                            title="Delete truck"
                                                                            className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                                                                            onClick={() => deleteTruck(actId, idx)}
                                                                          >
                                                                            ✕
                                                                          </button>
                                                                        </td>
                                                                      </tr>
                                                                    );
                                                                  })
                                                                )}
                                                              </tbody>
                                                            </table>
                                                            <div className="p-2 border-t bg-[color:var(--surface-2)] flex items-center justify-between gap-2">
                                                              <button
                                                                type="button"
                                                                className="tv-pill text-xs"
                                                                onClick={addTruck}
                                                              >
                                                                + Add truck
                                                              </button>
                                                              <div className="text-xs opacity-70">Edit trucks (totals auto-calc).</div>
                                                            </div>
                                                          </div>
                                                        );
                                                      })()}
                                                    </td>
                                                  </tr>
                                                ) : null}

                                                
                                                {actName === 'Production Drilling' && holeOpen[`${actName}|||${sub}|||${loc}`] ? (
                                                  <tr className="border-b border-[color:var(--hairline)] bg-[color:var(--surface-2)]/50">
                                                    <td className="p-2 pl-6" colSpan={colSpan}>
                                                      {(() => {
                                                        const flat: any[] = [];
                                                        for (const rr of rows) {
                                                          const objOrig: any = getValidatedActObjOriginal(rr) || {};
                                                          const objCur: any = getValidatedActObj(rr) || objOrig || {};
                                                          const holes: any = (objCur as any)?.holes || (objOrig as any)?.holes || null;
                                                          if (!holes) continue;
                                                          for (const bucket of ['Metres Drilled', 'Cleanouts Drilled', 'Redrills']) {
                                                            const arr = Array.isArray(holes[bucket]) ? holes[bucket] : [];
                                                            arr.forEach((h: any, _idx: number) => flat.push({ _act_id: (rr as any).id, _idx, bucket, ...h }));
                                                          }
                                                        }
                                                        const flatEmpty = (flat.length === 0);
                                                        return (
                                                          <div className="overflow-auto border rounded-xl bg-[color:var(--card)]">
                                                            <table className="w-full text-xs table-fixed">
  <thead className="bg-[color:var(--surface-2)] border-b">
    <tr>
      <th className="p-1 text-left w-[92px]">Bucket</th>
      <th className="p-1 text-left w-[72px]">Ring ID</th>
      <th className="p-1 text-left w-[72px]">Hole ID</th>
      <th className="p-1 text-left w-[92px]">Diameter</th>
      <th className="p-1 text-left w-[92px]">Length (m)</th>
      <th className="p-1 text-left w-[36px]"></th>
    </tr>
  </thead>
  <tbody>
    {flat.map((h, ii) => {
      const actId = Number((h as any)._act_id || 0);
      const bucket = String((h as any).bucket || 'Metres Drilled');
      const idx = Number((h as any)._idx || 0);
      const HOLE_DIAMETER_OPTIONS = ['64mm','76mm','89mm','102mm','152mm','203mm','254mm','other'] as const;

      const rr = rows.find((x: any) => Number((x as any).id) === actId) || rows[0];
      const objOrig: any = rr ? (getValidatedActObjOriginal(rr) || {}) : {};
      const objCurAny: any = rr ? (getValidatedActObj(rr) || objOrig || {}) : (objOrig || {});
      const objCur: any = typeof objCurAny === 'string' ? JSON.parse(objCurAny) : objCurAny;

      const holes: any = (objCur as any)?.holes && typeof (objCur as any).holes === 'object' ? (objCur as any).holes : {};
      const arr = Array.isArray(holes[bucket]) ? holes[bucket] : [];
      const cur = arr[idx] || {};

      const recalcTotals = (newHoles: any, baseValues: any) => {
        const sumLen = (a: any[]) => (a || []).reduce((acc, hh) => acc + Number(String(hh?.length_m || '').replace(/[^0-9.]/g, '') || 0), 0);
        const m = sumLen(Array.isArray(newHoles['Metres Drilled']) ? newHoles['Metres Drilled'] : []);
        const c = sumLen(Array.isArray(newHoles['Cleanouts Drilled']) ? newHoles['Cleanouts Drilled'] : []);
        const r = sumLen(Array.isArray(newHoles['Redrills']) ? newHoles['Redrills'] : []);
        return { ...baseValues, ['Metres Drilled']: m || '', ['Cleanouts Drilled']: c || '', ['Redrills']: r || '' };
      };

      const setHole = (patch: any) => {
        setEditedActs((prev) => {
          const baseAny = prev[actId] || objCur || objOrig || {};
          const base: any = typeof baseAny === 'string' ? JSON.parse(baseAny) : baseAny;
          const baseHoles: any = (base as any).holes && typeof (base as any).holes === 'object' ? (base as any).holes : {};
          const newHoles: any = { ...baseHoles };
          const nextArr = Array.isArray(newHoles[bucket]) ? [...newHoles[bucket]] : [];
          nextArr[idx] = { ...(nextArr[idx] || {}), ...patch };
          newHoles[bucket] = nextArr;
          const baseValues = (base as any).values && typeof (base as any).values === 'object' ? { ...(base as any).values } : {};
          const values = recalcTotals(newHoles, baseValues);
          return { ...prev, [actId]: { ...base, holes: newHoles, values } };
        });
      };

      const moveBucket = (nextBucket: string) => {
        if (!nextBucket || nextBucket === bucket) return;
        setEditedActs((prev) => {
          const baseAny = prev[actId] || objCur || objOrig || {};
          const base: any = typeof baseAny === 'string' ? JSON.parse(baseAny) : baseAny;
          const baseHoles: any = (base as any).holes && typeof (base as any).holes === 'object' ? (base as any).holes : {};
          const newHoles: any = { ...baseHoles };
          const fromArr = Array.isArray(newHoles[bucket]) ? [...newHoles[bucket]] : [];
          const item = fromArr[idx] || {};
          fromArr.splice(idx, 1);
          newHoles[bucket] = fromArr;
          const toArr = Array.isArray(newHoles[nextBucket]) ? [...newHoles[nextBucket]] : [];
          toArr.push(item);
          newHoles[nextBucket] = toArr;
          const baseValues = (base as any).values && typeof (base as any).values === 'object' ? { ...(base as any).values } : {};
          const values = recalcTotals(newHoles, baseValues);
          return { ...prev, [actId]: { ...base, holes: newHoles, values } };
        });
      };

      const deleteHole = () => {
        setEditedActs((prev) => {
          const baseAny = prev[actId] || objCur || objOrig || {};
          const base: any = typeof baseAny === 'string' ? JSON.parse(baseAny) : baseAny;
          const baseHoles: any = (base as any).holes && typeof (base as any).holes === 'object' ? (base as any).holes : {};
          const newHoles: any = { ...baseHoles };
          const nextArr = Array.isArray(newHoles[bucket]) ? [...newHoles[bucket]] : [];
          nextArr.splice(idx, 1);
          newHoles[bucket] = nextArr;
          const baseValues = (base as any).values && typeof (base as any).values === 'object' ? { ...(base as any).values } : {};
          const values = recalcTotals(newHoles, baseValues);
          return { ...prev, [actId]: { ...base, holes: newHoles, values } };
        });
      };

      return (
        <tr key={ii} className="border-b last:border-b-0">
          <td className="p-1">
            <select className="input w-full" value={bucket} onChange={(e) => moveBucket(e.target.value)}>
              {['Metres Drilled','Cleanouts Drilled','Redrills'].map((b) => (<option key={b} value={b}>{b}</option>))}
            </select>
          </td>
          <td className="p-1">
            <input className="input w-full" value={String(cur.ring_id || '')} onChange={(e) => setHole({ ring_id: e.target.value })} />
          </td>
          <td className="p-1">
            <input className="input w-full" value={String(cur.hole_id || '')} onChange={(e) => setHole({ hole_id: e.target.value })} />
          </td>
          <td className="p-1">
            <select className="input w-full" value={String(cur.diameter || '102mm')} onChange={(e) => setHole({ diameter: e.target.value, diameter_other: e.target.value === 'other' ? (cur.diameter_other || '') : '' })}>
              {HOLE_DIAMETER_OPTIONS.map((d) => (<option key={d} value={d}>{d}</option>))}
            </select>
            {String(cur.diameter || '') === 'other' ? (
              <input className="input w-full mt-1" placeholder="e.g. 115mm" value={String(cur.diameter_other || '')} onChange={(e) => setHole({ diameter_other: e.target.value })} />
            ) : null}
          </td>
          <td className="p-1">
            <input className="input w-full" value={String(cur.length_m || '')} onChange={(e) => setHole({ length_m: e.target.value })} />
          </td>
          <td className="p-1">
            <button type="button" aria-label="Delete hole" title="Delete hole" className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50" onClick={deleteHole}>✕</button>
          </td>
        </tr>
      );
    })}
  </tbody>
</table>
    <div className="p-2 border-t bg-[color:var(--surface-2)] flex items-center justify-between gap-2">
      <button
        type="button"
        className="tv-pill text-xs"
        onClick={() => {
          const first = flat[0] as any;
          const actId = Number((first?._act_id) || (rows?.[0]?.id) || 0);
          if (!actId) return;
          const defaultBucket = 'Metres Drilled';
          const rr = rows.find((x: any) => Number((x as any).id) === actId) || rows[0];
          const objOrig: any = rr ? (getValidatedActObjOriginal(rr) || {}) : {};
          const objCurAny: any = rr ? (getValidatedActObj(rr) || objOrig || {}) : (objOrig || {});
          const objCur: any = typeof objCurAny === 'string' ? JSON.parse(objCurAny) : objCurAny;
          const recalcTotals = (newHoles: any, baseValues: any) => {
            const sumLen = (a: any[]) => (a || []).reduce((acc, hh) => acc + Number(String(hh?.length_m || '').replace(/[^0-9.]/g, '') || 0), 0);
            const m = sumLen(Array.isArray(newHoles['Metres Drilled']) ? newHoles['Metres Drilled'] : []);
            const c = sumLen(Array.isArray(newHoles['Cleanouts Drilled']) ? newHoles['Cleanouts Drilled'] : []);
            const r = sumLen(Array.isArray(newHoles['Redrills']) ? newHoles['Redrills'] : []);
            return { ...baseValues, ['Metres Drilled']: m || '', ['Cleanouts Drilled']: c || '', ['Redrills']: r || '' };
          };

          setEditedActs((prev) => {
            const baseAny = prev[actId] || objCur || objOrig || {};
            const base: any = typeof baseAny === 'string' ? JSON.parse(baseAny) : baseAny;
            const baseHoles: any = (base as any).holes && typeof (base as any).holes === 'object' ? (base as any).holes : {};
            const newHoles: any = { ...baseHoles };
            const arr = Array.isArray(newHoles[defaultBucket]) ? [...newHoles[defaultBucket]] : [];
            arr.push({ ring_id: '', hole_id: '', diameter: '102mm', diameter_other: '', length_m: '' });
            newHoles[defaultBucket] = arr;
            const baseValues = (base as any).values && typeof (base as any).values === 'object' ? { ...(base as any).values } : {};
            const values = recalcTotals(newHoles, baseValues);
            return { ...prev, [actId]: { ...base, holes: newHoles, values } };
          });
        }}
      >
        + Add hole
      </button>
      <div className="text-xs opacity-70">Edit holes (totals auto-calc).</div>
    </div>
                                                          </div>
                                                        );
                                                      })()}
                                                    </td>
                                                  </tr>
                                                ) : null}

{rows.map((r) => {
                                                  const userLabel =
                                                    nameByEmail.get(String((r as any)?.user_email || '')) || 'User';

                                                  const originalObj: any = getValidatedActObjOriginal(r) || {};
                                                  const currentObj: any = getValidatedActObj(r) || originalObj || {};
                                                  const originalValues: any =
                                                    originalObj?.values && typeof originalObj.values === 'object' ? originalObj.values : {};
                                                  const currentValues: any =
                                                    currentObj?.values && typeof currentObj.values === 'object' ? currentObj.values : {};

                                                  const originalGrp = String(getGroupValue(actName, originalObj) || '');
                                                  const currentGrp = String(getGroupValue(actName, currentObj) || '');

                                                  // Pair validated rows to "live" rows (acts) for tooltip & baseline comparisons
                                                  const liveObj: any = liveObjByValidatedId.get(Number((r as any)?.id)) || null;
                                                  const liveValues: any = liveObj?.values && typeof liveObj.values === 'object' ? liveObj.values : {};
                                                  const liveGrp = liveObj ? String(getGroupValue(actName, liveObj) || '') : '';

                                                  const baselineGrp = liveObj ? liveGrp : originalGrp;
                                                  const diffGroup = String(currentGrp ?? '') !== String(baselineGrp ?? '');

                                                  return (
                                                    <tr key={(r as any)?.id} className="border-b border-[color:var(--hairline)]">
                                                      <td className="p-2 whitespace-nowrap">{userLabel}</td>
                                                      <td className="p-2 whitespace-nowrap">{(r as any)?.dn}</td>

                                                      {groupKey ? (
                                                        <td className={`p-2 min-w-[220px] ${changedCellTdClass(diffGroup)}`}>
                                                          <ChangedBadge show={diffGroup} />
                                                          {(() => {
                                                            const allowed = new Set(allowedLocationTypes(actName, sub, groupKey));
                                                            const opts = (adminLocRows || [])
                                                              .filter((l) => allowed.has((l as any).type))
                                                              .map((l) => String((l as any).name || '').trim())
                                                              .filter(Boolean)
                                                              .sort((a, b) => a.localeCompare(b));

                                                            const selVal = currentGrp || '';
                                                            return (
                                                              <div>
                                                                <select
                                                                  className="input w-full"
                                                                  title={`Edited: ${currentGrp || ""} | Original: ${String(baselineGrp || "")}`}
                                                                  value={selVal}
                                                                  disabled={isReadonly}
                      onChange={(e) => {
                                                                    const v = e.target.value;
                                                                    setEditedActs((prev) => ({
                                                                      ...prev,
                                                                      [Number((r as any)?.id)]: setValuesKey(currentObj, groupKey, v),
                                                                    }));
                                                                  }}
                                                                >
                                                                  <option value="">-</option>
                                                                  {opts.map((nm) => (
                                                                    <option key={nm} value={nm}>
                                                                      {nm}
                                                                    </option>
                                                                  ))}
                                                                </select>
                                                              </div>
                                                            );
                                                          })()}
                                                        </td>
                                                      ) : null}

                                                      {cols.map((c) => {
                                                        const hasLive = !!liveObj && Object.prototype.hasOwnProperty.call(liveValues, c);
                                                        const liveVal = hasLive ? (liveValues as any)?.[c] : undefined;
                                                        const originalVal = (originalValues as any)?.[c];
                                                        const curVal = (currentValues as any)?.[c];
                                                        const baselineVal = hasLive ? liveVal : originalVal;

                                                        // numeric-aware compare (difference vs ORIGINAL finalized data)
                                                        let diff = false;
                                                        const an = parseFloat(String(baselineVal ?? ''));
                                                        const bn = parseFloat(String(curVal ?? ''));
                                                        if (Number.isFinite(an) && Number.isFinite(bn)) diff = Math.abs(an - bn) > 1e-9;
                                                        else diff = String(baselineVal ?? '') !== String(curVal ?? '');

                                                        const applicable =
                                                          Object.prototype.hasOwnProperty.call(originalValues || {}, c) ||
                                                          Object.prototype.hasOwnProperty.call(currentValues || {}, c) ||
                                                          (hasLive && Object.prototype.hasOwnProperty.call(liveValues || {}, c));

                                                        return (
                                                          <td
                                                            key={c}
                                                            className={`p-2 min-w-[140px] ${
                                                              !applicable ? 'bg-slate-100 opacity-60' : changedCellTdClass(diff)
                                                            }`}
                                                          >
                                                            <ChangedBadge show={!!applicable && diff} />
                                                            {(() => {
                                                              const cn = String(c || '');
                                                              const cur = (currentValues as any)?.[c];

                                                              if (!applicable) {
                                                                return <span className="text-xs">—</span>;
                                                              }

                                                              // Strict dropdowns for admin-managed fields
                                                              if (cn === 'Equipment') {
                                                                const allowedTypes = new Set(allowedEquipmentTypes(actName, sub));
                                                                const optsEq = (adminEquipRows || [])
                                                                  .filter(
                                                                    (e: any) =>
                                                                      allowedTypes.size === 0 || allowedTypes.has(String(e.type || '')),
                                                                  )
                                                                  .map((e: any) => String(e.equipment_id || '').trim())
                                                                  .filter(Boolean)
                                                                  .sort((a: string, b: string) => a.localeCompare(b));
                                                                const inList = optsEq.includes(String(cur || ''));
                                                                return (
                                                                  <select
                                                                    // NOTE: In this Backfilling (Volume/Buckets) branch, `c` is narrowed to
                                                                    // "Volume" | "Buckets"; keep readonly styling based on `isReadonly` only.
                                                                    className={`input w-full ${isReadonly ? "bg-[color:var(--surface-2)] text-slate-700 cursor-default" : ""}`}
                                                                    title={`Validated: ${String(curVal ?? '')} | Original: ${String(
                                                                      (hasLive ? liveVal : baselineVal) ?? '',
                                                                    )}`}
                                                                    value={String(cur || '')}
                                                                    disabled={isReadonly || ((c === 'Metres Drilled' || c === 'Cleanouts Drilled' || c === 'Redrills'))}
                      onChange={(e) => {
                                                                      const v = e.target.value;
                                                                      setEditedActs((prev) => ({
                                                                        ...prev,
                                                                        [Number((r as any)?.id)]: setValuesKey(currentObj, c, v),
                                                                      }));
                                                                    }}
                                                                  >
                                                                    <option value="">-</option>
                                                                    {!inList && cur ? (
                                                                      <option value={String(cur)} disabled>
                                                                        {String(cur)} (legacy)
                                                                      </option>
                                                                    ) : null}
                                                                    {optsEq.map((nm: string) => (
                                                                      <option key={nm} value={nm}>
                                                                        {nm}
                                                                      </option>
                                                                    ))}
                                                                  </select>
                                                                );
                                                              }

                                                              if (cn === 'From' || cn === 'To') {
                                                                const allowed = new Set(allowedLocationTypes(actName, sub, cn));
                                                                const optsLoc = (adminLocRows || [])
                                                                  .filter((l: any) => allowed.has(String(l.type || '')))
                                                                  .map((l: any) => String(l.name || '').trim())
                                                                  .filter(Boolean)
                                                                  .sort((a: string, b: string) => a.localeCompare(b));
                                                                const inList = optsLoc.includes(String(cur || ''));
                                                                return (
                                                                  <select
                                                                    className={`input w-full ${isReadonly ? "bg-[color:var(--surface-2)] text-slate-700 cursor-default" : ""}`}
                                                                    title={`Validated: ${String(curVal ?? '')} | Original: ${String(
                                                                      (hasLive ? liveVal : baselineVal) ?? '',
                                                                    )}`}
                                                                    value={String(cur || '')}
                disabled={isReadonly || (actName === "Production Drilling" && (String(c) === "Metres Drilled" || String(c) === "Cleanouts Drilled" || String(c) === "Redrills"))}
                      onChange={(e) => {
                                                                      const v = e.target.value;
                                                                      setEditedActs((prev) => ({
                                                                        ...prev,
                                                                        [Number((r as any)?.id)]: setValuesKey(currentObj, c, v),
                                                                      }));
                                                                    }}
                                                                  >
                                                                    <option value="">-</option>
                                                                    {!inList && cur ? (
                                                                      <option value={String(cur)} disabled>
                                                                        {String(cur)} (legacy)
                                                                      </option>
                                                                    ) : null}
                                                                    {optsLoc.map((nm: string) => (
                                                                      <option key={nm} value={nm}>
                                                                        {nm}
                                                                      </option>
                                                                    ))}
                                                                  </select>
                                                                );
                                                              }

                                                              if (cn === 'Material') {
                                                                // Production hauling is always ore and should not be selectable.
                                                                const rowSub = String(getSubNameFromObj(r as any, currentObj) || '').toLowerCase();
                                                                if (String(actName || '').toLowerCase() === 'hauling' && rowSub === 'production') {
                                                                  return <div className="input bg-[color:var(--surface-2)] text-slate-700 cursor-default">ore</div>;
                                                                }

                                                                // Backfilling has specific material lists by sub-activity.
                                                                if (String(actName || '').toLowerCase() === 'backfilling') {
                                                                  const opts =
                                                                    rowSub === 'surface'
                                                                      ? ['Cement Paste Fill', 'Cement Aggregate Fill', 'Cement Hydraulic Fill']
                                                                      : ['Waste Rock Fill', 'Cement Rock Fill', 'Dry Stack Tailings', 'Raisebore Fines'];
                                                                  const curStr = String(cur || '').trim();
                                                                  const inList = opts.includes(curStr);
                                                                  return (
                                                                    <select
                                                                      className={`input w-full `}
                                                                      title={`Shift: ${String(hasLive ? liveVal : baselineVal)} | Validated: ${String(cur ?? '')}`}
                                                                      value={curStr}
                                                                      disabled={isReadonly || (actName === "Production Drilling" && (String(c) === "Metres Drilled" || String(c) === "Cleanouts Drilled" || String(c) === "Redrills"))}
                                                                      onChange={(e) => {
                                                                        const v = e.target.value;
                                                                        setEditedActs((prev) => ({
                                                                          ...prev,
                                                                          [Number((r as any)?.id)]: setValuesKey(currentObj, c, v),
                                                                        }));
                                                                      }}
                                                                    >
                                                                      <option value="">-</option>
                                                                      {!inList && curStr ? (
                                                                        <option value={curStr} disabled>
                                                                          {curStr} (legacy)
                                                                        </option>
                                                                      ) : null}
                                                                      {opts.map((nm) => (
                                                                        <option key={nm} value={nm}>
                                                                          {nm}
                                                                        </option>
                                                                      ))}
                                                                    </select>
                                                                  );
                                                                }

                                                                const curStr = String(cur || '').toLowerCase();
                                                                const normalized =
                                                                  curStr === 'ore' || curStr === 'waste' ? curStr : curStr ? curStr : '';
                                                                return (
                                                                  <select
                                                                    className={`input w-full ${isReadonly ? "bg-[color:var(--surface-2)] text-slate-700 cursor-default" : ""}`}
                                                                    title={`Shift: ${String(hasLive ? liveVal : baselineVal)} | Validated: ${String(
                                                                      cur ?? '',
                                                                    )}`}
                                                                    value={normalized}
                disabled={isReadonly || (actName === "Production Drilling" && (String(c) === "Metres Drilled" || String(c) === "Cleanouts Drilled" || String(c) === "Redrills"))}
                      onChange={(e) => {
                                                                      const v = e.target.value;
                                                                      setEditedActs((prev) => ({
                                                                        ...prev,
                                                                        [Number((r as any)?.id)]: setValuesKey(currentObj, c, v),
                                                                      }));
                                                                    }}
                                                                  >
                                                                    <option value="">-</option>
                                                                    <option value="ore">ore</option>
                                                                    <option value="waste">waste</option>
                                                                  </select>
                                                                );
                                                              }

                                                              // Derived totals
                                                              // - Production Drilling totals come from holes
                                                              // - Hauling (Trucks / Tonnes Hauled) comes from per-truck loads
                                                              if (actName === 'Production Drilling' && (c === 'Metres Drilled' || c === 'Cleanouts Drilled' || c === 'Redrills')) {
                                                                return (
                                                                  <div className="px-2 py-1.5">
                                                                    <div className="text-sm text-slate-800">{String(cur ?? '')}</div>
                                                                  </div>
                                                                );
                                                              }

                                                              if (actName === 'Hauling' && (c === 'Trucks' || c === 'Tonnes Hauled')) {
                                                                const loadsArr: any[] = Array.isArray((currentObj as any)?.loads) ? (currentObj as any).loads : [];
                                                                const trucks = loadsArr.length;
                                                                const tonnes = loadsArr.reduce(
                                                                  (acc: number, l: any) => acc + (parseFloat(String(l?.weight ?? l?.Weight ?? 0)) || 0),
                                                                  0,
                                                                );
                                                                const shown = c === 'Trucks' ? trucks : tonnes;
                                                                return (
                                                                  <div className="px-2 py-1.5">
                                                                    <div className="text-sm text-slate-800">{String(shown ?? '')}</div>
                                                                  </div>
                                                                );
                                                              }

                                                              // Default: free input (numeric/text)
                                                              // Backfilling numeric validation parity with user form.
                                                              if (String(actName || '').toLowerCase() === 'backfilling' && (c === 'Volume' || c === 'Buckets')) {
                                                                const isVol = c === 'Volume';
                                                                const min = 0;
                                                                const max = isVol ? 10000 : 250;
                                                                return (
                                                                  <input
                                                                    type="number"
                                                                    min={min}
                                                                    max={max}
                                                                    step={1}
                                                                    className={`input w-full `}
                                                                    title={`Validated: ${String(curVal ?? '')} | Original: ${String((hasLive ? liveVal : baselineVal) ?? '')}`}
                                                                    value={String(cur ?? '')}
                                                                    disabled={isReadonly}
                                                                    onChange={(e) => {
                                                                      const raw = e.target.value;
                                                                      let n = parseFloat(raw);
                                                                      if (!Number.isFinite(n)) n = 0;
                                                                      if (n < min) n = min;
                                                                      if (n > max) n = max;
                                                                      setEditedActs((prev) => ({
                                                                        ...prev,
                                                                        [Number((r as any)?.id)]: setValuesKey(currentObj, c, String(n)),
                                                                      }));
                                                                    }}
                                                                  />
                                                                );
                                                              }

                                                              return (
                                                                <input
                                                                  className={`input w-full `}
                                                                  title={`Validated: ${String(curVal ?? '')} | Original: ${String(
                                                                    (hasLive ? liveVal : baselineVal) ?? '',
                                                                  )}`}
                                                                  value={String(cur ?? '')}
                disabled={isReadonly || (actName === "Production Drilling" && (String(c) === "Metres Drilled" || String(c) === "Cleanouts Drilled" || String(c) === "Redrills"))}
                      onChange={(e) => {
                                                                    const v = e.target.value;
                                                                    setEditedActs((prev) => ({
                                                                      ...prev,
                                                                      [Number((r as any)?.id)]: setValuesKey(currentObj, c, v),
                                                                    }));
                                                                  }}
                                                                />
                                                              );
                                                            })()}
                                                          </td>
                                                        );
                                                      })}

                                                      <td className="p-2 text-right whitespace-nowrap">
                                                        <button
                                                          type="button"
                                                          className="px-3 py-1 rounded-full border border-[color:var(--hairline)] bg-[color:var(--card)] hover:bg-rose-50 text-rose-700 text-xs"
                                                          title="Delete this activity from validated data"
                                                          disabled={isReadonly}
                                                          onClick={async () => {
                                                            const id = Number((r as any)?.id);
                                                            if (!id || !selectedDate) return;
                                                            if (!confirm("Delete this validated activity?")) return;
                                                            try {
                                                              await api('/api/site-admin/validated/delete-activity', {
                                                                method: 'POST',
                                                                body: JSON.stringify({ site, date: selectedDate, id }),
                                                              });
                                                              setMsg('Activity deleted');
                                                              await loadDate(selectedDate);
                                                              const cal = await api(`/api/site-admin/calendar?year=${year}&site=${encodeURIComponent(site)}`);
                                                              const map: Record<string, DayStatus> = {};
                                                              for (const d of cal?.days || []) map[String(d.date)] = (d.status as DayStatus) || 'none';
                                                              setDays(map);
                                                            } catch (e: any) {
                                                              // Surface backend error details to make debugging possible
                                                              const raw = String(e?.message || e || 'Failed');
                                                              let msg = raw;
                                                              try {
                                                                const j = JSON.parse(raw);
                                                                msg = j?.error || j?.message || raw;
                                                              } catch {
                                                                // leave as-is
                                                              }
                                                              setMsg(`Failed to delete: ${msg}`);
                                                            }
                                                          }}
                                                        >
                                                          Delete
                                                        </button>
                                                      </td>
                                                    </tr>
                                                  );
                                                })}
                                              </Fragment>
                                            );
                                          })}
                                        </Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}