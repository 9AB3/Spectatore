import Header from '../components/Header';
import data from '../data/activities.json';
import { useEffect, useMemo, useState } from 'react';
import { getDB } from '../lib/idb';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';
import { loadEquipment, loadLocations } from '../lib/datalists';

/**
 * Authoritative equipment → activity mapping
 */
const EQUIPMENT_ACTIVITY_MAP: Record<string, string[]> = {
  Truck: ['Hauling'],
  Loader: ['Loading'],
  Jumbo: ['Development'],
  'Production Drill': ['Production Drilling'],
  'Spray Rig': ['Development'],
  Agi: ['Development'],
  'Charge Rig': ['Charging'],
};

type Field = { field: string; required: number; unit: string; input: string };

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

function equipmentAllowedForActivity(type: string, activity: string) {
  return EQUIPMENT_ACTIVITY_MAP[type]?.includes(activity) ?? false;
}

export default function Activity() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const activityKeys = Object.keys(data);
  const [activity, setActivity] = useState<string>(activityKeys[0] || '');
  const [sub, setSub] = useState<string>('');
  const [fields, setFields] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [equipmentList, setEquipmentList] = useState<string[]>([]);
  const [locationList, setLocationList] = useState<string[]>([]);

  const [boltInputs, setBoltInputs] = useState<
    { length: string; lengthOther: string; type: string; count: string }[]
  >([
    { length: '', lengthOther: '', type: '', count: '' },
    { length: '', lengthOther: '', type: '', count: '' },
    { length: '', lengthOther: '', type: '', count: '' },
  ]);

  // Load equipment/location lists
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');
      const uid = session?.user_id || 0;

      const eq = await loadEquipment(uid);
      const loc = await loadLocations(uid);

      setEquipmentList(eq);
      setLocationList(loc);
    })();
  }, []);

  // Auto-pick first sub-activity
  useEffect(() => {
    const group: any = (data as any)[activity] || {};
    const subKeys = Object.keys(group);
    setSub(subKeys.length ? subKeys[0] : '');
  }, [activity]);

  // Regenerate fields
  useEffect(() => {
    const group: any = (data as any)[activity] || {};
    const list: Field[] = group ? group[sub] || group[''] || [] : [];

    const filtered =
      activity === 'Development' && (sub === 'Rehab' || sub === 'Ground Support')
        ? list.filter((f) => !['Bolt Length', 'Bolt Type', 'No. of Bolts'].includes(f.field))
        : list;

    setFields(filtered);
    setValues({});
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
    fields.every((f) => !f.required || values[f.field] !== undefined);

  async function finishTask() {
    if (!canFinish) {
      setMsg('Please complete required fields');
      return;
    }

    const db = await getDB();
    const shift =
      (await db.get('shift', 'current')) ||
      JSON.parse(localStorage.getItem('spectatore-shift') || '{}');
    const session = await db.get('session', 'auth');

    await db.add('activities', {
      payload: { activity, sub, values },
      shiftDate: shift?.date,
      dn: shift?.dn,
      user_id: session?.user_id,
      ts: Date.now(),
    });

    setMsg('task saved successfully');
    setTimeout(() => nav('/Shift'), 500);
  }

  const filteredEquipment = equipmentList.filter((e) =>
    equipmentAllowedForActivity(e, activity),
  );

  return (
    <div className="min-h-screen flex flex-col">
      <Toast />
      <Header />

      <div className="p-4 max-w-2xl mx-auto w-full flex-1">
        <div className="card space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium">Activity</label>
              <select
                className="input"
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
              >
                {activityKeys.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium">Sub-Activity</label>
              <select className="input" value={sub} onChange={(e) => setSub(e.target.value)}>
                {Object.keys((data as any)[activity] || {}).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-3">
            {fields.map((f, idx) => {
              const rule = parseRule(f.input);
              const err = errors[f.field];
              return (
                <div key={idx}>
                  <label className="block text-sm font-medium">
                    {f.field}
                    {f.required ? ' *' : ''}{' '}
                    {f.unit && <span className="text-xs text-slate-500">({f.unit})</span>}
                  </label>

                  {rule.kind === 'select' && rule.source === 'equipment' && (
                    <select
                      className="input"
                      value={values[f.field] || ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    >
                      <option value="">-</option>
                      {filteredEquipment.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                      <option value="__manual__">Other (manual)</option>
                    </select>
                  )}

                  {rule.kind === 'select' && rule.source === 'location' && (
                    <select
                      className="input"
                      value={values[f.field] || ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    >
                      <option value="">-</option>
                      {locationList.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  )}

                  {rule.kind === 'number' && (
                    <input
                      className="input"
                      value={values[f.field] || ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    />
                  )}

                  {rule.kind === 'text' && (
                    <input
                      className="input"
                      value={values[f.field] || ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                    />
                  )}

                  {err && <div className="text-red-600 text-xs mt-1">{err}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 bg-white border-t">
        <div className="max-w-2xl mx-auto p-4">
          <button className="btn btn-primary w-full" onClick={finishTask} disabled={!canFinish}>
            FINISH TASK
          </button>
        </div>
      </div>
    </div>
  );
}
