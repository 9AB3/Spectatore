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

  // Production drilling hole-entry capture (metres/cleanouts/redrills)
  const [pdHoles, setPdHoles] = useState<Record<ProdDrillBucket, DrillHole[]>>({
    'Metres Drilled': [],
    'Cleanouts Drilled': [],
    Redrills: [],
  });
  const [pdModal, setPdModal] = useState<null | { bucket: ProdDrillBucket }>(null);
  const [countModal, setCountModal] = useState<null | { field: string }>(null);
  const [pdLastDiameter, setPdLastDiameter] = useState<string>('102mm');

// Hauling: allow per-load weights
const [haulSameWeight, setHaulSameWeight] = useState<boolean>(true);
const [haulDefaultWeight, setHaulDefaultWeight] = useState<string>('');
const [haulLoadCount, setHaulLoadCount] = useState<string>('');
const [haulLoads, setHaulLoads] = useState<Array<{ weight: string }>>([]);


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

    // Loading: allow bucket fields to be blank/zero, but require at least ONE bucket value > 0.
    // (Meta fields like Equipment/Source/From/To/Location still behave as required.)
    const isLoadingBucketField = (field: string, inputRule: string) => {
      if (activity !== 'Loading') return false;
      // Only relax validation for numeric bucket inputs.
      const rule = parseRule(inputRule);
      if (rule.kind !== 'number') return false;
      const meta = new Set(['Equipment', 'Location', 'Source', 'From', 'To', 'Material']);
      return !meta.has(String(field || ''));
    };

    // Helper: compute hauling loads even if user hasn't pressed Apply
    const computedHaulLoads = (() => {
      if (activity !== 'Hauling') return [] as Array<{ weight: number }>;

      // Prefer explicit per-load entries
      const explicit = (haulLoads || [])
        .map((l) => ({ weight: Number(String(l.weight || '').replace(/[^0-9.]/g, '')) }))
        .filter((l) => Number.isFinite(l.weight) && l.weight > 0);
      if (explicit.length) return explicit;

      // If same-weight mode is enabled, derive from the two inputs (no Apply required)
      if (haulSameWeight) {
        const c = Number(String(haulLoadCount || '').replace(/[^0-9]/g, ''));
        const w = Number(String(haulDefaultWeight || '').replace(/[^0-9.]/g, ''));
        if (Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0) {
          return Array.from({ length: c }, () => ({ weight: w }));
        }
      }

      // Back-compat legacy fallback
      const c = Number(String((values as any)['Trucks'] ?? '').replace(/[^0-9]/g, ''));
      const w = Number(String((values as any)['Weight'] ?? '').replace(/[^0-9.]/g, ''));
      if (Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0) {
        return Array.from({ length: c }, () => ({ weight: w }));
      }
      return [];
    })();

    for (const f of fields) {
      const v = values[f.field];
      const rule = parseRule(f.input);
      if (f.required && (v === undefined || v === null || v === '')) {
        // Loading: bucket fields are optional individually (we enforce "at least one > 0" below)
        if (isLoadingBucketField(f.field, f.input)) {
          continue;
        }
        // Hauling: Trucks/Weight are derived from the Truck Loads editor, not direct fields
        if (activity === 'Hauling' && (f.field === 'Trucks' || f.field === 'Weight')) {
          continue;
        }
        // Production Drilling: allow submit if ANY of the three totals is entered (handled below)
        if (
          activity === 'Production Drilling' &&
          (f.field === 'Metres Drilled' || f.field === 'Cleanouts Drilled' || f.field === 'Redrills')
        ) {
          continue;
        }
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

    // Hauling: enforce load-based requirements (even though the raw Trucks/Weight fields are hidden)
    if (activity === 'Hauling') {
      const trucks = computedHaulLoads.length;
      const totalW = computedHaulLoads.reduce((acc, l) => acc + (Number(l.weight) || 0), 0);

      if (!trucks) e['Trucks'] = 'Add at least 1 load';
      if (!totalW) e['Weight'] = 'Enter load weight';

      // Also validate the same-weight inputs if user is in that mode and hasn't provided usable values
      if (haulSameWeight && !computedHaulLoads.length) {
        const c = Number(String(haulLoadCount || '').replace(/[^0-9]/g, ''));
        const w = Number(String(haulDefaultWeight || '').replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(c) || c <= 0) e['Trucks'] = 'Enter number of loads';
        if (!Number.isFinite(w) || w <= 0) e['Weight'] = 'Enter weight per load';
      }
    }

    return e;
  }, [fields, values, activity, haulLoads, haulSameWeight, haulLoadCount, haulDefaultWeight]);

  const canFinish = (() => {
    const pdFields = new Set(['Metres Drilled', 'Cleanouts Drilled', 'Redrills']);

    const isLoadingBucketField = (f: { field: string; input: string; required?: boolean }) => {
      if (activity !== 'Loading') return false;
      const rule = parseRule(f.input);
      if (rule.kind !== 'number') return false;
      const meta = new Set(['Equipment', 'Location', 'Source', 'From', 'To', 'Material']);
      return !meta.has(String(f.field || ''));
    };

    // Hauling: treat Trucks/Weight as satisfied if the Truck Loads editor yields valid loads
    const haulOk = (() => {
      if (activity !== 'Hauling') return true;
      // Any errors (including our custom Trucks/Weight errors) should block submit
      if (Object.keys(errors).length) return false;

      // If same-weight mode is enabled, allow without pressing Apply by using the two inputs
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

    const baseOk =
      Object.keys(errors).length === 0 &&
      fields.every((f) => {
        // For Production Drilling, these three totals are derived from holes and should NOT block submit individually
        if (activity === 'Production Drilling' && pdFields.has(f.field)) return true;
        // For Loading, bucket fields are optional individually (we enforce "at least one > 0" below)
        if (isLoadingBucketField(f as any)) return true;
        // For Hauling, Trucks/Weight are derived from the Truck Loads editor and should not block here
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

    // Loading: require at least one bucket input > 0 (zeros allowed elsewhere)
    if (activity === 'Loading') {
      const bucketFields = fields.filter((f) => isLoadingBucketField(f as any));
      if (!bucketFields.length) return true;
      const anyPos = bucketFields.some((f) => {
        const raw = values[f.field];
        const n = Number(String(raw ?? '').replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(n) && n > 0;
      });
      return anyPos;
    }

    return true;
  })();


  // Keep Production Drilling totals in sync with hole entries
  useEffect(() => {
    if (activity !== 'Production Drilling') return;
    const m = sumHoleLen(pdHoles['Metres Drilled']);
    const c = sumHoleLen(pdHoles['Cleanouts Drilled']);
    const r = sumHoleLen(pdHoles['Redrills']);
    setValues((v) => ({ ...v, 'Metres Drilled': m || '', 'Cleanouts Drilled': c || '', Redrills: r || '' }));
  }, [activity, pdHoles]);

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

      
// Build payload (supports hauling per-load weights)
let payloadToSave: any;
if (activity === 'Production Drilling') {
  payloadToSave = { activity, sub, values: baseValues, holes: pdHoles };
} else if (activity === 'Hauling') {
  let loads: Array<{ weight: number }> = [];
  // Prefer explicit per-load entries
  if (haulLoads.length) {
    loads = haulLoads
      .map((l) => ({ weight: Number(String(l.weight || '').replace(/[^0-9.]/g, '')) }))
      .filter((l) => Number.isFinite(l.weight) && l.weight > 0);
  }
  // If "same weight" is enabled and the user provided a count/weight, generate loads.
  if (!loads.length && haulSameWeight) {
    const c = Number(String(haulLoadCount || '').replace(/[^0-9]/g, ''));
    const w = Number(String(haulDefaultWeight || '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0) {
      loads = Array.from({ length: c }, () => ({ weight: w }));
    }
  }
  // Back-compat fallback if legacy Trucks/Weight fields are used
  if (!loads.length) {
    const c = Number(String((baseValues as any)['Trucks'] ?? '').replace(/[^0-9]/g, ''));
    const w = Number(String((baseValues as any)['Weight'] ?? '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0) {
      loads = Array.from({ length: c }, () => ({ weight: w }));
    }
  }

  const trucks = loads.length;
  const totalW = loads.reduce((acc, l) => acc + (Number(l.weight) || 0), 0);

  // Production hauling is always ore (Material dropdown is not shown).
  if (String(sub).toLowerCase() === 'production' && !('Material' in (baseValues as any))) {
    (baseValues as any).Material = 'Ore';
  }

  payloadToSave = {
    activity,
    sub,
    values: {
      ...baseValues,
      // Store a truck count for quick filtering in older views
      Trucks: trucks,
      // Store per-truck weight if using "same weight" (otherwise omit)
      ...(haulSameWeight && trucks && haulDefaultWeight
        ? { Weight: Number(String(haulDefaultWeight).replace(/[^0-9.]/g, '')) }
        : {}),
      // Useful to show in some totals panels
      'Tonnes Hauled': totalW,
    },
    loads,
  };
} else {
  payloadToSave = { activity, sub, values: baseValues };
}

await db.add('activities', {
  payload: payloadToSave,
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
              <select className="input" value={activity} onChange={(e) => {
                      const next = e.target.value;
                      setActivity(next);
                      if (next !== 'Hauling') {
                        setHaulLoads([]);
                        setHaulDefaultWeight('');
                        setHaulLoadCount('');
                        setHaulSameWeight(true);
                      }
                    }}>
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

              

// Hauling: replace legacy Trucks/Weight inputs with per-load weights editor
if (activity === 'Hauling' && f.field === 'Weight') {
  return null;
}
if (activity === 'Hauling' && f.field === 'Trucks') {
  const totalW = haulLoads.reduce((acc, l) => acc + (Number(String(l.weight||'').replace(/[^0-9.]/g,'')) || 0), 0);
  const haulErr = errors['Trucks'] || errors['Weight'];
  return (
    <div key={idx} className="p-3 rounded-xl border border-slate-200 bg-slate-50">
      <div className="flex items-center justify-between gap-3">
        <div className="font-semibold">Truck Loads</div>
        <div className="text-xs opacity-70">
          {haulLoads.length} loads • {Math.round(totalW)} t
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={haulSameWeight}
          onChange={(e) => setHaulSameWeight(e.target.checked)}
        />
        <span className="text-sm">Same weight for all loads</span>
      </div>

      {haulSameWeight ? (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className="block text-xs font-medium opacity-80">No. of loads</label>
            <input
              className="input"
              inputMode="numeric"
              value={haulLoadCount}
              onChange={(e) => setHaulLoadCount(e.target.value)}
              placeholder="e.g. 8"
            />
          </div>
          <div>
            <label className="block text-xs font-medium opacity-80">Weight per load (t)</label>
            <input
              className="input"
              inputMode="decimal"
              value={haulDefaultWeight}
              onChange={(e) => setHaulDefaultWeight(e.target.value)}
              placeholder="e.g. 50"
            />
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
          <button
            type="button"
            className="btn"
            onClick={() => setHaulLoads((prev) => [...prev, { weight: '' }])}
          >
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
                    onChange={(e) =>
                      setHaulLoads((prev) =>
                        prev.map((x, xi) => (xi === i ? { ...x, weight: e.target.value } : x)),
                      )
                    }
                    placeholder="Weight (t)"
                  />
                  <button
                    type="button"
                    className="px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50"
                    onClick={() => setHaulLoads((prev) => prev.filter((_, xi) => xi !== i))}
                  >
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

      <div className="mt-2 text-xs opacity-70">
        Tip: if you leave this empty, the app will fall back to legacy Trucks/Weight fields (if present).
      </div>

      {haulErr ? (
        <div className="mt-2 text-sm text-red-600">
          {haulErr}
        </div>
      ) : null}
    </div>
  );
}

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
                    activity === 'Production Drilling' &&
                    (f.field === 'Metres Drilled' || f.field === 'Cleanouts Drilled' || f.field === 'Redrills') ? (
                      <div className="flex flex-col gap-1">
                        <input
                          className={common}
                          readOnly
                          value={String(values[f.field] ?? '')}
                          placeholder="0"
                        />
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setPdModal({ bucket: f.field as ProdDrillBucket })}
                        >
                          Add holes
                        </button>
                      </div>
                    ) : activity === 'Loading' && ['Stope to Truck','Stope to SP','SP to Truck','SP to SP','Heading to Truck','Heading to SP'].includes(f.field) ? (
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
                        className={common}
                        inputMode="decimal"
                        placeholder={f.unit ? `Unit: ${f.unit}` : ''}
                        value={values[f.field] || ''}
                        onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
                      />
                    )
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

      
      {countModal ? (
        <div
          className="fixed inset-0 bg-black/40 flex items-start justify-center p-4 z-[1000] overflow-auto pt-6 pb-24"
          onClick={() => setCountModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white shadow-xl border border-slate-200 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">Buckets</div>
                <div className="text-xs opacity-70">{countModal.field}</div>
              </div>
              <button
                type="button"
                className="w-9 h-9 flex items-start justify-center rounded-xl border border-slate-200 hover:bg-slate-50"
                onClick={() => setCountModal(null)}
                aria-label="Close"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                className="w-14 h-14 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 text-2xl font-semibold"
                onClick={() => {
                  const f = countModal.field;
                  const cur = Math.max(0, parseInt(String(values[f] ?? 0), 10) || 0);
                  const next = Math.max(0, cur - 1);
                  setValues((v) => ({ ...v, [f]: String(next) }));
                }}
              >
                −
              </button>

              <input
                className="w-full h-14 text-center rounded-2xl border border-slate-200 text-2xl font-semibold"
                inputMode="numeric"
                pattern="[0-9]*"
                value={String(values[countModal.field] ?? 0)}
                onChange={(e) => {
                  const f = countModal.field;
                  const raw = String(e.target.value || '').replace(/[^0-9]/g, '');
                  setValues((v) => ({ ...v, [f]: raw === '' ? '0' : raw }));
                }}
              />

              <button
                type="button"
                className="w-14 h-14 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 text-2xl font-semibold"
                onClick={() => {
                  const f = countModal.field;
                  const cur = Math.max(0, parseInt(String(values[f] ?? 0), 10) || 0);
                  const next = cur + 1;
                  setValues((v) => ({ ...v, [f]: String(next) }));
                }}
              >
                +
              </button>
            </div>

            <div className="mt-4">
              <button type="button" className="btn w-full" onClick={() => setCountModal(null)}>
                Done
              </button>
              <div className="mt-2 text-xs opacity-70 text-center">
                Tip: you can tap the number and type as well.
              </div>
            </div>
          </div>
        </div>
      ) : null}

{pdModal ? (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-[1000] p-3 overflow-auto pt-6 pb-24">
          <div className="bg-white w-full max-w-md sm:max-w-2xl rounded-2xl shadow-xl border p-3 sm:p-4">
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
                <thead className="bg-slate-50 border-b">
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
                        <button type="button" aria-label="Delete hole" title="Delete hole" className="w-8 h-8 flex items-start justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50" onClick={() => { setPdHoles((prev) => { const arr = [...(prev[pdModal.bucket] || [])]; arr.splice(i, 1); return { ...prev, [pdModal.bucket]: arr }; }); }}>✕</button>
                      </td>
                    </tr>
                  ))}

                  {(pdHoles[pdModal.bucket] || []).length === 0 ? (
                    <tr>
                      <td className="p-3 text-sm opacity-70" colSpan={5}>
                        No holes added yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-2 mt-3">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPdHoles((prev) => {
                    const bucket = pdModal.bucket;
                    const arr = [...(prev[bucket] || [])];
                    arr.push({
                      ring_id: '',
                      hole_id: '',
                      diameter: pdLastDiameter || '102mm',
                      diameter_other: '',
                      length_m: '',
                    });
                    return { ...prev, [bucket]: arr };
                  });
                }}
              >
                + Add hole
              </button>

              <div className="text-sm">
                Total: <b>{sumHoleLen(pdHoles[pdModal.bucket] || []).toFixed(1)}</b> m
              </div>

              <button type="button" className="btn btn-primary" onClick={() => setPdModal(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="sticky bottom-0 left-0 right-0 bg-white border-t bottom-0 left-0 right-0 bg-white border-t">
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
