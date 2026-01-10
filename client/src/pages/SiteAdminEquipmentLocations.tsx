import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type EquipRow = { id?: number; site: string; type: string; equipment_id: string };
type LocationRow = { id?: number; site: string; name: string; type: 'Heading' | 'Stope' | 'Stockpile' | '' };

// Keep in sync with user-side mapping (authoritative is server shifts mapping too)
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

export default function SiteAdminEquipmentLocations() {
  const { setMsg, Toast } = useToast();
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState<string>('');

  const [type, setType] = useState(EQUIP_TYPES[0]);
  const [equipId, setEquipId] = useState('');
  const [location, setLocation] = useState('');
  const [locationType, setLocationType] = useState<LocationRow['type']>('Heading');

  const [equipRows, setEquipRows] = useState<EquipRow[]>([]);
  const [locRows, setLocRows] = useState<LocationRow[]>([]);

  async function refresh() {
    if (!site) return;
    const eq = await api(`/api/site-admin/admin-equipment?site=${encodeURIComponent(site)}`);
    const loc = await api(`/api/site-admin/admin-locations?site=${encodeURIComponent(site)}`);
    setEquipRows((eq?.rows || []) as any);
    setLocRows((loc?.rows || []) as any);
  }

  useEffect(() => {
    (async () => {
      try {
        const s = await api('/api/site-admin/sites');
        const list = (s?.sites || []) as string[];
        setSites(list);
        setSite((list && list[0]) || 'default');
      } catch {
        setSites(['default']);
        setSite('default');
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  const equipListSorted = useMemo(() => {
    return [...equipRows].sort((a, b) => {
      const t = (a.type || '').localeCompare(b.type || '');
      if (t !== 0) return t;
      return (a.equipment_id || '').localeCompare(b.equipment_id || '');
    });
  }, [equipRows]);

  const locListSorted = useMemo(() => {
    return [...locRows].sort((a, b) => {
      const t = String(a.type || '').localeCompare(String(b.type || ''));
      if (t !== 0) return t;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [locRows]);

  async function submit() {
    try {
      if (equipId) {
        if (!isEquipIdValid(equipId)) {
          setMsg('Equipment ID must be 2 letters + 2 digits (e.g. UJ01)');
          return;
        }
        await api('/api/site-admin/admin-equipment', {
          method: 'POST',
          body: JSON.stringify({ site, type, equipment_id: equipId }),
        });
      }

      if (location) {
        await api('/api/site-admin/admin-locations', {
          method: 'POST',
          body: JSON.stringify({ site, name: location, type: locationType }),
        });
      }

      setEquipId('');
      setLocation('');
      setLocationType('Heading');
      setMsg('Saved');
      await refresh();
    } catch {
      setMsg('Submission failed');
    }
  }

  async function deleteEquipment(equipment_id: string) {
    try {
      await api('/api/site-admin/admin-equipment', {
        method: 'DELETE',
        body: JSON.stringify({ site, equipment_id }),
      });
      await refresh();
    } catch {
      setMsg('Failed to delete equipment');
    }
  }

  async function deleteLocation(name: string) {
    try {
      await api('/api/site-admin/admin-locations', {
        method: 'DELETE',
        body: JSON.stringify({ site, name }),
      });
      await refresh();
    } catch {
      setMsg('Failed to delete location');
    }
  }

  const bigInput = 'input text-base p-3';

  return (
    <div>
      <Toast />
      <Header />

      <div className="p-6 max-w-2xl mx-auto card space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-lg font-bold">SiteAdmin / Equipment &amp; Locations</div>
          <select className={bigInput} value={site} onChange={(e) => setSite(e.target.value)}>
            {sites.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Equipment</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select className={bigInput} value={type} onChange={(e) => setType(e.target.value)}>
              {EQUIP_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <input
              className={`${bigInput} sm:col-span-2`}
              placeholder="Equipment ID (e.g. UJ01)"
              value={equipId}
              onChange={(e) => setEquipId(e.target.value.toUpperCase())}
            />
          </div>
          <div className="text-xs text-[color:var(--muted)] mt-1">
            Activity: <strong>{activityForType(type)}</strong>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Location</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select
              className={bigInput}
              value={locationType}
              onChange={(e) => setLocationType(e.target.value as any)}
            >
              <option value="Heading">Heading</option>
              <option value="Stope">Stope</option>
              <option value="Stockpile">Stockpile</option>
            </select>
            <input
              className={`${bigInput} sm:col-span-2`}
              placeholder="Location name"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
        </div>

        <button className="btn w-full" onClick={submit}>
          Save
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card p-3">
            <div className="font-bold mb-2">Equipment</div>
            <div className="space-y-2">
              {equipListSorted.map((r) => (
                <div key={`${r.type}-${r.equipment_id}`} className="flex items-center justify-between gap-2">
                  <div className="text-sm">
                    <div className="font-semibold">{r.equipment_id}</div>
                    <div className="text-xs opacity-70">{r.type}</div>
                  </div>
                  <button className="btn" onClick={() => deleteEquipment(r.equipment_id)}>
                    Delete
                  </button>
                </div>
              ))}
              {!equipListSorted.length && <div className="text-sm opacity-70">No equipment yet.</div>}
            </div>
          </div>

          <div className="card p-3">
            <div className="font-bold mb-2">Locations</div>
            <div className="space-y-2">
              {locListSorted.map((r) => (
                <div key={`${r.type}-${r.name}`} className="flex items-center justify-between gap-2">
                  <div className="text-sm">
                    <div className="font-semibold">{r.name}</div>
                    <div className="text-xs opacity-70">{r.type || '—'}</div>
                  </div>
                  <button className="btn" onClick={() => deleteLocation(r.name)}>
                    Delete
                  </button>
                </div>
              ))}
              {!locListSorted.length && <div className="text-sm opacity-70">No locations yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
