import Header from '../components/Header';
import data from '../data/activities.json';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDB } from '../lib/idb';
import { useLocation, useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';
import { loadEquipment, loadLocations } from '../lib/datalists';
import HaulingIcon from '../assets/activity-icons/Hauling.png';
import LoadingIcon from '../assets/activity-icons/Loading.png';
import DevelopmentIcon from '../assets/activity-icons/Development.png';
import ProductionDrillingIcon from '../assets/activity-icons/Production Drilling.png';
import ChargingIcon from '../assets/activity-icons/Charging.png';
import FiringIcon from '../assets/activity-icons/Firing.png';
import BackfillingIcon from '../assets/activity-icons/Backfilling.png';
import HoistingIcon from '../assets/activity-icons/Hoisting.png';


type Field = { field: string; required: number; unit: string; input: string };
type EquipRow = { id?: number; type: string; equipment_id: string; is_site_asset?: boolean; site?: string };
type LocationRow = { id?: number | string; name: string; type: 'Heading' | 'Stope' | 'Stockpile'; is_site_asset?: boolean; site?: string };

type ProdDrillBucket = 'Metres Drilled' | 'Cleanouts Drilled' | 'Redrills';
type DrillHole = {
  ring_id: string;
  hole_id: string;
  diameter: string; // e.g. "64mm" ... "254mm" or "other"
  diameter_other?: string;
  length_m: string; // controlled input; coerced on save
};

type BoltEntry = {
  length: string;
  lengthOther: string;
  type: string;
  count: string;
};

const HOLE_DIAMETER_OPTIONS = ['64mm', '76mm', '89mm', '102mm', '152mm', '203mm', '254mm', 'other'] as const;

// --- Smart manual entry helpers ---
// Normalizes a name/id so "Loader 1" matches "loader one", etc.
function normalizeAssetName(input: string) {
  const s = String(input || '').toLowerCase().trim();
  const withNums = s
    .replace(/\bone\b/g, '1')
    .replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4')
    .replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6')
    .replace(/\bseven\b/g, '7')
    .replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9')
    .replace(/\bten\b/g, '10');
  return withNums.replace(/[^a-z0-9]/g, '');
}

function smartFindMatch(input: string, candidates: string[]) {
  const n = normalizeAssetName(input);
  if (!n) return null;
  for (const c of candidates) {
    if (normalizeAssetName(c) === n) return c;
  }
  return null;
}

function normalizePayload(raw: any) {
  let p: any = raw;
  try {
    if (typeof p === 'string') p = JSON.parse(p);
  } catch {}
  if (p && typeof p === 'object' && p.payload && !p.activity) p = p.payload;

  const activity = String(p?.activity || '').trim();
  const sub = String(p?.sub ?? p?.sub_activity ?? p?.subActivity ?? '').trim();

  let values: any = p?.values;
  if (!values || typeof values !== 'object') values = p?.data && typeof p.data === 'object' ? p.data : null;
  if (!values) {
    values = {};
    if (p && typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) {
        if (['activity','sub','sub_activity','subActivity','values','data','holes','loads'].includes(k)) continue;
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') continue;
        (values as any)[k] = v as any;
      }
    }
  }

  return { activity, sub, values, holes: p?.holes, loads: p?.loads };
}


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
  Loader: ['Loading', 'Backfilling'],
  Jumbo: ['Development'],
  'Production Drill': ['Production Drilling'],
  'Spray Rig': ['Development'],
  Agi: ['Development'],
  'Charge Rig': ['Charging'],
};

type ActivityTile = { key: string; label: string; img?: string };

const ACTIVITY_TILES: Record<string, ActivityTile> = {
  Hauling: { key: 'Hauling', label: 'Hauling', img: HaulingIcon },
  Loading: { key: 'Loading', label: 'Loading', img: LoadingIcon },
  Development: { key: 'Development', label: 'Development', img: DevelopmentIcon },
  'Production Drilling': { key: 'Production Drilling', label: 'Production Drilling', img: ProductionDrillingIcon },
  Charging: { key: 'Charging', label: 'Charging', img: ChargingIcon },
  Firing: { key: 'Firing', label: 'Firing', img: FiringIcon },
  Backfilling: { key: 'Backfilling', label: 'Backfilling', img: BackfillingIcon },
  Hoisting: { key: 'Hoisting', label: 'Hoisting', img: HoistingIcon },
};

