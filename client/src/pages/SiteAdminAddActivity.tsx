import Header from '../components/Header';
import SiteAdminBottomNav from '../components/SiteAdminBottomNav';
import data from '../data/activities.json';
import {useEffect, useMemo, useState, useRef} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

type Field = { field: string; required: number; unit: string; input: string };
type EquipRow = { id?: number; type: string; equipment_id: string };
type LocationRow = { id?: number; name: string; type: 'Heading' | 'Stope' | 'Stockpile' };

// Authoritative equipment → activity mapping (MUST mirror Activity.tsx)
const EQUIPMENT_ACTIVITY_MAP: Record<string, string[]> = {
  Truck: ['Hauling'],
  Loader: ['Loading', 'Backfilling'],
  Jumbo: ['Development'],
  'Production Drill': ['Production Drilling'],
  'Spray Rig': ['Development'],
  Agi: ['Development'],
  'Charge Rig': ['Charging'],
};

type ProdDrillBucket = 'Metres Drilled' | 'Cleanouts Drilled' | 'Redrills';
type DrillHole = {
  ring_id: string;
  hole_id: string;
  diameter: string; // e.g. "64mm" ... "254mm" or "other"
  diameter_other?: string;
  length_m: string; // controlled input; coerced on save
};

const HOLE_DIAMETER_OPTIONS = ['64mm', '76mm', '89mm', '102mm', '152mm', '203mm', '254mm', 'other'] as const;

function n2(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sumHoleLen(holes: DrillHole[]) {
  return holes.reduce((acc, h) => acc + n2(String(h.length_m || '').replace(/[^0-9.]/g, '')), 0);
}

function allowedLocationTypes(
  activity: string,
  sub: string,
  field: string,
): Array<'Heading' | 'Stope' | 'Stockpile'> {
  const a = String(activity || '').trim();
  const s = String(sub || '').trim();
  const f = String(field || '').trim();

  // Development: all subs -> Heading locations
  if (a === 'Development') return ['Heading'];

  // Production Drilling
  if (a === 'Production Drilling') {
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
      // Development hauling: Source is the heading. From can be Heading or Stockpile (per request). To remains Stockpile.
      if (f === 'Source') return ['Heading'];
      if (f === 'From') return ['Heading', 'Stockpile'];
      if (f === 'To') return ['Stockpile'];
      return ['Heading', 'Stockpile'];
    }
    if (s === 'Production') {
      // Production hauling: Source is the stope. From can be Stope or Stockpile (per request). To remains Stockpile.
      if (f === 'Source') return ['Stope'];
      if (f === 'From') return ['Stope', 'Stockpile'];
      if (f === 'To') return ['Stockpile'];
      return ['Stope', 'Stockpile'];
    }
  }

  // Backfilling: always "To" a stope (both Surface and Underground)
  if (a === 'Backfilling') {
    if (f === 'To') return ['Stope'];
    return ['Stope'];
  }
  // Default: allow any (so we don't block other future forms)
  return ['Heading', 'Stope', 'Stockpile'];
}

