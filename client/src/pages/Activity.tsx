import Header from '../components/Header';
import data from '../data/activities.json';
import { useEffect, useMemo, useState } from 'react';
import { getDB } from '../lib/idb';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';
import { loadEquipment, loadLocations } from '../lib/datalists';

type Field = { field: string; required: number; unit: string; input: string };
type EquipRow = { id?: number; type: string; equipment_id: string };
type LocationRow = { id?: number; name: string; type: 'Heading' | 'Stope' | 'Stockpile' };

// Authoritative equipment → activity mapping
const EQUIPMENT_ACTIVITY_MAP: Record<string, string[]> = {
  Truck: ['Hauling'],
  Loader: ['Loading'],
  Jumbo: ['Development'],
  'Production Drill': ['Production Drilling'],
  'Spray Rig': ['Development'],
  Agi: ['Development'],
  'Charge Rig': ['Charging'],
};

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
    if (s === 'Production') return ['Stope'];
  }

  // Hauling
  if (a === 'Hauling') {
    if (s === 'Development') {
      // Source is the heading; From/To are stockpiles
      if (f === 'Source') return ['Heading'];
      if (f === 'From' || f === 'To') return ['Stockpile'];
      return ['Stockpile'];
    }
    if (s === 'Production') {
      // Treat production hauling as stope → stockpile
      // Source must be stope only; stockpiles are only valid for From/To.
      if (f === 'Source') return ['Stope'];
      if (f === 'From' || f === 'To') return ['Stockpile'];
      return ['Stockpile'];
    }
  }

  // Default: allow any (so we don't block other future forms)
  return ['Heading', 'Stope', 'Stockpile'];
}