function tileForActivity(key: string): ActivityTile {
  return ACTIVITY_TILES[key] || { key, label: key };
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

  // Firing
  if (a === 'Firing') {
    if (s === 'Development') return ['Heading'];
    if (s === 'Production') return ['Stope'];
  }

  // Backfilling
  if (a === 'Backfilling') {
    // Backfilling is always placed "to" a stope.
    if (f === 'To' || f === 'Location') return ['Stope'];
    return ['Stope'];
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
  // Default: allow any (so we don't block other future forms)
  return ['Heading', 'Stope', 'Stockpile'];
}


export default function Activity() {
  const nav = useNavigate();
  const location = useLocation();
  const { setMsg, Toast } = useToast();
  const activityKeys = Object.keys(data);
  const [activity, setActivity] = useState<string>(activityKeys[0] || '');
  const [sub, setSub] = useState<string>('');
  const [pickerOpen, setPickerOpen] = useState<boolean>(true);

  // Edit mode (launched from ViewActivities)
  const editActivityId: number | null = Number.isFinite(Number((location as any)?.state?.editActivityId))
    ? Number((location as any).state.editActivityId)
    : null;
  const returnTo: string | null = typeof (location as any)?.state?.returnTo === 'string' ? (location as any).state.returnTo : null;

  // When hydrating an existing activity, we need to suppress the usual auto-sub + reset behaviors.
  const suppressAutoSubRef = useRef<boolean>(false);
  const suppressResetRef = useRef<boolean>(false);

  const [fields, setFields] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  // When editing an existing activity, we queue the saved values and apply them
  // after the form schema has been regenerated for the saved activity/sub.
  const [pendingHydrateValues, setPendingHydrateValues] = useState<Record<string, any> | null>(null);
  const [equipmentRows, setEquipmentRows] = useState<EquipRow[]>([]);
  const [locationList, setLocationList] = useState<LocationRow[]>([]);

  function locationOptionsForField(fieldName: string): LocationRow[] {
    const allowed = new Set<LocationRow['type']>(allowedLocationTypes(activity, sub, fieldName));
    return (locationList || []).filter((l) => allowed.has(l.type));
  }

  const isDevBolts = activity === 'Development' && (sub === 'Rehab' || sub === 'Ground Support');

  const devBoltLengthOptions = useMemo<string[]>(() => {
    if (!isDevBolts) return ['1.8m', '2.4m', '3.0m', '6.0m'];
    const group: any = (data as any)[activity] || {};
    const list: Field[] = group ? group[sub] || group[''] || [] : [];
    const f = (list || []).find((x) => x.field === 'Bolt Length');
    if (!f) return ['1.8m', '2.4m', '3.0m', '6.0m'];
    const rule = parseRule(f.input);
    const opts = (rule as any)?.options || [];
    return (opts.length ? opts : ['1.8m', '2.4m', '3.0m', '6.0m']).filter(Boolean);
  }, [activity, sub, isDevBolts]);

  const devBoltTypeOptions = useMemo<string[]>(() => {
    if (!isDevBolts) return ['Friction', 'Mechanical', 'Resin', 'Cable'];
    const group: any = (data as any)[activity] || {};
    const list: Field[] = group ? group[sub] || group[''] || [] : [];
    const f = (list || []).find((x) => x.field === 'Bolt Type');
    const rule = f ? parseRule(f.input) : null;
    const raw = ((rule as any)?.options || ['Friction', 'Mechanical', 'Resin']).filter(Boolean);
    const hasCable = raw.some((x: string) => String(x).toLowerCase() === 'cable');
    return hasCable ? raw : [...raw, 'Cable'];
  }, [activity, sub, isDevBolts]);

  const [boltInputs, setBoltInputs] = useState<BoltEntry[]>([
    { length: '', lengthOther: '', type: '', count: '' },
  ]);

  const [boltModalOpen, setBoltModalOpen] = useState<boolean>(false);
  const [shotcreteModalOpen, setShotcreteModalOpen] = useState<boolean>(false);

  // Production drilling hole-entry capture (metres/cleanouts/redrills)
  const [pdHoles, setPdHoles] = useState<Record<ProdDrillBucket, DrillHole[]>>({
    'Metres Drilled': [],
    'Cleanouts Drilled': [],
    Redrills: [],
  });
  const [pdModal, setPdModal] = useState<null | { bucket: ProdDrillBucket }>(null);
  const [countModal, setCountModal] = useState<null | { field: string }>(null);
  const [truckModal, setTruckModal] = useState<null | { trucksField: string; weightField: string }>(null);
  const [truckUseDefaultWeight, setTruckUseDefaultWeight] = useState<boolean>(true);
  const [truckWeightClickerMode, setTruckWeightClickerMode] = useState<boolean>(false);
  const [truckWeightDigit, setTruckWeightDigit] = useState<0 | 1>(0);
  const truckKeyCaptureRef = useRef<HTMLInputElement | null>(null);

  // Robust focus helper for bluetooth HID keypads (some browsers need a focused element).
  const focusTruckCapture = useCallback(() => {
    const el = truckKeyCaptureRef.current;
    if (!el) return;
    try {
      (el as any).focus?.({ preventScroll: true });
    } catch {
      el.focus();
    }
    window.requestAnimationFrame(() => {
      try {
        (el as any).focus?.({ preventScroll: true });
      } catch {
        el.focus();
      }
    });
    window.setTimeout(() => {
      try {
        (el as any).focus?.({ preventScroll: true });
      } catch {
        el.focus();
      }
    }, 50);
  }, []);

  const countKeyCaptureRef = useRef<HTMLInputElement | null>(null);


  // Bluetooth 2-key keyboard support:
  // When the loader bucket count modal is open, map:
  //   A = increment, B = decrement
  useEffect(() => {
    if (!countModal) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const key = (e.key || '').toLowerCase();
      if (key !== 'a' && key !== 'b') return;

      // Prevent the keystroke from typing into inputs or triggering browser shortcuts.
      e.preventDefault();
      e.stopPropagation();

      const f = countModal.field;
      setValues((v) => {
        const cur = Math.max(0, parseInt(String((v as any)[f] ?? 0), 10) || 0);
        const next = key === 'a' ? cur + 1 : Math.max(0, cur - 1);
        return { ...v, [f]: String(next) };
      });
    };

    // Use capture so we can intercept before focused inputs consume the key.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [countModal]);

  // Bluetooth 2-key keyboard support for hauling trucks keypad:
  // Default: A = +1 truck, B = −1 truck
  // When weight clicker mode is enabled: A increments selected digit (wrap 0-9), B toggles digit (tens/ones)
  useEffect(() => {
    if (!truckModal) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const key = (e.key || '').toLowerCase();
      if (key !== 'a' && key !== 'b') return;

      e.preventDefault();
      e.stopPropagation();

      const tf = truckModal.trucksField;
      const wf = truckModal.weightField;

      if (truckWeightClickerMode) {
        if (key === 'b') {
          setTruckWeightDigit((d) => (d === 0 ? 1 : 0));
          return;
        }

        // key === 'a' increments selected digit
        setValues((v) => {
          const raw = String((v as any)[wf] ?? '').replace(/[^0-9]/g, '');
          const num = Math.max(0, Math.min(99, parseInt(raw || '0', 10)));
          const tens = Math.floor(num / 10);
          const ones = num % 10;
          const nt = truckWeightDigit === 0 ? (tens + 1) % 10 : tens;
          const no = truckWeightDigit === 1 ? (ones + 1) % 10 : ones;
          const next = nt * 10 + no;
          return { ...v, [wf]: String(next) };
        });
        return;
      }

      // Trucks +/- mode
      setValues((v) => {
        const cur = Math.max(0, parseInt(String((v as any)[tf] ?? 0), 10) || 0);
        const next = key === 'a' ? cur + 1 : Math.max(0, cur - 1);
        const out: any = { ...v, [tf]: String(next) };
        if (truckUseDefaultWeight) {
          const wRaw = String((v as any)[wf] ?? '').trim();
          if (!wRaw) out[wf] = '0';
        }
        return out;
      });
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [truckModal, truckUseDefaultWeight, truckWeightClickerMode, truckWeightDigit]);


  // Auto-focus a hidden input so bluetooth key events are captured even if no visible input is focused.
  useEffect(() => {
    if (!countModal) return;
    const t = window.setTimeout(() => countKeyCaptureRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [countModal]);

  const [pdLastDiameter, setPdLastDiameter] = useState<string>('102mm');

// Hauling: allow per-load weights (+ optional timing)
// NOTE: timed loads may be paused/resumed via "Continue load".
// We record the wall-clock start when the user clicks "Start new load" and
// the latest wall-clock end whenever the user clicks "Dump load".
// If the user continues and dumps again, end_iso will be updated to the latest dump.
type HaulLoad = {
  id: string;
  weight: string;
  time_s: number | null; // active time accumulated by the timer (excludes paused time)
  kind: 'manual' | 'timed';
  start_iso?: string | null;
  end_iso?: string | null;
};

const mkHaulLoad = (
  kind: 'manual' | 'timed',
  weight: string,
  time_s: number | null = null,
  start_iso: string | null = null,
): HaulLoad => ({
  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  kind,
  weight,
  time_s,
  start_iso,
  end_iso: null,
});
const [haulSameWeight, setHaulSameWeight] = useState<boolean>(true);
const [haulDefaultWeight, setHaulDefaultWeight] = useState<string>('');
const [haulLoadCount, setHaulLoadCount] = useState<string>('');
const [haulLoads, setHaulLoads] = useState<HaulLoad[]>([]);
  const [haulLogTimesOpen, setHaulLogTimesOpen] = useState<boolean>(false);
  const [haulTimingRunning, setHaulTimingRunning] = useState<boolean>(false);
  const [haulTimingStartMs, setHaulTimingStartMs] = useState<number>(0);
  const [haulTimingNowMs, setHaulTimingNowMs] = useState<number>(0);
  const [haulTimingLoadIndex, setHaulTimingLoadIndex] = useState<number>(-1);
  const [haulTimingPaused, setHaulTimingPaused] = useState<boolean>(false);
  const [haulTimingElapsedS, setHaulTimingElapsedS] = useState<number>(0);

// Hauling clicker (Log Times) advanced mode:
// A starts a new load (timer) then becomes "weight +" while running (hold to ramp weight).
// B dumps the load (stops timer).
// Presets are controlled on the hauling form (default 60t max, 1t increments)
const [haulClickerWeightStep, setHaulClickerWeightStep] = useState<number>(1);
const [haulClickerWeightMax, setHaulClickerWeightMax] = useState<number>(60);

const [haulClickerSettingsOpen, setHaulClickerSettingsOpen] = useState<boolean>(false);
const [haulManualWeightOpen, setHaulManualWeightOpen] = useState<boolean>(false);
const [haulManualWeightDraft, setHaulManualWeightDraft] = useState<string>('');
const haulManualWeightHoldTimerRef = useRef<number | null>(null);
const haulWeightHoldIntervalRef = useRef<number | null>(null);
const haulWeightHoldingRef = useRef<boolean>(false);

// If user accidentally dumps a load, allow a quick "undo dump" (restart timer on the same load)
const [haulLastDumpedIndex, setHaulLastDumpedIndex] = useState<number>(-1);
const [haulLastDumpedAtMs, setHaulLastDumpedAtMs] = useState<number>(0);

// Edit-hydration helpers (prevents schema regeneration from wiping loaded values)
const editHydratingRef = useRef<boolean>(false);
const editHydrateTargetRef = useRef<{ activity: string; sub: string } | null>(null);



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
          .map((r) => ({ equipment_id: r.equipment_id, type: r.type, id: r.id, is_site_asset: !!r.is_site_asset, site: r.site }))
          .filter((r) => r.equipment_id && r.type),
      );

      // 2) refresh from network (also updates the IDB store)
      await loadEquipment(uid);

      // 3) re-read updated cache
      const db2 = await getDB();
      const updatedEq = (await db2.getAll('equipment')) as any[];
      setEquipmentRows(
        (updatedEq || [])
          .map((r) => ({ equipment_id: r.equipment_id, type: r.type, id: r.id, is_site_asset: !!r.is_site_asset, site: r.site }))
          .filter((r) => r.equipment_id && r.type),
      );

      const loc = await loadLocations(uid);
      setLocationList(loc);
    })();
  }, []);

  // Hydrate edit mode from IndexedDB
  useEffect(() => {
    if (!editActivityId) return;
    let cancelled = false;
    (async () => {
      try {
        const db = await getDB();
        const row: any = await db.get('activities', editActivityId);
        if (!row || cancelled) return;

        const norm = normalizePayload(row.payload || {});

        const nextActivity = String(norm.activity || '').trim();
        const nextSub = String(norm.sub || '').trim();

        suppressAutoSubRef.current = true;
        suppressResetRef.current = true;
        editHydratingRef.current = true;
        editHydrateTargetRef.current = { activity: nextActivity, sub: nextSub };

        if (nextActivity) setActivity(nextActivity);
        if (nextSub) setSub(nextSub);
        setPickerOpen(false);

        // Values (queued; applied after fields regenerate)
        setPendingHydrateValues({ ...(norm.values || {}) });

        // Production drilling holes
        if (String(norm.activity) === 'Production Drilling' && norm.holes && typeof norm.holes === 'object') {
          setPdHoles((prev) => ({
            ...prev,
            ...(norm.holes || {}),
          }));
        }

        // Hauling loads
        if (String(norm.activity) === 'Hauling') {
          const loads = Array.isArray(norm.loads) ? norm.loads : [];
          const mapped = loads
            .map((l: any) => ({
              weight: String(l?.weight ?? l?.Weight ?? ''),
              time_s: typeof l?.time_s === 'number' ? l.time_s : l?.time_s ?? null,
              kind: l?.kind || (typeof l?.time_s === 'number' ? 'timed' : 'manual'),
            }))
            .filter((l: any) => String(l.weight || '').trim() !== '');
          if (mapped.length) {
            setHaulLoads(mapped as any);
            // If all weights are equal, prefer "same weight" toggle so the UI is less noisy.
            const ws = mapped.map((x: any) => Number(String(x.weight || '').replace(/[^0-9.]/g, ''))).filter((n: any) => Number.isFinite(n));
            const allSame = ws.length > 0 && ws.every((n: number) => Math.abs(n - ws[0]) < 1e-9);
            if (allSame) {
              setHaulSameWeight(true);
              setHaulDefaultWeight(String(ws[0] || ''));
              setHaulLoadCount(String(mapped.length));
            } else {
              setHaulSameWeight(false);
              setHaulDefaultWeight('');
              setHaulLoadCount('');
            }
          }
        }
      } catch (e) {
        console.error('Failed to hydrate edit activity', e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editActivityId]);

  // When activity changes: auto-pick the first sub-activity
  useEffect(() => {
    if (suppressAutoSubRef.current) {
      suppressAutoSubRef.current = false;
      return;
    }
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
        ? list.filter((f) => !['Bolt Length', 'Bolt Type', 'No. of Bolts', 'Agi Volume', 'Spray Volume'].includes(f.field))
        : list;

    setFields(filtered);

    // During edit hydration we don't want this effect to wipe the saved values.
    // Note: changing activity + sub can trigger this effect twice; keep values intact until we
    // reach the intended activity/sub pair, then apply queued values once.
    const target = editHydrateTargetRef.current;
    const isHydrating = editHydratingRef.current && target;

    if (!isHydrating) {
      if (!suppressResetRef.current) {
        setValues({}); // reset form inputs for the new schema
      } else {
        suppressResetRef.current = false;
      }
    }

    if (pendingHydrateValues && target && activity === target.activity && sub === target.sub) {
      // Apply saved values once we have regenerated the correct schema.
      setValues(pendingHydrateValues);

      // If we're editing a Dev Rehab / Ground Support row, hydrate the bolt modal inputs
      // from the saved row so the user can adjust consumables in the modal.
      if (activity === 'Development' && (sub === 'Rehab' || sub === 'Ground Support')) {
        const v: any = pendingHydrateValues || {};
        const bl = String(v['Bolt Length'] ?? '').trim();
        const bt = String(v['Bolt Type'] ?? '').trim();
        const bc = v['No. of Bolts'] ?? '';
        if (bl || bt || bc) {
          // If the saved length isn't one of the dropdown options, treat it as "Other".
          const normLen = bl;
          const inOpts = devBoltLengthOptions.some((o) => String(o).trim() === normLen);
          const m = normLen.match(/^([0-9.]+)\s*m?$/i);
          const other = !inOpts && m ? String(m[1]) : !inOpts ? normLen.replace(/m$/i, '') : '';
          setBoltInputs([
            {
              length: inOpts ? normLen : normLen ? 'Other' : '',
              lengthOther: other || '',
              type: bt,
              count: bc !== '' && bc !== null && bc !== undefined ? String(bc) : '',
            },
          ]);
        }
      }

      // IMPORTANT: this effect depends on pendingHydrateValues, so clearing it will cause
      // the effect to run again. Without guarding, the "not hydrating" branch would reset
      // values back to {} on the next run. Set suppressResetRef to skip exactly one reset.
      suppressResetRef.current = true;

      setPendingHydrateValues(null);
      editHydratingRef.current = false;
      editHydrateTargetRef.current = null;
    }

    // Reset bolt modal inputs when changing activity/sub (but don't clobber edit hydration).
    if (!(pendingHydrateValues && target && activity === target.activity && sub === target.sub)) {
      setBoltInputs([{ length: '', lengthOther: '', type: '', count: '' }]);
    }
  }, [activity, sub, pendingHydrateValues]);

  // Bluetooth 2-key keyboard support for Hauling "Log Times":
//
// Default mode (legacy):
//   A = "Truck loaded" (start timer + create new load)
//   B = "Load dumped" (stop timer + attach elapsed time)
//
// Clicker-weight mode (recommended):
//   A when idle = start new load (timer) with weight=0
//   A while running = weight + (hold to ramp; wraps at max)
//   B = dump load (stop timer + attach elapsed time)
useEffect(() => {
  if (!haulLogTimesOpen) return;

  // NOTE: focusTruckCapture is defined above (useCallback) and reused here.

  const stopWeightHold = () => {
    haulWeightHoldingRef.current = false;
    if (haulWeightHoldIntervalRef.current) {
      window.clearInterval(haulWeightHoldIntervalRef.current);
      haulWeightHoldIntervalRef.current = null;
    }
  };

  const bumpWeight = () => {
    const idx = haulTimingLoadIndex;
    if (idx < 0) return;

    setHaulLoads((prev) => {
      if (idx < 0 || idx >= prev.length) return prev;
      const step = Number(haulClickerWeightStep) || 0.1;
      const max = Number(haulClickerWeightMax) || 10;

      return prev.map((l, i) => {
        if (i !== idx) return l;
        const cur = Math.max(0, Number(String((l as any).weight ?? '').replace(/[^0-9.]/g, '')) || 0);
        const nextRaw = cur + step;
        const next = nextRaw > max ? 0 : nextRaw;
        // Format with dp based on step (0dp if step is whole number, else 1dp).
        const dp = Number.isInteger(step) ? 0 : 1;
        const w = next.toFixed(dp);
        return { ...l, weight: w };
      });
    });
  };

  const startNewLoad = () => {
    // A in idle/paused: start a brand new load (finalize any paused load as-is).
    if (haulTimingRunning) return;

    // Starting a new load clears any undo/pause helper state
    setHaulLastDumpedIndex(-1);
    setHaulLastDumpedAtMs(0);

	    const start = Date.now();
	    const startIso = new Date(start).toISOString();
    setHaulTimingElapsedS(0);
    setHaulTimingStartMs(start);
    setHaulTimingNowMs(start);
    setHaulTimingRunning(true);
    setHaulTimingPaused(false);

	    setHaulLoads((prev) => {
      const weight =
        '0';
	      const next = [...prev, mkHaulLoad('timed', weight, null, startIso)];
      setHaulTimingLoadIndex(next.length - 1);
      return next;
    });

    window.setTimeout(() => focusTruckCapture(), 0);
  };

  const pauseLoad = () => {
    // B while running: pause timer in place (do not advance load index).
    if (!haulTimingRunning) return;

    stopWeightHold();

	                  const end = Date.now();
	                  const endIso = new Date(end).toISOString();
    const deltaS = Math.max(0, Math.round((end - haulTimingStartMs) / 1000));
    const elapsedS = Math.max(0, (haulTimingElapsedS || 0) + deltaS);
    const idx = haulTimingLoadIndex;

    setHaulTimingElapsedS(elapsedS);
    setHaulTimingRunning(false);
    setHaulTimingPaused(true);
    setHaulTimingStartMs(0);
    setHaulTimingNowMs(0);

	    // Persist the paused time + latest dump timestamp onto the load so the form list shows it immediately.
    setHaulLoads((prev) => {
      if (idx < 0 || idx >= prev.length) return prev;
	      return prev.map((l, i) => (i === idx ? { ...l, time_s: elapsedS, end_iso: endIso } : l));
    });

    // Keep focus for clicker
    window.setTimeout(() => focusTruckCapture(), 0);
  };

  const continueLoad = () => {
    // B while paused: resume timer from the paused position (same load index).
    if (!haulTimingPaused || haulTimingLoadIndex < 0) return;

    const start = Date.now();
    setHaulTimingStartMs(start);
    setHaulTimingNowMs(start);
    setHaulTimingRunning(true);
    setHaulTimingPaused(false);

    window.setTimeout(() => focusTruckCapture(), 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const key = (e.key || '').toLowerCase();
    if (key !== 'a' && key !== 'b') return;

    e.preventDefault();
    e.stopPropagation();

    // Clicker-weight mode
    if (key === 'a') {
      if (!haulTimingRunning) {
        startNewLoad();
        return;
      }

      // While running: treat A as "weight +" (hold to ramp)
      if (haulWeightHoldingRef.current) return;
      haulWeightHoldingRef.current = true;

      // immediate bump
      bumpWeight();

      // ramp while held
      haulWeightHoldIntervalRef.current = window.setInterval(() => bumpWeight(), 140);
      return;
    }

    // key === 'b'
    if (haulTimingRunning) return pauseLoad();
    if (haulTimingPaused) return continueLoad();
    return;
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const key = (e.key || '').toLowerCase();
if (key !== 'a') return;
    stopWeightHold();
  };

  // Use boolean capture arg to avoid subtle option-object mismatch on removeEventListener.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    stopWeightHold();
  };
}, [
  haulLogTimesOpen,
haulClickerWeightStep,
  haulClickerWeightMax,
  haulTimingRunning,
  haulTimingPaused,
  haulTimingElapsedS,
  haulTimingStartMs,
  haulTimingLoadIndex,
  haulSameWeight,
  haulDefaultWeight,
]);


  // Update the visible stopwatch while timing
  useEffect(() => {
    if (!haulLogTimesOpen || !haulTimingRunning) return;
    const id = window.setInterval(() => setHaulTimingNowMs(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [haulLogTimesOpen, haulTimingRunning]);

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
          return Array.from({ length: c }, () => ({ weight: w, time_s: null, kind: 'manual' }));
        }
      }

      // Back-compat legacy fallback
      const c = Number(String((values as any)['Trucks'] ?? '').replace(/[^0-9]/g, ''));
      const w = Number(String((values as any)['Weight'] ?? '').replace(/[^0-9.]/g, ''));
      if (Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0) {
        return Array.from({ length: c }, () => ({ weight: w, time_s: null, kind: 'manual' }));
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

    // Development (Rehab / Ground Support): bolt consumables and shotcrete are captured via modals
    // and therefore must be present even though their fields are hidden from the main schema.
    if (activity === 'Development' && (sub === 'Rehab' || sub === 'Ground Support')) {
      // Rule: you may submit with ZERO shotcrete OR ZERO bolt consumables, but not BOTH.
      // i.e., require at least one of (bolt count > 0) or (agi+spray > 0).

      // Validate bolt rows: only rows with count > 0 require type/length details.
      let boltTotal = 0;
      for (const b of (boltInputs || [])) {
        const cnt = Number(String(b.count || '').replace(/[^0-9]/g, ''));
        if (!Number.isFinite(cnt) || cnt <= 0) continue;
        const lenOk = !!String(b.length || '').trim() && (String(b.length) !== 'Other' || !!String(b.lengthOther || '').trim());
        const typeOk = !!String(b.type || '').trim();
        if (!lenOk || !typeOk) return false;
        boltTotal += cnt;
      }

      const agiRaw = (values as any)['Agi Volume'];
      const sprayRaw = (values as any)['Spray Volume'];
      const agi = Number(String(agiRaw ?? '0').replace(/[^0-9.\-]/g, ''));
      const spray = Number(String(sprayRaw ?? '0').replace(/[^0-9.\-]/g, ''));
      const agiOk = Number.isFinite(agi) && agi >= 0;
      const sprayOk = Number.isFinite(spray) && spray >= 0;
      if (!agiOk || !sprayOk) return false;

      const shotcreteTotal = (agiOk ? agi : 0) + (sprayOk ? spray : 0);

      // Disallow both being 0
      if (!(boltTotal > 0 || shotcreteTotal > 0)) return false;
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

    // Helper: add or update a single activity row
    const saveOne = async (payload: any) => {
      const base: any = {
        payload,
        shiftDate: shift?.date,
        dn: shift?.dn,
        user_id: session?.user_id,
        ts: Date.now(),
      };

      if (editActivityId) {
        await db.put('activities', { ...base, id: editActivityId });
      } else {
        await db.add('activities', base);
      }
    };

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
      .map((l) => ({
        weight: Number(String(l.weight || '').replace(/[^0-9.]/g, '')),
        time_s: (l as any)?.time_s ?? null,
	        start_iso: (l as any)?.start_iso ?? null,
	        end_iso: (l as any)?.end_iso ?? null,
        kind: (l as any)?.kind || (typeof (l as any)?.time_s === 'number' ? 'timed' : 'manual'),
      }))
      .filter((l) => Number.isFinite(l.weight) && l.weight > 0);
  }
  // If "same weight" is enabled and the user provided a count/weight, generate loads.
  if (!loads.length && haulSameWeight) {
    const c = Number(String(haulLoadCount || '').replace(/[^0-9]/g, ''));
    const w = Number(String(haulDefaultWeight || '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0) {
      loads = Array.from({ length: c }, () => ({ weight: w, time_s: null, kind: 'manual' }));
    }
  }
  // Back-compat fallback if legacy Trucks/Weight fields are used
  if (!loads.length) {
    const c = Number(String((baseValues as any)['Trucks'] ?? '').replace(/[^0-9]/g, ''));
    const w = Number(String((baseValues as any)['Weight'] ?? '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(c) && c > 0 && Number.isFinite(w) && w > 0) {
      loads = Array.from({ length: c }, () => ({ weight: w, time_s: null, kind: 'manual' }));
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

      await saveOne(payloadToSave);

    } else {
      // Rehab / Ground Support can create multiple rows when NEW.
      // When editing a single existing activity, keep it simple and just update that one row.
      if (editActivityId) {
        const valuesToSave = (() => {
          const v: any = { ...values };
          delete v.__manual_equipment;
          delete v.__manual_location;
          for (const k of Object.keys(v)) {
            if (k.startsWith('__manual_location_')) delete v[k];
          }

          // Persist bolt consumables from the modal into the saved row.
          // (This is critical for View Activities / Finalize + GS Drillm rollups.)
          const b = (boltInputs || [])[0] || null;
          if (b) {
            const cnt = Number(String((b as any).count || '').replace(/[^0-9]/g, ''));
            const type = String((b as any).type || '').trim();
            const len = String((b as any).length || '').trim();
            const lenOther = String((b as any).lengthOther || '').trim();
            const lengthValue = len === 'Other' ? (lenOther ? `${lenOther}m` : '') : (len ? len : '');

            if (lengthValue) v['Bolt Length'] = lengthValue;
            if (type) v['Bolt Type'] = type;
            if (Number.isFinite(cnt) && cnt > 0) v['No. of Bolts'] = cnt;
          }

          return v;
        })();
        await saveOne({ activity, sub, values: valuesToSave });
        setMsg('task saved successfully');
        setTimeout(() => nav(returnTo || '/ViewActivities'), 400);
        return;
      }

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
    setTimeout(() => nav(editActivityId ? (returnTo || '/ViewActivities') : '/Shift'), 500);
  }

  const subKeys = Object.keys((data as any)[activity] || {});
  const hideSub = activity === 'Hoisting' || (subKeys.length === 1 && (subKeys[0] === '' || subKeys[0] == null));

  // ✅ Correct: filter equipment IDs by CURRENT selected Activity, using type->activities map
  const filteredEquipment = useMemo<{ personal: string[]; site: string[] }>(() => {
    const rows = (equipmentRows || []).filter((r) => (EQUIPMENT_ACTIVITY_MAP[r.type] || []).includes(activity));

    const personal = rows
      .filter((r) => !r.is_site_asset)
      .map((r) => String(r.equipment_id || '').trim())
      .filter((x) => x)
      .sort((a, b) => a.localeCompare(b));

    const site = rows
      .filter((r) => !!r.is_site_asset)
      .map((r) => String(r.equipment_id || '').trim())
      .filter((x) => x)
      .sort((a, b) => a.localeCompare(b));

    const currentEquip = String((values as any)?.['Equipment'] || '').trim();
    const hasCurrent = !!currentEquip && [...personal, ...site].includes(currentEquip);

    return {
      personal: hasCurrent || !currentEquip ? personal : [currentEquip, ...personal],
      site,
    };
  }, [equipmentRows, activity, (values as any)?.['Equipment']]);

  const applyActivity = useCallback(
    (next: string) => {
      const k = String(next || '').trim();
      if (!k) return;

      setActivity(k);

      // Reset hauling-only state when leaving Hauling (matches previous dropdown behavior)
      if (k !== 'Hauling') {
        setHaulLoads([]);
        setHaulDefaultWeight('');
        setHaulLoadCount('');
        setHaulSameWeight(true);
      }

      // Auto-pick a valid sub-activity
      const nextSubKeys = Object.keys((data as any)[k] || {});
      const nextHideSub = k === 'Hoisting' || (nextSubKeys.length === 1 && (nextSubKeys[0] === '' || nextSubKeys[0] == null));
      if (nextHideSub) setSub('');
      else setSub(String(nextSubKeys[0] || ''));

      // Persist for Quick Actions
      try {
        localStorage.setItem(
          'spectatore-last-activity-state',
          JSON.stringify({ activity: k, sub: nextHideSub ? '' : String(nextSubKeys[0] || '') }),
        );
      } catch {}

      setPickerOpen(false);
    },
    [setActivity, setSub, setPickerOpen, setHaulLoads, setHaulDefaultWeight, setHaulLoadCount, setHaulSameWeight],
  );


  return (
    <div className="min-h-screen flex flex-col">
      <Toast />
      <Header />
      <div className="p-4 max-w-2xl mx-auto w-full flex-1">
        {/* ✅ ONE CARD: main form + bolts inside for Dev GS/Rehab */}
        {pickerOpen ? (
          <div className="card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs tv-muted font-semibold tracking-wide">NEW ACTIVITY</div>
                <div className="text-2xl font-extrabold">Pick what you’re doing</div>
                <div className="mt-1 text-sm tv-muted">Swipe/scroll to browse. Tap a tile to start.</div>
              </div>
              <button
                type="button"
                className="tv-pill"
                onClick={() => {
                  if (activity) nav('/Shift');
                  else nav('/Shift');
                }}
              >
                {activity ? 'Close' : 'Back'}
              </button>
            </div>

            {/* Quick Actions */}
            {(() => {
              let last: any = null;
              try {
                last = JSON.parse(localStorage.getItem('spectatore-last-activity-state') || 'null');
              } catch {}
              if (!last?.activity) return null;
              const t = tileForActivity(String(last.activity));
              const desired = String(last.sub || '');
              return (
                <div className="mt-5">
                  <div className="text-xs tv-muted font-semibold tracking-wide mb-2">QUICK ACTIONS</div>
                  <div className="flex gap-4 overflow-x-auto pb-2">
                    <button
                      type="button"
                      className="tv-tile min-w-[220px] md:min-w-[260px] text-left hover:brightness-[1.03]"
                      onClick={() => {
                        applyActivity(String(last.activity));
                        if (desired) window.setTimeout(() => setSub(desired), 0);
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-16 h-16 rounded-2xl tv-surface/10 border border-white/15 flex items-center justify-center overflow-hidden">
                          {t.img ? <img src={t.img} alt={t.label} className="w-full h-full object-contain p-2" /> : null}
                        </div>
                        <div>
                          <div className="text-sm tv-muted font-semibold">Last used</div>
                          <div className="text-lg font-extrabold">{t.label}</div>
                          {desired ? <div className="text-xs tv-muted mt-1">{desired}</div> : null}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Activity tiles */}
            <div className="mt-6">
              <div className="text-xs tv-muted font-semibold tracking-wide mb-2">ACTIVITIES</div>
              <div className="flex gap-4 overflow-x-auto pb-2">
                {activityKeys.map((k) => {
                  const t = tileForActivity(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      className="tv-tile min-w-[220px] md:min-w-[260px] text-left hover:brightness-[1.03]"
                      onClick={() => applyActivity(k)}
                    >
                      <div className="flex flex-col items-center text-center gap-3">
                        <div className="w-full h-32 md:h-36 rounded-2xl tv-surface/10 border border-white/15 flex items-center justify-center overflow-hidden">
                          {t.img ? (
                            <img src={t.img} alt={t.label} className="w-full h-full object-contain p-4" />
                          ) : (
                            <div className="tv-muted text-sm">No image</div>
                          )}
                        </div>
                        <div className="w-full">
                          <div className="text-lg font-extrabold leading-tight">{t.label}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="card space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs tv-muted font-semibold tracking-wide">ACTIVITY</div>
                <div className="text-lg font-extrabold">{activity}</div>
              </div>
              <button type="button" className="tv-pill" onClick={() => setPickerOpen(true)}>
                Change
              </button>
            </div>

            {!hideSub && (
              <div>
                <label className="block text-sm font-medium">Sub-Activity</label>
                <select className="input" value={sub} onChange={(e) => setSub(e.target.value)}>
                  {subKeys.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </div>
            )}

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
  const totalW = haulLoads.reduce((acc, l) => acc + (Number(String(l.weight || '').replace(/[^0-9.]/g, '')) || 0), 0);
  const haulErr = errors['Trucks'] || errors['Weight'];
  const fmtTime = (ts: any) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
    const mm = String(Math.floor(ts / 60)).padStart(2, '0');
    const ss = String(ts % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  return (
    <div key={idx} className="p-3 rounded-xl border tv-surface tv-border">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold">Truck Loads</div>
          <div className="text-xs opacity-70">{haulLoads.length} loads • {Math.round(totalW)} t</div>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setHaulLogTimesOpen(true);
            setHaulTimingRunning(false);
            setHaulTimingLoadIndex(-1);
            setHaulTimingStartMs(0);
            setHaulTimingNowMs(0);
            window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
          }}
        >
          Log Times
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input type="checkbox" checked={haulSameWeight} onChange={(e) => setHaulSameWeight(e.target.checked)} />
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

                // Keep any timed loads, but rebuild the manual-load block
                setHaulLoads((prev) => {
                  const timed = prev.filter((l) => l.kind === 'timed');
                  const manual = Array.from({ length: c }, () => mkHaulLoad('manual', String(w), null));
                  return [...timed, ...manual];
                });
              }}
            >
              Apply
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <button type="button" className="btn" onClick={() => setHaulLoads((prev) => [...prev, mkHaulLoad('manual', '')])}>
            + Add truck
          </button>
        </div>
      )}

      {/* Load list on the form (truck #, weight, time) */}
      <div className="mt-3 rounded-xl border overflow-hidden tv-surface tv-border">
        <div className="px-3 py-2 border-b text-sm font-semibold tv-border">Loads</div>
        {haulLoads.length ? (
          <div className="divide-y divide-slate-100">
            {haulLoads.map((l, i) => (
              <div key={(l as any).id || i} className="px-3 py-2 flex items-center gap-2">
                <div className="w-10 text-sm font-bold tabular-nums">#{i + 1}</div>
                <input
                  className="input flex-1"
                  inputMode="decimal"
                  value={String(l.weight ?? '')}
                  onChange={(e) => setHaulLoads((prev) => prev.map((x, xi) => (xi === i ? { ...x, weight: e.target.value } : x)))}
                  placeholder="Weight (t)"
                />
                <div className="w-20 text-right text-sm tabular-nums text-[var(--text)]">
                  {fmtTime((l as any).time_s) || <span className="text-[var(--muted)]">—</span>}
                </div>
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl border tv-surface tv-border hover:brightness-[1.03]"
                  onClick={() => {
                    const id = (l as any).id;
                    if (haulTimingRunning) {
                      setHaulTimingRunning(false);
                      setHaulTimingLoadIndex(-1);
                      setHaulTimingStartMs(0);
                      setHaulTimingNowMs(0);
                    }
                    setHaulLoads((prev) => prev.filter((x, xi) => (id ? (x as any).id !== id : xi !== i)));
                  }}
                  aria-label="Delete load"
                  title="Delete load"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-3 text-xs tv-muted">No loads yet. Use “Log Times” or “+ Add truck”.</div>
        )}
      </div>

      {haulErr ? <div className="mt-2 text-sm text-red-600">{haulErr}</div> : null}
    </div>
  );
}

              return (
                <div key={idx}>
                  <label className="block text-sm font-medium">
                    {f.field}
                    {f.required ? ' *' : ''}{' '}
                    {f.unit ? <span className="text-xs tv-muted">({f.unit})</span> : null}
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
                        {filteredEquipment.personal.map((o: string) => (
                          <option key={`p-${o}`} value={o}>
                            {o}
                          </option>
                        ))}
                        {filteredEquipment.site.length > 0 && (
                          <optgroup label="────────── Site">
                            {filteredEquipment.site.map((o: string) => (
                              <option key={`s-${o}`} value={o}>
                                {o}  [Site]
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <option value="__manual__">Other (manual)</option>
                      </select>

                      {values[f.field] === '__manual__' && (
                        <input
                          className={`${common} mt-2`}
                          placeholder="Enter equipment"
                          value={values.__manual_equipment || ''}
                          onChange={(e) => setValues((v) => ({ ...v, __manual_equipment: e.target.value }))}
                          onBlur={() => {
                            const typed = String(values.__manual_equipment || '').trim();
                            const match = smartFindMatch(typed, [...filteredEquipment.personal, ...filteredEquipment.site]);
                            if (match) {
                              setValues((v) => ({ ...v, [f.field]: match, __manual_equipment: '' }));
                            }
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') {
                              (ev.target as HTMLInputElement).blur();
                            }
                          }}
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
                        {(() => {
                          const opts = (locationOptionsForField(f.field) as any[]) || [];
                          const cur = String(values[f.field] || '').trim();
                          const has = cur && opts.some((x: any) => String(x?.name || '').trim() === cur);
                          const base = has || !cur ? opts : ([{ id: '__current__', name: cur, type: '' }, ...opts] as any);

                          const personal = [...base]
                            .filter((x: any) => !x?.is_site_asset && !x?.__divider)
                            .sort((a: any, b: any) => String(a?.name || '').localeCompare(String(b?.name || '')));

                          const site = [...base]
                            .filter((x: any) => !!x?.is_site_asset && !x?.__divider)
                            .sort((a: any, b: any) => String(a?.name || '').localeCompare(String(b?.name || '')));

                          const merged = site.length
                            ? [...personal, { id: '__divider__', __divider: true, name: '────────── Site', type: '' }, ...site]
                            : personal;

                          return merged;
                        })().map((o: any) =>
                          o?.__divider ? (
                            <option key="__divider__" value="" disabled>
                              {o.name}
                            </option>
                          ) : (
                            <option key={o.id || o.name} value={o.name}>
                              {o.name}
                              {o.is_site_asset ? '  [Site]' : ''}
                            </option>
                          ),
                        )}
                        <option value="__manual__">Other (manual)</option>
                      </select>

                      {values[f.field] === '__manual__' && (
                        <input
                          className={`${common} mt-2`}
                          placeholder="Enter location"
                          value={(values as any)[`__manual_location_${f.field}`] || ''}
                          onChange={(e) => setValues((v) => ({ ...v, [`__manual_location_${f.field}`]: e.target.value }))}
                          onBlur={() => {
                            const typed = String((values as any)[`__manual_location_${f.field}`] || '').trim();
                            const opts = ((locationOptionsForField(f.field) as any[]) || []).map((x: any) => String(x?.name || '').trim()).filter(Boolean);
                            const match = smartFindMatch(typed, opts);
                            if (match) {
                              setValues((v) => ({ ...v, [f.field]: match, [`__manual_location_${f.field}`]: '' }));
                            }
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') {
                              (ev.target as HTMLInputElement).blur();
                            }
                          }}
                        />
                      )}

                      {isDevBolts && f.field === 'Location' && (
                        <div className="mt-3 flex flex-col gap-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setBoltModalOpen(true)}
                            >
                              Bolt Consumables
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setShotcreteModalOpen(true)}
                            >
                              Shotcrete
                            </button>
                          </div>

                          <div className="text-xs opacity-70">
                            {(() => {
                              const cnt = (boltInputs || []).reduce((acc, b) => acc + (Number(String(b.count || '').replace(/[^0-9]/g, '')) || 0), 0);
                              const groups = (boltInputs || []).filter((b) => {
                                const c = Number(String(b.count || '').replace(/[^0-9]/g, '')) || 0;
                                return c > 0;
                              }).length;
                              const agi = (values as any)['Agi Volume'];
                              const spray = (values as any)['Spray Volume'];
                              const hasShot = (agi !== undefined && agi !== null && String(agi) !== '') || (spray !== undefined && spray !== null && String(spray) !== '');
                              return (
                                <div className="flex flex-col gap-1">
                                  <div>
                                    Bolts: <b>{cnt}</b>{groups ? ` across ${groups} entries` : ''}
                                  </div>
                                  <div>
                                    Shotcrete: <b>{hasShot ? `${String(agi || 0)} m3 AGI, ${String(spray || 0)} m3 Spray` : 'not set'}</b>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
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
                    ) : activity === 'Hauling' && f.field === 'Trucks' ? (
                      <button
                        type="button"
                        className="input text-left flex items-center justify-between"
                        onClick={() => {
                          setTruckWeightClickerMode(false);
                          setTruckWeightDigit(0);
                          setTruckUseDefaultWeight(true);
                          setTruckModal({ trucksField: 'Trucks', weightField: 'Weight' });
                          // focus capture target on next tick
                          window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                        }}
                      >
                        <span className="opacity-70">Tap to count</span>
                        <span className="font-semibold">{String(values['Trucks'] ?? 0)} trucks</span>
                      </button>
                    ) : ((activity === 'Loading' && ['Stope to Truck','Stope to SP','SP to Truck','SP to SP','Heading to Truck','Heading to SP'].includes(f.field)) || (activity === 'Backfilling' && sub === 'Underground' && f.field === 'Buckets')) ? (
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

          {/* Development Rehab / Ground Support capture bolt consumables + shotcrete via modals (buttons under Location) */}
        </div>
        )}
      </div>

      {countModal ? (
        <div className="fixed inset-0 z-[1000] bg-black/85" onPointerDown={(e) => {
          // Keep a focus target active so bluetooth key events are captured.
          // If the user taps into the number input, let them type normally.
          const el = e.target as HTMLElement | null;
          const isEditingNumber = !!el && (el.tagName === 'INPUT' || el.getAttribute?.('data-edit-buckets') === '1');
          if (!isEditingNumber) countKeyCaptureRef.current?.focus();
        }}>
          <div className="w-full h-full flex flex-col">
            {/* Hidden focus target so bluetooth key events are captured without tapping the number */}
            <input
              ref={countKeyCaptureRef}
              autoFocus
              inputMode="none"
              readOnly
              aria-hidden="true"
              tabIndex={-1}
              className="absolute opacity-0 w-px h-px -left-[9999px] -top-[9999px]"
            />

            <div className="p-4 flex items-center justify-between">
              <div className="text-white">
                <div className="text-base font-bold">{countModal.field}</div>
                <div className="text-xs opacity-80">Bluetooth keys: A = +1, B = −1</div>
              </div>

              <button
                type="button"
                className="w-11 h-11 flex items-center justify-center rounded-2xl bg-white/10 text-white border border-white/15 hover:bg-white/15"
                onClick={() => setCountModal(null)}
                aria-label="Close"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 flex items-center justify-center px-4">
              <div className="w-full max-w-md">
                <input
                  data-edit-buckets="1"
                  className="w-full bg-transparent text-center text-white font-extrabold leading-none outline-none"
                  style={{ fontSize: '96px' }}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  type="text"
                  value={String(values[countModal.field] ?? '')}
                  placeholder="0"
                  onChange={(e) => {
                    const f = countModal.field;
                    // allow blank while editing
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setValues((v) => ({ ...v, [f]: raw }));
                  }}
                  onBlur={() => {
                    const f = countModal.field;
                    setValues((v) => {
                      const cur = parseInt(String((v as any)[f] ?? 0), 10);
                      const next = Number.isFinite(cur) ? Math.max(0, cur) : 0;
                      return { ...v, [f]: String(next) };
                    });
                    // return focus to capture input after manual typing
                    window.setTimeout(() => countKeyCaptureRef.current?.focus(), 0);
                  }}
                />

                <div className="mt-6 flex gap-4">
                  <button
                    type="button"
                    className="flex-1 h-20 rounded-3xl bg-white text-slate-900 text-4xl font-extrabold shadow-xl active:translate-y-[1px]"
                    onClick={() => {
                      const f = countModal.field;
                      const cur = Math.max(0, parseInt(String(values[f] ?? 0), 10) || 0);
                      const next = Math.max(0, cur - 1);
                      setValues((v) => ({ ...v, [f]: String(next) }));
                      // keep focus so keys keep working
                      countKeyCaptureRef.current?.focus();
                    }}
                  >
                    −
                  </button>

                  <button
                    type="button"
                    className="flex-1 h-20 rounded-3xl bg-white text-slate-900 text-4xl font-extrabold shadow-xl active:translate-y-[1px]"
                    onClick={() => {
                      const f = countModal.field;
                      const cur = Math.max(0, parseInt(String(values[f] ?? 0), 10) || 0);
                      const next = cur + 1;
                      setValues((v) => ({ ...v, [f]: String(next) }));
                      countKeyCaptureRef.current?.focus();
                    }}
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  className="mt-5 w-full h-14 rounded-2xl bg-white/10 text-white border border-white/15 font-bold hover:bg-white/15"
                  onClick={() => setCountModal(null)}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}


{haulLogTimesOpen ? (
  <div
    className="fixed inset-0 z-[1002] bg-black/90"
    onPointerDown={(e) => {
      const el = e.target as HTMLElement | null;
      const isEditing = !!el && (el.tagName === 'INPUT' || el.getAttribute?.('data-edit-haul') === '1');
      if (!isEditing) window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
    }}
  >
    <div className="absolute inset-0 flex flex-col p-4">
      <div className="flex items-center justify-between">
        <div className="text-white">
          <div className="text-xs opacity-75">Hauling · Log Times</div>
          <div className="text-xs opacity-60">Clicker: A = start new (idle/paused) or weight + (hold while running), B = Dump/Continue</div>
        </div>

        <button
          type="button"
          className="w-20 h-11 rounded-2xl tv-surface/10 text-white border border-white/15 hover:tv-surface/15 font-bold"
          onClick={() => {
            // Before closing, persist any running timer onto the active load so the form shows time.
            if (haulTimingRunning && haulTimingLoadIndex >= 0) {
              const end = Date.now();
	              const endIso = new Date(end).toISOString();
              const deltaS = Math.max(0, Math.round((end - haulTimingStartMs) / 1000));
              const elapsedS = Math.max(0, (haulTimingElapsedS || 0) + deltaS);
              const idx = haulTimingLoadIndex;

	    setHaulLoads((prev) => {
	      if (idx < 0 || idx >= prev.length) return prev;
	      return prev.map((l, i) => (i === idx ? { ...l, time_s: elapsedS, end_iso: endIso } : l));
	    });
            }

            setHaulLogTimesOpen(false);

            // Reset active timing state (loads remain)
            setHaulTimingRunning(false);
            setHaulTimingPaused(false);
            setHaulTimingElapsedS(0);
            setHaulTimingLoadIndex(-1);
            setHaulTimingStartMs(0);
            setHaulTimingNowMs(0);

            // stop any hold
            haulWeightHoldingRef.current = false;
            if (haulWeightHoldIntervalRef.current) {
              window.clearInterval(haulWeightHoldIntervalRef.current);
              haulWeightHoldIntervalRef.current = null;
            }
          }}
        >
          Done
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-2xl rounded-3xl tv-surface border tv-border p-6 shadow-2xl">
          {/* Load number */}
          <div className="text-center">
            <div className="tv-muted text-sm font-semibold tracking-wide">LOAD</div>
            <div className="text-6xl md:text-7xl font-extrabold tabular-nums">
              {(haulTimingRunning || haulTimingPaused) && haulTimingLoadIndex >= 0 ? haulTimingLoadIndex + 1 : haulLoads.length + 1}
            </div>
          </div>

          {/* Stopwatch */}
          <div className="mt-6 text-center">
            <div className="tv-muted text-sm font-semibold tracking-wide">TIME</div>
            <div className="mt-2 text-[80px] md:text-[110px] leading-none font-extrabold tabular-nums">
              {haulTimingRunning
                ? (() => {
                    const ms = Math.max(0, (haulTimingNowMs || Date.now()) - haulTimingStartMs);
                    const s = Math.max(0, (haulTimingElapsedS || 0) + Math.floor(ms / 1000));
                    const mm = String(Math.floor(s / 60)).padStart(2, '0');
                    const ss = String(s % 60).padStart(2, '0');
                    return `${mm}:${ss}`;
                  })()
                : haulTimingPaused && haulTimingLoadIndex >= 0
                  ? (() => {
                      const s = Math.max(0, haulTimingElapsedS || 0);
                      const mm = String(Math.floor(s / 60)).padStart(2, '0');
                      const ss = String(s % 60).padStart(2, '0');
                      return `${mm}:${ss}`;
                    })()
                  : '00:00'}
            </div>
          </div>
          {/* Weight */}
          <div className="mt-6 text-center select-none">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                className="w-20 h-20 md:w-24 md:h-24 rounded-3xl tv-surface/10 border border-white/15 text-[color:var(--text)] text-3xl md:text-4xl font-extrabold shadow active:translate-y-[1px] disabled:opacity-40"
                disabled={!haulTimingRunning || haulTimingLoadIndex < 0}
                onPointerDown={() => {
                  if (!haulTimingRunning || haulTimingLoadIndex < 0) return;
                  if (haulWeightHoldingRef.current) return;
                  haulWeightHoldingRef.current = true;

                  const idx = haulTimingLoadIndex;
                  const bump = () => {
                    setHaulLoads((prev) =>
                      prev.map((l, i) => {
                        if (i !== idx) return l;
                        const step = Number(haulClickerWeightStep) || 1;
                        const cur = Math.max(0, Number(String((l as any).weight ?? '').replace(/[^0-9.]/g, '')) || 0);
                        const next = Math.max(0, cur - step);
                        const dp = Number.isInteger(step) ? 0 : 1;
                        return { ...l, weight: next.toFixed(dp) };
                      }),
                    );
                  };

                  bump();
                  haulWeightHoldIntervalRef.current = window.setInterval(() => bump(), 140);
                }}
                onPointerUp={() => {
                  haulWeightHoldingRef.current = false;
                  if (haulWeightHoldIntervalRef.current) {
                    window.clearInterval(haulWeightHoldIntervalRef.current);
                    haulWeightHoldIntervalRef.current = null;
                  }
                }}
                onPointerCancel={() => {
                  haulWeightHoldingRef.current = false;
                  if (haulWeightHoldIntervalRef.current) {
                    window.clearInterval(haulWeightHoldIntervalRef.current);
                    haulWeightHoldIntervalRef.current = null;
                  }
                }}
              >
                −
              </button>

              <div className="flex-1">
                <div className="tv-muted text-sm font-semibold tracking-wide flex items-center justify-center gap-2">
                  WEIGHT (t)
                  <button
                    type="button"
                    className="px-3 py-1 rounded-xl tv-surface/10 text-[color:var(--text)] border border-white/15 text-xs font-bold"
                    onClick={() => setHaulClickerSettingsOpen(true)}
                  >
                    Clicker weight increments
                  </button>
                </div>

                <div
                  className="mt-2 text-[70px] md:text-[95px] leading-none font-extrabold tabular-nums cursor-pointer"
                  data-edit-haul="1"
                  onPointerDown={() => {
                    if (!haulTimingRunning || haulTimingLoadIndex < 0) return;
                    // press-and-hold to manually set weight (timer continues running)
                    if (haulManualWeightHoldTimerRef.current) return;
                    haulManualWeightHoldTimerRef.current = window.setTimeout(() => {
                      haulManualWeightHoldTimerRef.current = null;
                      const cur =
                        haulTimingLoadIndex >= 0 && haulTimingLoadIndex < haulLoads.length
                          ? String((haulLoads[haulTimingLoadIndex] as any)?.weight ?? '0')
                          : '0';
                      setHaulManualWeightDraft(cur);
                      setHaulManualWeightOpen(true);
                    }, 600) as any;
                  }}
                  onPointerUp={() => {
                    if (haulManualWeightHoldTimerRef.current) {
                      window.clearTimeout(haulManualWeightHoldTimerRef.current);
                      haulManualWeightHoldTimerRef.current = null;
                    }
                  }}
                  onPointerCancel={() => {
                    if (haulManualWeightHoldTimerRef.current) {
                      window.clearTimeout(haulManualWeightHoldTimerRef.current);
                      haulManualWeightHoldTimerRef.current = null;
                    }
                  }}
                >
                  {(haulTimingRunning || haulTimingPaused) && haulTimingLoadIndex >= 0 && haulTimingLoadIndex < haulLoads.length
                    ? String((haulLoads[haulTimingLoadIndex] as any)?.weight ?? '0')
                    : '0'}
                </div>

                <div className="mt-2 text-xs tv-muted">
                  Tap +/- to adjust while running. Hold the number to set manually.
                </div>
              </div>

              <button
                type="button"
                className="w-20 h-20 md:w-24 md:h-24 rounded-3xl tv-surface/10 border border-white/15 text-[color:var(--text)] text-3xl md:text-4xl font-extrabold shadow active:translate-y-[1px] disabled:opacity-40"
                disabled={!haulTimingRunning || haulTimingLoadIndex < 0}
                onPointerDown={() => {
                  if (!haulTimingRunning || haulTimingLoadIndex < 0) return;
                  if (haulWeightHoldingRef.current) return;
                  haulWeightHoldingRef.current = true;

                  const idx = haulTimingLoadIndex;
                  const bump = () => {
                    setHaulLoads((prev) =>
                      prev.map((l, i) => {
                        if (i !== idx) return l;
                        const step = Number(haulClickerWeightStep) || 1;
                        const max = Number(haulClickerWeightMax) || 60;
                        const cur = Math.max(0, Number(String((l as any).weight ?? '').replace(/[^0-9.]/g, '')) || 0);
                        const nextRaw = cur + step;
                        const next = nextRaw > max ? 0 : nextRaw;
                        const dp = Number.isInteger(step) ? 0 : 1;
                        return { ...l, weight: next.toFixed(dp) };
                      }),
                    );
                  };

                  bump();
                  haulWeightHoldIntervalRef.current = window.setInterval(() => bump(), 140);
                }}
                onPointerUp={() => {
                  haulWeightHoldingRef.current = false;
                  if (haulWeightHoldIntervalRef.current) {
                    window.clearInterval(haulWeightHoldIntervalRef.current);
                    haulWeightHoldIntervalRef.current = null;
                  }
                }}
                onPointerCancel={() => {
                  haulWeightHoldingRef.current = false;
                  if (haulWeightHoldIntervalRef.current) {
                    window.clearInterval(haulWeightHoldIntervalRef.current);
                    haulWeightHoldIntervalRef.current = null;
                  }
                }}
              >
                +
              </button>
            </div>
          </div>

          {/* Main action */}

          <div className="mt-8">
            {/* Running: show pause; weight adjust happens via holding A (clicker) or press-and-hold on WEIGHT */}
            {haulTimingRunning ? (
              <button
                type="button"
                className="btn w-full h-20 md:h-24 rounded-3xl text-2xl md:text-4xl font-extrabold shadow-xl"
                onClick={() => {
                  // Pause load (do not advance load number)
                  haulWeightHoldingRef.current = false;
                  if (haulWeightHoldIntervalRef.current) {
                    window.clearInterval(haulWeightHoldIntervalRef.current);
                    haulWeightHoldIntervalRef.current = null;
                  }

                  const end = Date.now();
                  const endIso = new Date(end).toISOString();
                  const deltaS = Math.max(0, Math.round((end - haulTimingStartMs) / 1000));
                  const elapsedS = Math.max(0, (haulTimingElapsedS || 0) + deltaS);
                  const idx = haulTimingLoadIndex;

                  setHaulTimingElapsedS(elapsedS);
                  setHaulTimingRunning(false);
                  setHaulTimingPaused(true);
                  setHaulTimingStartMs(0);
                  setHaulTimingNowMs(0);

	                  setHaulLoads((prev) => {
	                    if (idx < 0 || idx >= prev.length) return prev;
	                    return prev.map((l, i) => (i === idx ? { ...l, time_s: elapsedS, end_iso: endIso } : l));
	                  });

                  window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                }}
              >
                Dump load
              </button>
            ) : null}

            {/* Idle: only start new load */}
            {!haulTimingRunning && !haulTimingPaused ? (
              <button
                type="button"
                className="btn w-full h-20 md:h-24 rounded-3xl text-2xl md:text-4xl font-extrabold shadow-xl"
                onClick={() => {
	                  const start = Date.now();
	                  const startIso = new Date(start).toISOString();
                  setHaulTimingElapsedS(0);
                  setHaulTimingStartMs(start);
                  setHaulTimingNowMs(start);
                  setHaulTimingRunning(true);
                  setHaulTimingPaused(false);

	                  setHaulLoads((prev) => {
                    const weight = '0';
	                    const next = [...prev, mkHaulLoad('timed', weight, null, startIso)];
                    setHaulTimingLoadIndex(next.length - 1);
                    return next;
                  });

                  window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                }}
              >
                Start new load
              </button>
            ) : null}

            {/* Paused: offer Continue or Start New */}
            {!haulTimingRunning && haulTimingPaused ? (
              <div className="grid grid-cols-1 gap-3">
                <button
                  type="button"
                  className="btn w-full h-20 md:h-24 rounded-3xl text-2xl md:text-4xl font-extrabold shadow-xl"
                  onClick={() => {
                    const start = Date.now();
                    setHaulTimingStartMs(start);
                    setHaulTimingNowMs(start);
                    setHaulTimingRunning(true);
                    setHaulTimingPaused(false);
                    window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                  }}
                >
                  Continue load
                </button>

                <button
                  type="button"
                  className="w-full h-16 md:h-20 rounded-3xl tv-surface border border-white/15 text-[color:var(--text)] text-2xl md:text-3xl font-extrabold shadow active:translate-y-[1px]"
                  onClick={() => {
                    // Finalize paused load as-is, and start a new one immediately
	                    const start = Date.now();
	                    const startIso = new Date(start).toISOString();
                    setHaulTimingElapsedS(0);
                    setHaulTimingStartMs(start);
                    setHaulTimingNowMs(start);
                    setHaulTimingRunning(true);
                    setHaulTimingPaused(false);

	                    setHaulLoads((prev) => {
                      const weight = '0';
	                      const next = [...prev, mkHaulLoad('timed', weight, null, startIso)];
                      setHaulTimingLoadIndex(next.length - 1);
                      return next;
                    });

                    window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                  }}
                >
                  Start new load
                </button>
              </div>
            ) : null}
          </div>


          
          {/* Clicker settings overlay */}
          {haulClickerSettingsOpen ? (
            <div className="fixed inset-0 z-[1100] bg-black/70 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded-3xl tv-surface p-5 shadow-2xl">
                <div className="text-lg font-extrabold">Clicker weight increments</div>
                <div className="mt-1 text-sm tv-muted">Set the step and max. A-button ramp and +/- use these values.</div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold tv-muted">Increment (t)</label>
                    <input
                      className="input"
                      inputMode="decimal"
                      value={String(haulClickerWeightStep)}
                      onChange={(e) => setHaulClickerWeightStep(Number(e.target.value || 1))}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold tv-muted">Max (t)</label>
                    <input
                      className="input"
                      inputMode="decimal"
                      value={String(haulClickerWeightMax)}
                      onChange={(e) => setHaulClickerWeightMax(Number(e.target.value || 60))}
                    />
                  </div>
                </div>

                <button
                  type="button"
                  className="mt-5 w-full h-14 rounded-2xl btn font-extrabold text-lg active:translate-y-[1px]"
                  onClick={() => {
                    setHaulClickerSettingsOpen(false);
                    window.setTimeout(() => focusTruckCapture(), 0);
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          ) : null}

          {/* Manual weight input overlay (press-and-hold weight) */}
          {haulManualWeightOpen ? (
            <div className="fixed inset-0 z-[1100] bg-black/70 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded-3xl tv-surface p-5 shadow-2xl">
                <div className="text-lg font-extrabold">Set weight (t)</div>
                <div className="mt-1 text-sm tv-muted">Timer keeps running — enter the weight then save.</div>

                <input
                  className="input mt-4 text-2xl font-extrabold"
                  inputMode="decimal"
                  value={haulManualWeightDraft}
                  onChange={(e) => setHaulManualWeightDraft(e.target.value)}
                  autoFocus
                  data-edit-haul="1"
                />

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    className="h-14 rounded-2xl tv-surface border border-white/15 font-extrabold text-lg active:translate-y-[1px]"
                    onClick={() => {
                      setHaulManualWeightOpen(false);
                      window.setTimeout(() => focusTruckCapture(), 0);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="h-14 rounded-2xl btn font-extrabold text-lg active:translate-y-[1px]"
                    onClick={() => {
                      const idx = haulTimingLoadIndex;
                      if (!haulTimingRunning || idx < 0) {
                        setHaulManualWeightOpen(false);
                        return;
                      }
                      const step = Number(haulClickerWeightStep) || 1;
                      const max = Number(haulClickerWeightMax) || 60;
                      let v = Number(String(haulManualWeightDraft || '').replace(/[^0-9.]/g, ''));
                      if (!Number.isFinite(v)) v = 0;
                      v = Math.max(0, Math.min(max, v));
                      const dp = Number.isInteger(step) ? 0 : 1;

                      setHaulLoads((prev) =>
                        prev.map((l, i) => (i === idx ? { ...l, weight: v.toFixed(dp) } : l)),
                      );

                      setHaulManualWeightOpen(false);
                      window.setTimeout(() => focusTruckCapture(), 0);
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : null}
<div className="mt-4 text-center text-xs tv-muted">
            Exit to see the load list on the hauling form.
          </div>
        </div>
      </div>

      <input
        ref={truckKeyCaptureRef}
        autoFocus
        inputMode="none"
        readOnly
        tabIndex={-1}
        className="absolute opacity-0 w-px h-px -left-[9999px] -top-[9999px]"
        aria-hidden="true"
      />
    </div>
  </div>
) : null}


{truckModal ? (
        <div
          className="fixed inset-0 z-[1001] bg-black/85"
          onPointerDown={(e) => {
            const el = e.target as HTMLElement | null;
            const isEditing = !!el && (el.tagName === 'INPUT' || el.getAttribute?.('data-edit-trucks') === '1' || el.getAttribute?.('data-edit-weight') === '1');
            if (!isEditing) truckKeyCaptureRef.current?.focus();
          }}
        >
          {/* Hidden focus target so bluetooth key events are captured without tapping */}
          <input
            ref={truckKeyCaptureRef}
            autoFocus
            inputMode="none"
            readOnly
            aria-hidden="true"
            tabIndex={-1}
            className="absolute opacity-0 w-px h-px -left-[9999px] -top-[9999px]"
          />

          <div className="w-full h-full flex flex-col">
            <div className="p-4 flex items-center justify-between">
              <div className="text-white">
                <div className="text-base font-bold">Trucks</div>
                <div className="text-xs opacity-80">
                  {truckWeightClickerMode ? 'Weight clicker mode: A = rotate digit, B = switch digit' : 'Bluetooth keys: A = +1, B = −1'}
                </div>
              </div>

              <button
                type="button"
                className="w-11 h-11 flex items-center justify-center rounded-2xl bg-white/10 text-white border border-white/15 hover:bg-white/15"
                onClick={() => setTruckModal(null)}
                aria-label="Close"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center px-4 pb-6">
              <div className="w-full max-w-md">
                <input
                  data-edit-trucks="1"
                  className="w-full bg-transparent text-center text-white font-extrabold leading-none outline-none"
                  style={{ fontSize: '84px' }}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  type="text"
                  value={String(values[truckModal.trucksField] ?? '')}
                  placeholder="0"
                  onChange={(e) => {
                    const tf = truckModal.trucksField;
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setValues((v) => ({ ...v, [tf]: raw }));
                  }}
                  onFocus={() => setTruckWeightClickerMode(false)}
                  onBlur={() => {
                    const tf = truckModal.trucksField;
                    setValues((v) => {
                      const cur = parseInt(String((v as any)[tf] ?? 0), 10);
                      const next = Number.isFinite(cur) ? Math.max(0, cur) : 0;
                      return { ...v, [tf]: String(next) };
                    });
                    window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                  }}
                />
                <div className="mt-1 text-center text-white/80 text-sm font-semibold">trucks</div>

                <div className="mt-6 flex gap-4">
                  <button
                    type="button"
                    className="flex-1 h-20 rounded-3xl bg-white text-black text-4xl font-extrabold shadow-xl active:translate-y-[1px]"
                    onClick={() => {
                      const tf = truckModal.trucksField;
                      const cur = Math.max(0, parseInt(String(values[tf] ?? 0), 10) || 0);
                      const next = Math.max(0, cur - 1);
                      setValues((v) => ({ ...v, [tf]: String(next) }));
                      window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                    }}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="flex-1 h-20 rounded-3xl bg-white text-black text-4xl font-extrabold shadow-xl active:translate-y-[1px]"
                    onClick={() => {
                      const tf = truckModal.trucksField;
                      const cur = Math.max(0, parseInt(String(values[tf] ?? 0), 10) || 0);
                      const next = cur + 1;
                      setValues((v) => ({ ...v, [tf]: String(next) }));
                      window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                    }}
                  >
                    +
                  </button>
                </div>

                <div className="mt-6 p-4 rounded-3xl bg-white/10 border border-white/15">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-white font-bold">Default weight</div>
                    <label className="flex items-center gap-2 text-white/90 text-sm">
                      <input
                        type="checkbox"
                        checked={truckUseDefaultWeight}
                        onChange={(e) => setTruckUseDefaultWeight(e.target.checked)}
                      />
                      Use when counting
                    </label>
                  </div>

                  <div className="mt-3 flex items-center gap-3">
                    <input
                      data-edit-weight="1"
                      className="flex-1 input text-center text-lg font-bold"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      type="text"
                      value={String(values[truckModal.weightField] ?? '')}
                      placeholder="Weight (t)"
                      onChange={(e) => {
                        const wf = truckModal.weightField;
                        const raw = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
                        setValues((v) => ({ ...v, [wf]: raw }));
                      }}
                      onFocus={() => {
                        // If the user wants to edit weight manually, disable clicker mode automatically.
                        setTruckWeightClickerMode(false);
                      }}
                      onBlur={() => {
                        const wf = truckModal.weightField;
                        setValues((v) => {
                          const cur = parseInt(String((v as any)[wf] ?? 0), 10);
                          const next = Number.isFinite(cur) ? Math.max(0, Math.min(99, cur)) : 0;
                          return { ...v, [wf]: String(next) };
                        });
                        window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                      }}
                    />

                    <button
                      type="button"
                      className="h-12 px-4 rounded-2xl bg-white/10 text-white border border-white/15 hover:bg-white/15 text-sm font-bold"
                      onClick={() => {
                        setTruckWeightClickerMode((x) => !x);
                        window.setTimeout(() => truckKeyCaptureRef.current?.focus(), 0);
                      }}
                      title="Use A/B to edit weight digits"
                    >
                      {truckWeightClickerMode ? 'Clicker: ON' : 'Clicker: OFF'}
                    </button>
                  </div>

                  {truckWeightClickerMode ? (
                    <div className="mt-3 text-white/85 text-sm">
                      Editing digit: <span className="font-bold">{truckWeightDigit === 0 ? 'tens' : 'ones'}</span> (B switches)
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  className="mt-6 w-full h-14 rounded-2xl bg-white/10 text-white border border-white/15 font-bold hover:bg-white/15"
                  onClick={() => setTruckModal(null)}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Development: Bolt consumables modal */}
      {boltModalOpen && isDevBolts ? (
        <div className="fixed inset-0 bg-black sm:bg-black/30 flex items-start justify-center z-[1000] p-3 overflow-auto pt-6 pb-24">
          <div className="tv-surface-soft modal-solid-mobile w-full max-w-md sm:max-w-2xl rounded-3xl shadow-xl border tv-border p-3 sm:p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="font-bold">Bolt consumables</div>
                <div className="text-xs opacity-70">{sub}</div>
              </div>
              <button type="button" className="btn" onClick={() => setBoltModalOpen(false)}>
                Close
              </button>
            </div>

            <div className="text-xs opacity-70 mb-2">
              Add each bolt type/length and quantity. These entries will save as separate rows (shotcrete volumes are only stored once).
            </div>

            <div className="overflow-auto border rounded-xl">
              <table className="w-full table-fixed text-sm">
                <thead className="tv-surface-soft border-b tv-divider">
                  <tr>
                    <th className="p-1 text-left w-[140px]">Length</th>
                    <th className="p-1 text-left w-[160px]">Bolt type</th>
                    <th className="p-1 text-left w-[96px]">Qty</th>
                    <th className="p-1 text-left w-[36px]"> </th>
                  </tr>
                </thead>
                <tbody>
                  {(boltInputs || []).map((b, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="p-1">
                        <div className="flex flex-col gap-1">
                          <select
                            className="input w-full"
                            value={b.length}
                            onChange={(e) => {
                              const v = e.target.value;
                              setBoltInputs((prev) => {
                                const arr = [...(prev || [])];
                                arr[i] = { ...arr[i], length: v, lengthOther: v === 'Other' ? (arr[i].lengthOther || '') : '' };
                                return arr;
                              });
                            }}
                          >
                            <option value="">-</option>
                            {devBoltLengthOptions.map((o: string) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                            <option value="Other">Other</option>
                          </select>
                          {b.length === 'Other' ? (
                            <input
                              className="input w-full"
                              inputMode="decimal"
                              placeholder="Length (m)"
                              value={b.lengthOther || ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                setBoltInputs((prev) => {
                                  const arr = [...(prev || [])];
                                  arr[i] = { ...arr[i], lengthOther: v };
                                  return arr;
                                });
                              }}
                            />
                          ) : null}
                        </div>
                      </td>
                      <td className="p-1">
                        <select
                          className="input w-full"
                          value={b.type}
                          onChange={(e) => {
                            const v = e.target.value;
                            setBoltInputs((prev) => {
                              const arr = [...(prev || [])];
                              arr[i] = { ...arr[i], type: v };
                              return arr;
                            });
                          }}
                        >
                          <option value="">-</option>
                          {devBoltTypeOptions.map((o: string) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-1">
                        <input
                          className="input w-full"
                          inputMode="numeric"
                          value={b.count}
                          onChange={(e) => {
                            const v = e.target.value;
                            setBoltInputs((prev) => {
                              const arr = [...(prev || [])];
                              arr[i] = { ...arr[i], count: v };
                              return arr;
                            });
                          }}
                        />
                      </td>
                      <td className="p-1">
                        <button
                          type="button"
                          aria-label="Delete bolt"
                          title="Delete bolt"
                          className="w-8 h-8 flex items-start justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                          onClick={() => {
                            setBoltInputs((prev) => {
                              const arr = [...(prev || [])];
                              arr.splice(i, 1);
                              return arr.length ? arr : [{ length: '', lengthOther: '', type: '', count: '' }];
                            });
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}

                  {(boltInputs || []).length === 0 ? (
                    <tr>
                      <td className="p-3 text-sm opacity-70" colSpan={4}>
                        No bolts added yet.
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
                onClick={() =>
                  setBoltInputs((prev) => [...(prev || []), { length: '', lengthOther: '', type: '', count: '' }])
                }
              >
                + Add bolt
              </button>

              <div className="text-sm">
                Total: <b>{(boltInputs || []).reduce((acc, b) => acc + (Number(String(b.count || '').replace(/[^0-9]/g, '')) || 0), 0)}</b>
              </div>

              <button type="button" className="btn btn-primary" onClick={() => setBoltModalOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Development: Shotcrete modal */}
      {shotcreteModalOpen && isDevBolts ? (
        <div className="fixed inset-0 bg-black sm:bg-black/30 flex items-start justify-center z-[1000] p-3 overflow-auto pt-6 pb-24">
          <div className="tv-surface-soft modal-solid-mobile w-full max-w-md rounded-3xl shadow-xl border tv-border p-3 sm:p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="font-bold">Shotcrete</div>
                <div className="text-xs opacity-70">Enter volumes for this location</div>
              </div>
              <button type="button" className="btn" onClick={() => setShotcreteModalOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">AGI volume (m3)</label>
                <input
                  className="input w-full"
                  inputMode="decimal"
                  value={String((values as any)['Agi Volume'] ?? '')}
                  onChange={(e) => setValues((v) => ({ ...v, 'Agi Volume': e.target.value }))}
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Spray volume (m3)</label>
                <input
                  className="input w-full"
                  inputMode="decimal"
                  value={String((values as any)['Spray Volume'] ?? '')}
                  onChange={(e) => setValues((v) => ({ ...v, 'Spray Volume': e.target.value }))}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  // Treat blank as 0 so submit validation is consistent.
                  setValues((v) => ({
                    ...v,
                    'Agi Volume': String((v as any)['Agi Volume'] ?? '').trim() === '' ? '0' : (v as any)['Agi Volume'],
                    'Spray Volume': String((v as any)['Spray Volume'] ?? '').trim() === '' ? '0' : (v as any)['Spray Volume'],
                  }));
                  setShotcreteModalOpen(false);
                }}
              >
                Done
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setValues((v) => ({
                    ...v,
                    'Agi Volume': String((v as any)['Agi Volume'] ?? '').trim() === '' ? '0' : (v as any)['Agi Volume'],
                    'Spray Volume': String((v as any)['Spray Volume'] ?? '').trim() === '' ? '0' : (v as any)['Spray Volume'],
                  }));
                  setShotcreteModalOpen(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

{pdModal ? (
        <div className="fixed inset-0 bg-black sm:bg-black/30 flex items-start justify-center z-[1000] p-3 overflow-auto pt-6 pb-24">
          <div className="tv-surface-soft modal-solid-mobile w-full max-w-md sm:max-w-2xl rounded-3xl shadow-xl border tv-border p-3 sm:p-5">
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
                <thead className="tv-surface-soft border-b tv-divider">
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

      {!pickerOpen && (
      <div
        className="sticky left-0 right-0 tv-surface tv-border border-t"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 72px)' }}
      >
        <div className="max-w-2xl mx-auto p-4 flex gap-2">
          <button className="btn btn-primary flex-1" onClick={finishTask} disabled={!canFinish}>
            FINISH TASK
          </button>
          <a className="btn flex-1 text-center" href="/Shift">
            BACK
          </a>
        </div>
      </div>
      )}
    </div>
  );
}