function parseRule(input: string) {
  const [kind, rest] = input.split('|', 2);
  if (kind === 'select') {
    if (rest === 'equipment' || rest === 'location') return { kind, source: rest };
    const options = (rest || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    return { kind, options };
  }
  if (kind === 'number') {
    const parts = (rest || '').split('|');
    const range = parts[0] || '';
    const [minS, maxS] = range.split('-');
    const dp = parts[1] === '1dp' ? 1 : 0;
    const min = minS ? parseFloat(minS) : undefined;
    const max = maxS ? parseFloat(maxS) : undefined;
    return { kind, min, max, dp };
  }
  return { kind: 'text' };
}

export default function SiteAdminAddActivity() {
  const nav = useNavigate();
  const loc = useLocation();
  const qs = useMemo(() => new URLSearchParams(loc.search), [loc.search]);

  // These are driven by the validation calendar context (NOT editable here)
  const [site] = useState<string>(String(qs.get('site') || 'default'));
  const [date] = useState<string>(String(qs.get('date') || ''));
  const [dn, setDn] = useState<string>(String(qs.get('dn') || 'DS'));

  // Operator is selectable from the site's user list (NOT free-typed)
  const [siteUsers, setSiteUsers] = useState<Array<{ id: number; name: string; email: string; site: string }>>([]);
  const [userId, setUserId] = useState<number>(Number(qs.get('user_id') || 0));

  const selectedUser = useMemo(() => siteUsers.find((u) => u.id === userId) || null, [siteUsers, userId]);
  const userEmail = selectedUser?.email || '';

  // Equipment/Locations pulled from the selected operator (same inputs + validation as user forms)
  const [equipmentRows, setEquipmentRows] = useState<EquipRow[]>([]);
  const [locationList, setLocationList] = useState<LocationRow[]>([]);

  function locationOptionsForField(fieldName: string): LocationRow[] {
    const allowed = new Set<LocationRow['type']>(allowedLocationTypes(activity, sub, fieldName));
    return (locationList || []).filter((l) => allowed.has(l.type));
  }

  // Production drilling hole-entry capture (metres/cleanouts/redrills)
  const [pdHoles, setPdHoles] = useState<Record<ProdDrillBucket, DrillHole[]>>({
    'Metres Drilled': [],
    'Cleanouts Drilled': [],
    Redrills: [],
  });
  const [pdModal, setPdModal] = useState<null | { bucket: ProdDrillBucket }>(null);
  const [pdLastDiameter, setPdLastDiameter] = useState<string>('102mm');

  // Derived metres totals from the individual hole list (matches user form behaviour)
  const pdTotals = useMemo(() => {
    const out: Record<string, number> = {};
    (Object.keys(pdHoles) as ProdDrillBucket[]).forEach((k) => {
      const sum = (pdHoles[k] || []).reduce((acc, h) => {
        const n = Number(String(h.length_m ?? '').trim());
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
      out[k] = Math.round(sum * 100) / 100;
    });
    return out;
  }, [pdHoles]);


  const activityKeys = Object.keys(data as any);
  const [activity, setActivity] = useState<string>(activityKeys[0] || '');
  const subKeys = Object.keys(((data as any)[activity] || {}) as any);
  const [sub, setSub] = useState<string>(subKeys[0] || '');

  const fields: Field[] = useMemo(() => {
    const group: any = (data as any)[activity] || {};
    return (group[sub] || group[''] || []) as Field[];
  }, [activity, sub]);

  const [values, setValues] = useState<Record<string, any>>({});

  // Full-screen +/- count modal (used for Backfilling Underground buckets, etc.)
  const [countModal, setCountModal] = useState<{ field: string } | null>(null);
  const countKeyCaptureRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!countModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const key = (e.key || '').toLowerCase();
      if (key !== 'a' && key !== 'b') return;
      e.preventDefault();
      e.stopPropagation();
      const field = countModal.field;
      setValues((v) => {
        const cur = Math.max(0, parseInt(String(v[field] ?? 0), 10) || 0);
        if (key === 'a') return { ...v, [field]: cur + 1 };
        return { ...v, [field]: Math.max(0, cur - 1) };
      });
      window.setTimeout(() => countKeyCaptureRef.current?.focus(), 0);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.setTimeout(() => countKeyCaptureRef.current?.focus(), 0);
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true } as any);
  }, [countModal]);


  // Hauling: per-load weights
  const [haulSameWeight, setHaulSameWeight] = useState<boolean>(true);
  const [haulDefaultWeight, setHaulDefaultWeight] = useState<string>('');
  const [haulLoadCount, setHaulLoadCount] = useState<string>('');
  const [haulLoads, setHaulLoads] = useState<Array<{ weight: string }>>([]);

  useEffect(() => {
    const group: any = (data as any)[activity] || {};
    const sk = Object.keys(group);
    setSub(sk[0] || '');
    setValues({});
    if (activity !== 'Hauling') {
      setHaulLoads([]);
      setHaulSameWeight(true);
      setHaulDefaultWeight('');
      setHaulLoadCount('');
    }
  }, [activity]);

  useEffect(() => {
    setValues({});
  }, [sub]);

  // Load site users
  useEffect(() => {
    (async () => {
      if (!site) return;
      try {
        const r = await api(`/api/site-admin/site-users?site=${encodeURIComponent(site)}`);
        const users = (r as any)?.users || [];
        setSiteUsers(users);
        if (!userId && users.length) setUserId(Number(users[0].id || 0));
      } catch {
        setSiteUsers([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  // Load selected operator's equipment + locations
  useEffect(() => {
    (async () => {
      if (!userId) {
        setEquipmentRows([]);
        setLocationList([]);
        return;
      }
      try {
        const eq = await api(`/api/equipment?user_id=${encodeURIComponent(String(userId))}`);
        setEquipmentRows(((eq as any)?.items || []).filter((x: any) => x?.equipment_id && x?.type));
      } catch {
        setEquipmentRows([]);
      }
      try {
        const lr = await api(`/api/locations?user_id=${encodeURIComponent(String(userId))}`);
        setLocationList(((lr as any)?.items || []).filter((x: any) => x?.name && x?.type));
      } catch {
        setLocationList([]);
      }
    })();
  }, [userId]);

  const filteredEquipment = useMemo(() => {
    return (equipmentRows || [])
      .filter((r) => (EQUIPMENT_ACTIVITY_MAP[r.type] || []).includes(activity))
      .map((r) => String((r as any).name ?? (r as any).equipment_id ?? (r as any).id))
      .sort((a, b) => a.localeCompare(b));
  }, [equipmentRows, activity]);

  // Load master equipment + locations for this site (SiteAdmin → Equipment&Locations)
  useEffect(() => {
    (async () => {
      if (!site) {
        setEquipmentRows([]);
        setLocationList([]);
        return;
      }
      try {
        const eq = await api(`/api/site-admin/admin-equipment?site=${encodeURIComponent(site)}`);
        setEquipmentRows(((eq as any)?.rows || []).filter((x: any) => x?.equipment_id && x?.type));
      } catch {
        setEquipmentRows([]);
      }
      try {
        const lr = await api(`/api/site-admin/admin-locations?site=${encodeURIComponent(site)}`);
        setLocationList(((lr as any)?.rows || []).filter((x: any) => x?.name && x?.type));
      } catch {
        setLocationList([]);
      }
    })();
  }, [site]);

  const canFinish = useMemo(() => {
    if (!site || !date || !userId || !userEmail) return false;

    const pdFields = new Set(['Metres Drilled', 'Cleanouts Drilled', 'Redrills']);

    // Hauling: allow per-load weights
    const haulOk = (() => {
      if (activity !== 'Hauling') return true;

      const explicit = (haulLoads || [])
        .map((l) => ({ weight: Number(String(l.weight || '').replace(/[^0-9.]/g, '')) }))
        .filter((l) => Number.isFinite(l.weight) && l.weight > 0);
      if (explicit.length) return true;

      if (haulSameWeight) {
        const c = Number(String(haulLoadCount || '').replace(/[^0-9]/g, ''));
        const w = Number(String(haulDefaultWeight || '').replace(/[^0-9.]/g, ''));
        return Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0;
      }
      return false;
    })();

    const baseOk = fields.every((f) => {
      if (activity === 'Production Drilling' && pdFields.has(f.field)) return true;
      if (activity === 'Hauling' && (f.field === 'Trucks' || f.field === 'Weight')) return true;
      return !f.required || (values[f.field] !== undefined && values[f.field] !== '');
    });

    if (!baseOk) return false;
    if (!haulOk) return false;

    // Production Drilling: allow submit as long as at least ONE of the three totals is > 0
    const hasPd = fields.some((f) => pdFields.has(f.field));
    if (activity === 'Production Drilling' && hasPd) {
      const m = Number(values['Metres Drilled'] || 0);
      const c = Number(values['Cleanouts Drilled'] || 0);
      const r = Number(values['Redrills'] || 0);
      return (Number.isFinite(m) && m > 0) || (Number.isFinite(c) && c > 0) || (Number.isFinite(r) && r > 0);
    }

    return true;
  }, [site, date, userId, userEmail, fields, values, activity, haulLoads, haulSameWeight, haulLoadCount, haulDefaultWeight]);

  

  // Keep Production Drilling totals in sync with hole entries
  useEffect(() => {
    if (activity !== 'Production Drilling') return;
    const m = sumHoleLen(pdHoles['Metres Drilled']);
    const c = sumHoleLen(pdHoles['Cleanouts Drilled']);
    const r = sumHoleLen(pdHoles['Redrills']);
    setValues((v) => ({ ...v, 'Metres Drilled': m || '', 'Cleanouts Drilled': c || '', Redrills: r || '' }));
  }, [activity, pdHoles]);
async function submit() {
    if (!canFinish) return;

    // normalize manual entries for equipment/location (match Activity.tsx behavior)
    const baseValues: any = { ...values };
    for (const key of Object.keys(baseValues)) {
      if (baseValues[key] === '__manual__') {
        if (key === 'Equipment' && baseValues['__manual_equipment']) baseValues[key] = baseValues['__manual_equipment'];
        const mk = `__manual_location_${key}`;
        if ((baseValues as any)[mk]) baseValues[key] = (baseValues as any)[mk];
      }
    }
    for (const k of Object.keys(baseValues)) {
      if (k.startsWith('__manual_location_')) delete baseValues[k];
    }
    delete baseValues.__manual_equipment;

    // normalize hauling loads
    let loads: Array<{ weight: number }> | undefined;
    if (activity === 'Hauling') {
      if (haulSameWeight) {
        const c = Number(String(haulLoadCount || '').replace(/[^0-9]/g, ''));
        const w = Number(String(haulDefaultWeight || '').replace(/[^0-9.]/g, ''));
        loads = Array.from({ length: c }, () => ({ weight: w, time_s: null, kind: 'manual' }));
      } else {
        loads = haulLoads
          .map((l) => ({
            weight: Number(String(l.weight || '').replace(/[^0-9.]/g, '')),
            time_s: (l as any)?.time_s ?? null,
            kind: (l as any)?.kind || (typeof (l as any)?.time_s === 'number' ? 'timed' : 'manual'),
          }))
          .filter((l) => Number.isFinite(l.weight) && l.weight > 0);
      }
      baseValues.Trucks = loads.length;
      if (haulSameWeight) baseValues.Weight = Number(String(haulDefaultWeight).replace(/[^0-9.]/g, ''));
      baseValues['Tonnes Hauled'] = loads.reduce((a, x) => a + (x.weight || 0), 0);

      // Production hauling is always ore (no Material dropdown).
      if (String(sub).toLowerCase() === 'production') {
        baseValues.Material = 'Ore';
      }
    }

    const payload_json: any = { activity, sub, values: baseValues };
    if (activity === 'Production Drilling') payload_json.pd_holes = pdHoles;

    if (loads) payload_json.loads = loads;

    try {
      // Ensure the validated shift exists
      await api('/api/site-admin/validated/create-shift', {
        method: 'POST',
        body: JSON.stringify({ site, date, dn, user_email: userEmail }),
      });
      // Add activity
      await api('/api/site-admin/validated/add-activity', {
        method: 'POST',
        body: JSON.stringify({ site, date, dn, user_email: userEmail, activity, sub_activity: sub, payload_json }),
      });
      nav(`/SiteAdmin/Validate?site=${encodeURIComponent(site)}&date=${encodeURIComponent(date)}`);
    } catch (e: any) {
      const raw = String(e?.message || e || 'Failed');
      let msg = raw;
      try {
        const j = JSON.parse(raw);
        msg = j?.error || j?.message || raw;
      } catch {
        // keep raw
      }
      alert(`Failed to add activity: ${msg}`);
    }
  }

  const totalHaul = useMemo(() => {
    const sum = haulLoads.reduce((acc, l) => acc + (Number(String(l.weight || '').replace(/[^0-9.]/g, '')) || 0), 0);
    return sum;
  }, [haulLoads]);

  return (
    <>
      <div className="min-h-screen bg-slate-100">
      <Header title="Add Validated Activity" showSync={false} showBell={false} />

      <div className="max-w-3xl mx-auto p-4 pb-28">
        <div className="rounded-2xl bg-[color:var(--card)] border border-[color:var(--hairline)] shadow-sm p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium">Site</label>
              <div className="input bg-[color:var(--surface-2)]">{site}</div>
            </div>
            <div>
              <label className="block text-sm font-medium">Date</label>
              <div className="input bg-[color:var(--surface-2)]">{date || '-'}</div>
            </div>
            <div>
              <label className="block text-sm font-medium">Shift</label>
              <select className="input" value={dn} onChange={(e) => setDn(e.target.value)}>
                <option value="DS">DS</option>
                <option value="NS">NS</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium">Operator</label>
              <select
                className="input"
                value={userId ? String(userId) : ''}
                onChange={(e) => setUserId(Number(e.target.value || 0))}
              >
                <option value="">-</option>
                {siteUsers.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4">
            <div>
              <label className="block text-sm font-medium">Activity</label>
              <select className="input" value={activity} onChange={(e) => setActivity(e.target.value)}>
                {activityKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium">Sub-Activity</label>
              <select className="input" value={sub} onChange={(e) => setSub(e.target.value)}>
                {subKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {fields.map((f) => {
              if (activity === 'Hauling' && (f.field === 'Trucks' || f.field === 'Weight')) return null;
              const rule: any = parseRule(f.input);
              const label = `${f.field}${f.unit ? ` (${f.unit})` : ''}`;

              // equipment
              if (rule.kind === 'select' && rule.source === 'equipment') {
                return (
                  <div key={f.field}>
                    <label className="block text-sm font-medium">{label}{f.required ? ' *' : ''}</label>
                    <select
                      className="input"
                      value={String(values[f.field] ?? '')}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [f.field]: e.target.value,
                          ...(e.target.value !== '__manual__' ? { __manual_equipment: '' } : {}),
                        }))
                      }
                    >
                      <option value="">-</option>
                      {filteredEquipment.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                      <option value="__manual__">Other (manual)</option>
                    </select>
                    {values[f.field] === '__manual__' ? (
                      <input
                        className="input mt-2"
                        placeholder="Enter equipment"
                        value={values.__manual_equipment || ''}
                        onChange={(e) => setValues((v) => ({ ...v, __manual_equipment: e.target.value }))}
                      />
                    ) : null}
                  </div>
                );
              }

              // locations
              if (rule.kind === 'select' && rule.source === 'location') {
                const opts = locationOptionsForField(f.field);
                const manualKey = `__manual_location_${f.field}`;
                return (
                  <div key={f.field}>
                    <label className="block text-sm font-medium">{label}{f.required ? ' *' : ''}</label>
                    <select
                      className="input"
                      value={String(values[f.field] ?? '')}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [f.field]: e.target.value,
                          ...(e.target.value !== '__manual__' ? { [manualKey]: '' } : {}),
                        }))
                      }
                    >
                      <option value="">-</option>
                      {opts.map((o) => (
                        <option key={String((o as any).id ?? (o as any).name)} value={String((o as any).name)}>
                          {String((o as any).name)}
                        </option>
                      ))}
                      <option value="__manual__">Other (manual)</option>
                    </select>
                    {values[f.field] === '__manual__' ? (
                      <input
                        className="input mt-2"
                        placeholder={`Enter ${f.field.toLowerCase()}`}
                        value={values[manualKey] || ''}
                        onChange={(e) => setValues((v) => ({ ...v, [manualKey]: e.target.value }))}
                      />
                    ) : null}
                  </div>
                );
              }

              // dropdown
              if (rule.kind === 'dropdown') {
                return (
                  <div key={f.field}>
                    <label className="block text-sm font-medium">{label}{f.required ? ' *' : ''}</label>
                    <select
                      className="input"
                      value={String(values[f.field] ?? '')}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    >
                      <option value="">-</option>
                      {(rule as any).options.map((o: string) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              }


              // Production Drilling: totals are derived from holes; show read-only + hole editor
              if (
                activity === 'Production Drilling' &&
                (f.field === 'Metres Drilled' || f.field === 'Cleanouts Drilled' || f.field === 'Redrills')
              ) {
                return (
                  <div key={f.field}>
                    <label className="block text-sm font-medium">{label}{f.required ? ' *' : ''}</label>
                    <div className="flex flex-col gap-1">
                      <input className="input" readOnly value={String(values[f.field] ?? '')} placeholder="0" />
                      <button type="button" className="btn" onClick={() => setPdModal({ bucket: f.field as ProdDrillBucket })}>
                        Add holes
                      </button>
                    </div>
                  </div>
                );
              }

              const isNum = rule.kind === 'number';
              return (
                <div key={f.field}>
                  <label className="block text-sm font-medium">{label}{f.required ? ' *' : ''}</label>
                  {(activity === 'Backfilling' && sub === 'Underground' && f.field === 'Buckets') ? (
                    <button
                      type="button"
                      className="input text-left flex items-center justify-between"
                      onClick={() => setCountModal({ field: f.field })}
                    >
                      <span className="opacity-70">Tap to count</span>
                      <span className="font-semibold">{String(values[f.field] ?? 0)}</span>
                    </button>
                  ) : (
                    <input
                      className="input"
                      inputMode={isNum ? 'decimal' : 'text'}
                      value={String(values[f.field] ?? '')}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    />
                  )}
                </div>
              );
            })}

            {activity === 'Hauling' ? (
              <div className="p-3 rounded-xl border border-[color:var(--hairline)] bg-[color:var(--surface-2)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold">Truck Loads</div>
                  <div className="text-xs opacity-70">
                    {haulSameWeight ? `Same weight` : `${haulLoads.length} loads`} • {Math.round(totalHaul)} t
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={haulSameWeight} onChange={(e) => setHaulSameWeight(e.target.checked)} />
                  <span className="text-sm">Same weight for all loads</span>
                </div>

                {haulSameWeight ? (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="block text-xs font-medium opacity-80">No. of loads</label>
                      <input className="input" inputMode="numeric" value={haulLoadCount} onChange={(e) => setHaulLoadCount(e.target.value)} placeholder="e.g. 8" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium opacity-80">Weight per load (t)</label>
                      <input className="input" inputMode="decimal" value={haulDefaultWeight} onChange={(e) => setHaulDefaultWeight(e.target.value)} placeholder="e.g. 50" />
                    </div>
                    <div className="col-span-2">
                      <button
                        type="button"
                        className="btn w-full"
                        onClick={() => {
                          const c = Number(String(haulLoadCount || '').replace(/[^0-9]/g, ''));
                          const w = Number(String(haulDefaultWeight || '').replace(/[^0-9.]/g, ''));
                          if (!Number.isFinite(c) || c <= 0) return;
                          if (!Number.isFinite(w) || w <= 0) return;
                          setHaulLoads(Array.from({ length: c }, () => ({ weight: String(w) })));
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    <button type="button" className="btn" onClick={() => setHaulLoads((prev) => [...prev, { weight: '' }])}>
                      + Add truck
                    </button>
                    {haulLoads.length ? (
                      <div className="space-y-2">
                        {haulLoads.map((l, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <div className="text-xs w-12 opacity-70">#{i + 1}</div>
                            <input
                              className="input flex-1"
                              inputMode="decimal"
                              value={l.weight}
                              onChange={(e) => setHaulLoads((prev) => prev.map((x, xi) => (xi === i ? { ...x, weight: e.target.value } : x)))}
                              placeholder="Weight (t)"
                            />
                            <button type="button" className="px-3 py-2 rounded-xl border border-[color:var(--hairline)] bg-[color:var(--card)] hover:bg-[color:var(--surface-2)]" onClick={() => setHaulLoads((prev) => prev.filter((_, xi) => xi !== i))}>
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs opacity-70">Add loads to record unique weights.</div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>



      {pdModal ? (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-[1000] p-3 overflow-auto pt-6 pb-24">
          <div className="bg-[color:var(--card)] w-full max-w-md sm:max-w-2xl rounded-2xl shadow-xl border p-3 sm:p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="font-bold">Production drilling holes</div>
                <div className="text-xs opacity-70">{pdModal.bucket}</div>
              </div>
              <button type="button" className="btn" onClick={() => setPdModal(null)}>
                Close
              </button>
            </div>

            <div className="text-xs opacity-70 mb-2">
              Add each hole and the total will sum automatically into <b>{pdModal.bucket}</b>.
            </div>

            <div className="overflow-auto border rounded-xl">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-[color:var(--surface-2)] border-b">
                  <tr>
                    <th className="p-1 text-left w-[72px]">Ring ID</th>
                    <th className="p-1 text-left w-[72px]">Hole ID</th>
                    <th className="p-1 text-left w-[92px]">Diameter</th>
                    <th className="p-1 text-left w-[92px]">Length (m)</th>
                    <th className="p-1 text-left w-[36px]"> </th>
                  </tr>
                </thead>
                <tbody>
                  {(pdHoles[pdModal.bucket] || []).map((h, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="p-1">
                        <input
                          className="input w-full"
                          value={h.ring_id}
                          onChange={(e) => {
                            const v = e.target.value;
                            setPdHoles((prev) => {
                              const arr = [...(prev[pdModal.bucket] || [])];
                              arr[i] = { ...arr[i], ring_id: v };
                              return { ...prev, [pdModal.bucket]: arr };
                            });
                          }}
                        />
                      </td>
                      <td className="p-1">
                        <input
                          className="input w-full"
                          value={h.hole_id}
                          onChange={(e) => {
                            const v = e.target.value;
                            setPdHoles((prev) => {
                              const arr = [...(prev[pdModal.bucket] || [])];
                              arr[i] = { ...arr[i], hole_id: v };
                              return { ...prev, [pdModal.bucket]: arr };
                            });
                          }}
                        />
                      </td>
                      <td className="p-1">
                        <div className="flex flex-col gap-1">
                          <select
                            className="input w-full"
                            value={h.diameter}
                            onChange={(e) => {
                              const v = e.target.value;
                              setPdLastDiameter(v);
                              setPdHoles((prev) => {
                                const arr = [...(prev[pdModal.bucket] || [])];
                                arr[i] = { ...arr[i], diameter: v, diameter_other: v === 'other' ? (arr[i].diameter_other || '') : '' };
                                return { ...prev, [pdModal.bucket]: arr };
                              });
                            }}
                          >
                            {HOLE_DIAMETER_OPTIONS.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>

                          {h.diameter === 'other' ? (
                            <input
                              className="input w-full"
                              placeholder="e.g. 115mm"
                              value={h.diameter_other || ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                setPdHoles((prev) => {
                                  const arr = [...(prev[pdModal.bucket] || [])];
                                  arr[i] = { ...arr[i], diameter_other: v };
                                  return { ...prev, [pdModal.bucket]: arr };
                                });
                              }}
                            />
                          ) : null}
                        </div>
                      </td>

                      <td className="p-1">
                        <input
                          className="input w-full"
                          inputMode="decimal"
                          value={h.length_m}
                          onChange={(e) => {
                            const v = e.target.value;
                            setPdHoles((prev) => {
                              const arr = [...(prev[pdModal.bucket] || [])];
                              arr[i] = { ...arr[i], length_m: v };
                              return { ...prev, [pdModal.bucket]: arr };
                            });
                          }}
                        />
                      </td>

                      <td className="p-1">
                        <button
                          type="button"
                          className="px-3 py-2 rounded-xl border border-[color:var(--hairline)] bg-[color:var(--card)] hover:bg-[color:var(--surface-2)]"
                          onClick={() =>
                            setPdHoles((prev) => {
                              const arr = [...(prev[pdModal.bucket] || [])].filter((_, xi) => xi !== i);
                              return { ...prev, [pdModal.bucket]: arr };
                            })
                          }
                          title="Remove hole"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setPdHoles((prev) => {
                    const arr = [...(prev[pdModal.bucket] || [])];
                    arr.push({ ring_id: '', hole_id: '', diameter: pdLastDiameter || HOLE_DIAMETER_OPTIONS[0], diameter_other: '', length_m: '' });
                    return { ...prev, [pdModal.bucket]: arr };
                  })
                }
              >
                + Add hole
              </button>
              <div className="text-xs opacity-70">
                Total: <b>{pdTotals[pdModal.bucket] || 0}</b> m
              </div>
            </div>

            <div className="mt-3 flex justify-end">
              <button type="button" className="btn btn-primary" onClick={() => setPdModal(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

          <button className="btn btn-primary mt-4 w-full" disabled={!canFinish} onClick={submit}>
            Add activity
          </button>

          {!canFinish ? (
            <div className="mt-2 text-xs opacity-70">Fill required fields (and select an operator) to enable adding.</div>
          ) : null}
        </div>
      </div>

      <SiteAdminBottomNav />
    </div>

      {countModal ? (
        <div className="fixed inset-0 z-[1002] bg-black/85">
          <div className="absolute inset-0 flex flex-col p-4">
            <div className="flex items-center justify-between">
              <div className="text-white">
                <div className="text-sm opacity-80">Count</div>
                <div className="text-xs opacity-70">A = +1, B = −1</div>
              </div>
              <button type="button" className="btn" onClick={() => setCountModal(null)}>
                Done
              </button>
            </div>

            <div className="relative mt-4 flex-1 rounded-2xl bg-[color:var(--card)] p-4 flex flex-col items-center justify-center">
              <div className="text-7xl font-extrabold tabular-nums">{String(values[countModal.field] ?? 0)}</div>

              <div className="mt-6 flex w-full gap-3">
                <button
                  type="button"
                  className="btn flex-1 text-2xl py-6"
                  onClick={() =>
                    setValues((v) => {
                      const cur = Math.max(0, parseInt(String(v[countModal.field] ?? 0), 10) || 0);
                      return { ...v, [countModal.field]: Math.max(0, cur - 1) };
                    })
                  }
                >
                  −
                </button>

                <button
                  type="button"
                  className="btn flex-1 text-2xl py-6"
                  onClick={() =>
                    setValues((v) => {
                      const cur = Math.max(0, parseInt(String(v[countModal.field] ?? 0), 10) || 0);
                      return { ...v, [countModal.field]: cur + 1 };
                    })
                  }
                >
                  +
                </button>
              </div>

              <input
                ref={countKeyCaptureRef}
                autoFocus
                inputMode="none"
                readOnly
                className="absolute opacity-0 pointer-events-none"
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      ) : null}



    </>

  );
}
