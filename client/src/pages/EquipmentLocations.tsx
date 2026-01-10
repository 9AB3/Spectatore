import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';
import { loadEquipment, loadLocations } from '../lib/datalists';

type EquipRow = { id?: number; type: string; equipment_id: string };
type LocationRow = { id?: number; name: string; type: 'Heading' | 'Stope' | 'Stockpile' };

/**
 * Authoritative equipment → activity mapping
 * (Derived, NOT stored in DB)
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

const EQUIP_TYPES = Object.keys(EQUIPMENT_ACTIVITY_MAP);

function isEquipIdValid(s: string) {
  return /^[A-Za-z]{2}\d{2}$/.test(s);
}

function activityForType(type: string): string {
  const acts = EQUIPMENT_ACTIVITY_MAP[type];
  return acts && acts.length ? acts.join(', ') : '—';
}

export default function EquipmentLocations() {
  const { setMsg, Toast } = useToast();
  const [type, setType] = useState(EQUIP_TYPES[0]);
  const [equipId, setEquipId] = useState('');
  const [location, setLocation] = useState('');
  const [locationType, setLocationType] = useState<LocationRow['type']>('Heading');
  const [equipRows, setEquipRows] = useState<EquipRow[]>([]);
  const [locList, setLocList] = useState<LocationRow[]>([]);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

  async function refreshLists(uid: number) {
    // show cached immediately
    const db = await getDB();
    const cachedEq = (await db.getAll('equipment')) as any[];
    setEquipRows(
      (cachedEq || [])
        .map((r) => ({ id: r.id, type: r.type, equipment_id: r.equipment_id }))
        .filter((r) => r.equipment_id && r.type),
    );

    // refresh from network (also updates cache)
    await loadEquipment(uid);
    await loadLocations(uid);

    // re-read cache
    const db2 = await getDB();
    const updatedEq = (await db2.getAll('equipment')) as any[];
    setEquipRows(
      (updatedEq || [])
        .map((r) => ({ id: r.id, type: r.type, equipment_id: r.equipment_id }))
        .filter((r) => r.equipment_id && r.type),
    );

    setLocList((await loadLocations(uid)) as any);
  }

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');
      const uid = session?.user_id || 0;
      await refreshLists(uid);
    })();
  }, []);

  const equipListSorted = useMemo(() => {
    return [...equipRows].sort((a, b) => {
      const t = (a.type || '').localeCompare(b.type || '');
      if (t !== 0) return t;
      return (a.equipment_id || '').localeCompare(b.equipment_id || '');
    });
  }, [equipRows]);

  async function submit() {
    if (!online) {
      setMsg('Please ensure network connection');
      return;
    }

    const db = await getDB();
    const session = await db.get('session', 'auth');
    const user_id = session?.user_id;

    try {
      if (equipId) {
        if (!isEquipIdValid(equipId)) {
          setMsg('Equipment ID must be 2 letters + 2 digits (e.g. UJ01)');
          return;
        }
        await api('/api/equipment', {
          method: 'POST',
          body: JSON.stringify({ user_id, type, equipment_id: equipId }),
        });
      }

      if (location) {
        await api('/api/locations', {
          method: 'POST',
          body: JSON.stringify({ user_id, name: location, type: locationType }),
        });
      }

      setMsg('Fleet / location successfully updated');
      setEquipId('');
      setLocation('');
      setLocationType('Heading');

      await refreshLists(user_id || 0);
    } catch {
      setMsg('Submission failed');
    }
  }

  async function deleteEquipment(equipmentId: string) {
    if (!online) {
      setMsg('Please ensure network connection');
      return;
    }

    const db = await getDB();
    const session = await db.get('session', 'auth');
    const user_id = session?.user_id;

    if (!user_id) {
      setMsg('Missing user session');
      return;
    }

    try {
      await api('/api/equipment', {
        method: 'DELETE',
        body: JSON.stringify({ user_id, equipment_id: equipmentId }),
      });

      await refreshLists(user_id);
    } catch {
      setMsg('Failed to delete equipment');
    }
  }

  async function deleteLocation(name: string) {
    if (!online) {
      setMsg('Please ensure network connection');
      return;
    }

    const db = await getDB();
    const session = await db.get('session', 'auth');
    const user_id = session?.user_id;

    if (!user_id) {
      setMsg('Missing user session');
      return;
    }

    try {
      await api('/api/locations', {
        method: 'DELETE',
        body: JSON.stringify({ user_id, name }),
      });

      setLocList(await loadLocations(user_id));
    } catch {
      setMsg('Failed to delete location');
    }
  }

  return (
    <div>
      <Toast />
      <Header />

      <div className="p-6 max-w-4xl mx-auto space-y-4">
        <div className="card p-5">
          <div className="text-lg font-semibold">Equipment &amp; Locations</div>
          <div className="text-sm text-[color:var(--muted)] mt-1">
            Maintain your local equipment IDs and location list. These lists power drop-downs and validation tools.
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          {/* Forms */}
          <div className="card p-5 space-y-4">
            <div className="text-sm font-semibold text-slate-800">Add / Update</div>

            <div className="rounded-xl border border-[color:var(--hairline)] p-4">
              <div className="font-medium">Equipment</div>
              <div className="text-xs text-[color:var(--muted)] mt-1">
                Activity mapping is automatic based on type.
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3">
                <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                  {EQUIP_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <input
                  className="input col-span-2"
                  placeholder="Equipment ID (e.g. UJ01)"
                  value={equipId}
                  onChange={(e) => setEquipId(e.target.value.toUpperCase())}
                />
              </div>

              <div className="text-xs text-[color:var(--muted)] mt-2">
                Activity: <strong>{activityForType(type)}</strong>
              </div>
            </div>

            <div className="rounded-xl border border-[color:var(--hairline)] p-4">
              <div className="font-medium">Location</div>
              <div className="grid grid-cols-3 gap-2 mt-3">
                <select
                  className="input"
                  value={locationType}
                  onChange={(e) => setLocationType(e.target.value as any)}
                >
                  <option value="Heading">Heading</option>
                  <option value="Stope">Stope</option>
                  <option value="Stockpile">Stockpile</option>
                </select>
                <input
                  className="input col-span-2"
                  placeholder="Enter alphanumeric location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </div>
            </div>

            {!online && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm p-3">
                You are currently offline. Changes will be saved locally and synced when you&apos;re back online.
              </div>
            )}

            <button className="btn btn-primary w-full" onClick={submit} type="button">
              Save
            </button>
          </div>

          {/* Lists */}
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-800">Saved lists</div>
                <div className="text-xs text-[color:var(--muted)] mt-1">
                  Tap ✕ to remove an item. Lists update immediately.
                </div>
              </div>
              <div className="text-xs text-[color:var(--muted)]">
                {equipListSorted.length} equipment • {locList.length} locations
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              <div className="rounded-xl border border-[color:var(--hairline)] p-4">
                <div className="font-medium mb-2">Equipment</div>
                <ul className="tv-list space-y-1">
                  {equipListSorted.map((e) => (
                    <li
                      key={`${e.type}-${e.equipment_id}`}
                      className="tv-list-item"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          {e.equipment_id}{' '}
                          <span className="text-xs font-normal text-[color:var(--muted)]">({e.type})</span>
                        </div>
                        <div className="text-xs text-[color:var(--muted)] truncate">Activity: {activityForType(e.type)}</div>
                      </div>
                      <button
                        className="btn-icon" onClick={() => deleteEquipment(e.equipment_id)}
                        type="button"
                        aria-label={`Delete ${e.equipment_id}`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                  {equipListSorted.length === 0 && <div className="text-[color:var(--muted)] text-sm">No equipment yet</div>}
                </ul>
              </div>

              <div className="rounded-xl border border-[color:var(--hairline)] p-4">
                <div className="font-medium mb-2">Locations</div>
                <ul className="tv-list space-y-1">
                  {locList.map((l) => (
                    <li
                      key={`${l.type}-${l.name}`}
                      className="tv-list-item"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          {l.name}{' '}
                          <span className="text-xs font-normal text-[color:var(--muted)]">({l.type})</span>
                        </div>
                      </div>
                      <button
                        className="btn-icon" onClick={() => deleteLocation(l.name)}
                        type="button"
                        aria-label={`Delete ${l.name}`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                  {locList.length === 0 && <div className="text-[color:var(--muted)] text-sm">No locations yet</div>}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