export default function Activity() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const activityKeys = Object.keys(data);
  const [activity, setActivity] = useState<string>(activityKeys[0] || '');
  const [sub, setSub] = useState<string>('');
  const [fields, setFields] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [equipmentRows, setEquipmentRows] = useState<EquipRow[]>([]);
  const [locationList, setLocationList] = useState<LocationRow[]>([]);

  function locationOptionsForField(fieldName: string): LocationRow[] {
    const allowed = new Set<LocationRow['type']>(allowedLocationTypes(activity, sub, fieldName));
    return (locationList || []).filter((l) => allowed.has(l.type));
  }

  const [boltInputs, setBoltInputs] = useState<
    { length: string; lengthOther: string; type: string; count: string }[]
  >([
    { length: '', lengthOther: '', type: '', count: '' },
    { length: '', lengthOther: '', type: '', count: '' },
    { length: '', lengthOther: '', type: '', count: '' },
  ]);

  // Load equipment/location lists (online -> cache; offline -> cache)
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');
      const uid = session?.user_id || 0;

      // 1) show cached immediately (includes type + equipment_id)
      const cachedEq = (await db.getAll('equipment')) as any[];
      setEquipmentRows(
        (cachedEq || [])
          .map((r) => ({ equipment_id: r.equipment_id, type: r.type, id: r.id }))
          .filter((r) => r.equipment_id && r.type),
      );

      // 2) refresh from network (also updates the IDB store)
      await loadEquipment(uid);

      // 3) re-read updated cache
      const db2 = await getDB();
      const updatedEq = (await db2.getAll('equipment')) as any[];
      setEquipmentRows(
        (updatedEq || [])
          .map((r) => ({ equipment_id: r.equipment_id, type: r.type, id: r.id }))
          .filter((r) => r.equipment_id && r.type),
      );

      const loc = await loadLocations(uid);
      setLocationList(loc);
    })();
  }, []);

  // When activity changes: auto-pick the first sub-activity
  useEffect(() => {
    const group: any = (data as any)[activity] || {};
    const subKeys = Object.keys(group);
    const first = subKeys.length ? subKeys[0] : '';
    setSub(first);
  }, [activity]);

  // Whenever activity or sub changes: regenerate the form fields
  useEffect(() => {
    const group: any = (data as any)[activity] || {};
    const list: Field[] = group ? group[sub] || group[''] || [] : [];

    const filtered =
      activity === 'Development' && (sub === 'Rehab' || sub === 'Ground Support')
        ? list.filter((f) => !['Bolt Length', 'Bolt Type', 'No. of Bolts'].includes(f.field))
        : list;

    setFields(filtered);
    setValues({}); // reset form inputs for the new schema

    setBoltInputs([
      { length: '', lengthOther: '', type: '', count: '' },
      { length: '', lengthOther: '', type: '', count: '' },
      { length: '', lengthOther: '', type: '', count: '' },
    ]);
  }, [activity, sub]);

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.field];
      const rule = parseRule(f.input);
      if (f.required && (v === undefined || v === null || v === '')) {
        e[f.field] = 'Required';
        continue;
      }
      if (rule.kind === 'number' && v !== undefined && v !== '') {
        const n = Number(v);
        if (Number.isNaN(n)) e[f.field] = 'Must be a number';
        if (rule.min !== undefined && n < rule.min) e[f.field] = `Min ${rule.min}`;
        if (rule.max !== undefined && n > rule.max) e[f.field] = `Max ${rule.max}`;
        if (rule.dp === 0 && String(v).includes('.')) e[f.field] = 'Whole numbers only';
      }
    }
    return e;
  }, [fields, values]);

  const canFinish =
    Object.keys(errors).length === 0 &&
    fields.every((f) => !f.required || (values[f.field] !== undefined && values[f.field] !== ''));

  async function finishTask() {
    if (!canFinish) {
      setMsg('Please complete required fields');
      return;
    }
    const db = await getDB();

    // normalize manual entries for equipment/location
    const baseValues: any = { ...values };
    for (const key of Object.keys(baseValues)) {
      if (baseValues[key] === '__manual__') {
        if (key === 'Equipment' && baseValues['__manual_equipment'])
          baseValues[key] = baseValues['__manual_equipment'];
        const mk = `__manual_location_${key}`;
        if ((baseValues as any)[mk]) baseValues[key] = (baseValues as any)[mk];
      }
    }

    

    // remove helper manual-location fields so they don't pollute saved payload
    for (const k of Object.keys(baseValues)) {
      if (k.startsWith('__manual_location_')) delete baseValues[k];
    }
// ✅ FIX: prevent "SP to Truck/SP to SP" collisions between Dev vs Production loading
    // This avoids Dev rehandle buckets being attributed to Production (stope) in downstream rollups.
    if (activity === 'Loading') {
      const subLc = String(sub || '').toLowerCase();
      const prefix = subLc.includes('dev')
        ? 'Dev '
        : subLc.includes('prod') || subLc.includes('stope')
          ? 'Stope '
          : '';
      if (prefix) {
        const keysToSplit = ['SP to Truck', 'SP to SP'];
        for (const k of keysToSplit) {
          if (k in baseValues) {
            baseValues[`${prefix}${k}`] = baseValues[k];
            delete baseValues[k];
          }
        }
      }
    }

    const shift =
      (await db.get('shift', 'current')) ||
      JSON.parse(localStorage.getItem('spectatore-shift') || '{}');
    const session = await db.get('session', 'auth');

    const isDevRehabOrGS =
      activity === 'Development' && (sub === 'Rehab' || sub === 'Ground Support');

    if (!isDevRehabOrGS) {
      // ✅ keep the stored payload clean (don’t persist helper/manual fields)
      delete baseValues.__manual_equipment;
      delete baseValues.__manual_location;

      await db.add('activities', {
        payload: { activity, sub, values: baseValues },
        shiftDate: shift?.date,
        dn: shift?.dn,
        user_id: session?.user_id,
        ts: Date.now(),
      });
    } else {
      const records: any[] = [];

      const cleanBase = () => {
        const v: any = { ...baseValues };
        delete v.__manual_equipment;
        delete v.__manual_location;
        return v;
      };

      const nonEmptyGroups = (boltInputs || []).filter((b) => {
        const hasLength =
          (b.length && b.length !== 'Other') || (b.length === 'Other' && b.lengthOther);
        const hasType = !!b.type;
        const hasCount = !!b.count && Number(b.count) > 0;
        return hasLength || hasType || hasCount;
      });

      if (nonEmptyGroups.length === 0) {
        records.push(cleanBase());
      } else {
        nonEmptyGroups.forEach((b, idx) => {
          const vals: any = cleanBase();
          const lengthValue =
            b.length === 'Other'
              ? b.lengthOther
                ? `${b.lengthOther}m`
                : ''
              : b.length;

          if (lengthValue) vals['Bolt Length'] = lengthValue;
          if (b.type) vals['Bolt Type'] = b.type;
          if (b.count) vals['No. of Bolts'] = Number(b.count);

          // Only include Agi/Spray on the first record to avoid double-counting
          if (idx > 0) {
            if ('Agi Volume' in vals) delete vals['Agi Volume'];
            if ('Spray Volume' in vals) delete vals['Spray Volume'];
          }

          records.push(vals);
        });
      }

      for (const valuesToSave of records) {
        await db.add('activities', {
          payload: { activity, sub, values: valuesToSave },
          shiftDate: shift?.date,
          dn: shift?.dn,
          user_id: session?.user_id,
          ts: Date.now(),
        });
      }
    }

    setMsg('task saved successfully');
    setTimeout(() => nav('/Shift'), 500);
  }

  const subKeys = Object.keys((data as any)[activity] || {});
  const hideSub = activity === 'Hoisting' || (subKeys.length === 1 && (subKeys[0] === '' || subKeys[0] == null));

  // ✅ Correct: filter equipment IDs by CURRENT selected Activity, using type->activities map
  const filteredEquipment = useMemo(() => {
    return (equipmentRows || [])
      .filter((r) => (EQUIPMENT_ACTIVITY_MAP[r.type] || []).includes(activity))
      .map((r) => r.equipment_id)
      .sort((a, b) => a.localeCompare(b));
  }, [equipmentRows, activity]);

  return (
    <div className="min-h-screen flex flex-col">
      <Toast />
      <Header />
      <div className="p-4 max-w-2xl mx-auto w-full flex-1">
        {/* ✅ ONE CARD: main form + bolts inside for Dev GS/Rehab */}
        <div className="card space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium">Activity</label>
              <select className="input" value={activity} onChange={(e) => setActivity(e.target.value)}>
                {activityKeys.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </div>
            {!hideSub && (<div>
              <label className="block text-sm font-medium">Sub-Activity</label>
              <select className="input" value={sub} onChange={(e) => setSub(e.target.value)}>
                {subKeys.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </div>)}
          </div>

          <div className="space-y-3">
            {fields.map((f, idx) => {
              const rule = parseRule(f.input);
              const err = errors[f.field];
              const common = 'input';

              return (
                <div key={idx}>
                  <label className="block text-sm font-medium">
                    {f.field}
                    {f.required ? ' *' : ''}{' '}
                    {f.unit ? <span className="text-xs text-slate-500">({f.unit})</span> : null}
                  </label>

                  {/* ✅ Equipment select (filtered) + manual option always works */}
                  {rule.kind === 'select' && (rule as any).source === 'equipment' && (
                    <>
                      <select
                        className={common}
                        value={values[f.field] || ''}
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

                      {values[f.field] === '__manual__' && (
                        <input
                          className={`${common} mt-2`}
                          placeholder="Enter equipment"
                          value={values.__manual_equipment || ''}
                          onChange={(e) => setValues((v) => ({ ...v, __manual_equipment: e.target.value }))}
                        />
                      )}
                    </>
                  )}

                  {/* ✅ Location select + manual option */}
                  {rule.kind === 'select' && (rule as any).source === 'location' && (
                    <>
                      <select
                        className={common}
                        value={values[f.field] || ''}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            [f.field]: e.target.value,
                            ...(e.target.value !== '__manual__' ? { [`__manual_location_${f.field}`]: '' } : {}),
                          }))
                        }
                      >
                        <option value="">-</option>
                        {locationOptionsForField(f.field).map((o) => (
                          <option key={o.id || o.name} value={o.name}>
                            {o.name}
                          </option>
                        ))}
                        <option value="__manual__">Other (manual)</option>
                      </select>

                      {values[f.field] === '__manual__' && (
                        <input
                          className={`${common} mt-2`}
                          placeholder="Enter location"
                          value={(values as any)[`__manual_location_${f.field}`] || ''}
                          onChange={(e) => setValues((v) => ({ ...v, [`__manual_location_${f.field}`]: e.target.value }))}
                        />
                      )}
                    </>
                  )}

                  {rule.kind === 'select' && (rule as any).options && (
                    <select
                      className={common}
                      value={values[f.field] || ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    >
                      <option value="">-</option>
                      {(rule as any).options.map((o: string) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  )}

                  {rule.kind === 'number' && (
                    <input
                      className={common}
                      inputMode="decimal"
                      placeholder={f.unit ? `Unit: ${f.unit}` : ''}
                      value={values[f.field] || ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    />
                  )}

                  {rule.kind !== 'select' && rule.kind !== 'number' && (
                    <input
                      className={common}
                      value={values[f.field] || ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    />
                  )}

                  {err && <div className="text-red-600 text-xs mt-1">{err}</div>}
                </div>
              );
            })}
          </div>

          {/* ✅ Bolts inside the card (white background) */}
          {activity === 'Development' && (sub === 'Rehab' || sub === 'Ground Support') && (
            <div className="pt-4 border-t">
              <h3 className="text-sm font-semibold mb-3">Bolts</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-2">
                    <div className="text-xs font-semibold">Bolt {i + 1}</div>

                    <div>
                      <label className="block text-xs font-medium mb-1">Bolt Length (m)</label>
                      <select
                        className="input"
                        value={boltInputs[i].length}
                        onChange={(e) => {
                          const val = e.target.value;
                          setBoltInputs((prev) =>
                            prev.map((b, j) =>
                              j === i ? { ...b, length: val, lengthOther: val === 'Other' ? b.lengthOther : '' } : b,
                            ),
                          );
                        }}
                      >
                        <option value="">-</option>
                        <option value="1.8m">1.8</option>
                        <option value="2.4m">2.4</option>
                        <option value="3.0m">3.0</option>
                        <option value="6.0m">6.0</option>
                        <option value="Other">Other</option>
                      </select>

                      {boltInputs[i].length === 'Other' && (
                        <input
                          className="input mt-1"
                          type="number"
                          step="0.1"
                          min="0"
                          placeholder="Enter length (m)"
                          value={boltInputs[i].lengthOther}
                          onChange={(e) => {
                            const val = e.target.value;
                            setBoltInputs((prev) => prev.map((b, j) => (j === i ? { ...b, lengthOther: val } : b)));
                          }}
                        />
                      )}
                    </div>

                    <div>
                      <label className="block text-xs font-medium mb-1">Bolt Type</label>
                      <select
                        className="input"
                        value={boltInputs[i].type}
                        onChange={(e) => {
                          const val = e.target.value;
                          setBoltInputs((prev) => prev.map((b, j) => (j === i ? { ...b, type: val } : b)));
                        }}
                      >
                        <option value="">-</option>
                        <option value="Friction">Friction</option>
                        <option value="Mechanical">Mechanical</option>
                        <option value="Resin">Resin</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium mb-1">No. of Bolts</label>
                      <input
                        className="input"
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        value={boltInputs[i].count}
                        onChange={(e) => {
                          const val = e.target.value;
                          setBoltInputs((prev) => prev.map((b, j) => (j === i ? { ...b, count: val } : b)));
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 left-0 right-0 bg-white border-t">
        <div className="max-w-2xl mx-auto p-4 flex gap-2">
          <button className="btn btn-primary flex-1" onClick={finishTask} disabled={!canFinish}>
            FINISH TASK
          </button>
          <a className="btn flex-1 text-center" href="/Shift">
            BACK
          </a>
        </div>
      </div>
    </div>
  );
}