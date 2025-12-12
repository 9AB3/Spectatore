import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';
import { loadEquipment, loadLocations } from '../lib/datalists';

const EQUIP_TYPES = ['Truck', 'Loader', 'Jumbo', 'Production Drill', 'Spray Rig', 'Agi'];

function isEquipIdValid(s: string) {
  return /^[A-Za-z]{2}\d{2}$/.test(s);
}

export default function EquipmentLocations() {
  const { setMsg, Toast } = useToast();
  const [type, setType] = useState('Truck');
  const [equipId, setEquipId] = useState('');
  const [location, setLocation] = useState('');
  const [equipList, setEquipList] = useState<string[]>([]);
  const [locList, setLocList] = useState<string[]>([]);
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

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');
      const uid = session?.user_id || 0;
      setEquipList(await loadEquipment(uid));
      setLocList(await loadLocations(uid));
    })();
  }, []);

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
          body: JSON.stringify({ user_id, name: location }),
        });
      }
      setMsg('Fleet / location successfully updated');
      setEquipId('');
      setLocation('');
    } catch (e: any) {
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

      // Reload list so UI + IndexedDB cache stay in sync
      const updated = await loadEquipment(user_id);
      setEquipList(updated);
    } catch (e: any) {
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

      const updated = await loadLocations(user_id);
      setLocList(updated);
    } catch (e: any) {
      setMsg('Failed to delete location');
    }
  }


  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-xl mx-auto card space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Equipment</label>
          <div className="grid grid-cols-3 gap-2">
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
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Location</label>
          <input
            className="input"
            placeholder="Enter alphanumeric location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>

        {!online && (
          <div className="text-red-600 text-sm">
            Not online on SUBMIT “Please ensure network connection”
          </div>
        )}

        <div className="flex gap-2">
          <button className="btn btn-primary flex-1" onClick={submit}>
            SUBMIT
          </button>
          <a className="btn btn-secondary flex-1 text-center" href="/Main">
            BACK
          </a>
        </div>
      </div>
      <div className="p-6 max-w-xl mx-auto card mt-4">
        <h3 className="font-semibold mb-2">Your equipment and locations</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="font-medium mb-1">Equipment IDs</div>
            <ul className="space-y-1">
  {equipList.map((e) => (
    <li key={e} className="flex items-center justify-between">
      <span>{e}</span>
      <button
        type="button"
        className="text-xs text-red-500 hover:text-red-700"
        onClick={() => deleteEquipment(e)}
      >
        ✕
      </button>
    </li>
  ))}
  {equipList.length === 0 && (
    <div className="text-slate-500">No equipment yet</div>
  )}
</ul>

          </div>
          <div>
            <div className="font-medium mb-1">Locations</div>
           <ul className="space-y-1">
  {locList.map((l) => (
    <li key={l} className="flex items-center justify-between">
      <span>{l}</span>
      <button
        type="button"
        className="text-xs text-red-500 hover:text-red-700"
        onClick={() => deleteLocation(l)}
      >
        ✕
      </button>
    </li>
  ))}
  {locList.length === 0 && (
    <div className="text-slate-500">No locations yet</div>
  )}
</ul>

          </div>
        </div>
      </div>
    </div>
  );
}
