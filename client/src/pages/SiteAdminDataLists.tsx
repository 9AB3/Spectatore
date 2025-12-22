import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

type EquipRow = { id?: number; type: string; equipment_id: string };
type LocationRow = { id?: number; name: string; type: 'Heading' | 'Stope' | 'Stockpile' };

const EQUIP_TYPES = [
  'Truck',
  'Loader',
  'Jumbo',
  'Production Drill',
  'Spray Rig',
  'Agi',
  'Charge Rig',
];

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-3xl">{children}</div>;
}

export default function SiteAdminDataLists() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [equipType, setEquipType] = useState<string>(EQUIP_TYPES[0]);
  const [equipId, setEquipId] = useState<string>('');
  const [locName, setLocName] = useState<string>('');
  const [locType, setLocType] = useState<LocationRow['type']>('Heading');

  const [equipRows, setEquipRows] = useState<EquipRow[]>([]);
  const [locRows, setLocRows] = useState<LocationRow[]>([]);

  async function refresh() {
    const db = await getDB();
    const e = (await db.getAll('equipment')) as any[];
    const l = (await db.getAll('locations')) as any[];
    setEquipRows(
      (e || [])
        .map((r) => ({ id: r.id, type: String(r.type || ''), equipment_id: String(r.equipment_id || '') }))
        .filter((r) => r.type && r.equipment_id)
        .sort((a, b) => (a.type + a.equipment_id).localeCompare(b.type + b.equipment_id)),
    );
    setLocRows(
      (l || [])
        .map((r) => ({ id: r.id, name: String(r.name || ''), type: (r.type as any) || 'Heading' }))
        .filter((r) => r.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const locNames = useMemo(() => locRows.map((r) => r.name), [locRows]);

  async function addEquip() {
    const id = equipId.trim();
    if (!id) return setMsg('Enter an equipment ID');
    try {
      const db = await getDB();
      await db.add('equipment', { type: equipType, equipment_id: id });
      setEquipId('');
      await refresh();
      setMsg('Equipment added');
    } catch {
      setMsg('Failed to add equipment');
    }
  }

  async function removeEquip(row: EquipRow) {
    try {
      const db = await getDB();
      if (row.id != null) await db.delete('equipment', row.id);
      await refresh();
      setMsg('Removed');
    } catch {
      setMsg('Failed to remove');
    }
  }

  async function addLoc() {
    const name = locName.trim();
    if (!name) return setMsg('Enter a location name');
    try {
      const db = await getDB();
      await db.add('locations', { name, type: locType });
      setLocName('');
      await refresh();
      setMsg('Location added');
    } catch {
      setMsg('Failed to add location');
    }
  }

  async function removeLoc(row: LocationRow) {
    try {
      const db = await getDB();
      if (row.id != null) await db.delete('locations', row.id);
      await refresh();
      setMsg('Removed');
    } catch {
      setMsg('Failed to remove');
    }
  }

  return (
    <div className="min-h-screen p-4 flex items-start justify-center">
      <Card>
        <Toast />
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-lg">Locations & Equipment (Admin)</div>
          <button className="btn" onClick={() => nav('/SiteAdmin')}>Back</button>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Locations */}
          <div>
            <div className="font-semibold mb-2">Locations (used for Location / Source dropdowns)</div>

            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <input
                className="input flex-1 text-lg py-3"
                list="locNameOptions"
                placeholder="Location name"
                value={locName}
                onChange={(e) => setLocName(e.target.value)}
              />
              <select className="input w-full sm:w-44 text-lg py-3" value={locType} onChange={(e) => setLocType(e.target.value as any)}>
                <option>Heading</option>
                <option>Stope</option>
                <option>Stockpile</option>
              </select>
              <button className="btn" onClick={addLoc}>Add</button>
            </div>

            <datalist id="locNameOptions">
              {locNames.map((n) => <option key={n} value={n} />)}
            </datalist>

            <div className="max-h-[420px] overflow-auto border border-black/10 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-black/5">
                    <th className="p-2 text-left">Name</th>
                    <th className="p-2 text-left">Type</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {locRows.map((r) => (
                    <tr key={r.id} className="border-b">
                      <td className="p-2">{r.name}</td>
                      <td className="p-2">{r.type}</td>
                      <td className="p-2 text-right">
                        <button className="btn" onClick={() => removeLoc(r)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {!locRows.length && (
                    <tr>
                      <td className="p-2 opacity-70" colSpan={3}>No locations yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Equipment */}
          <div>
            <div className="font-semibold mb-2">Equipment</div>

            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <select className="input w-44" value={equipType} onChange={(e) => setEquipType(e.target.value)}>
                {EQUIP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input
                className="input flex-1 text-lg py-3"
                placeholder="Equipment ID (e.g. TRK-01)"
                value={equipId}
                onChange={(e) => setEquipId(e.target.value)}
              />
              <button className="btn" onClick={addEquip}>Add</button>
            </div>

            <div className="max-h-[420px] overflow-auto border border-black/10 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-black/5">
                    <th className="p-2 text-left">Type</th>
                    <th className="p-2 text-left">ID</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {equipRows.map((r) => (
                    <tr key={r.id} className="border-b">
                      <td className="p-2">{r.type}</td>
                      <td className="p-2">{r.equipment_id}</td>
                      <td className="p-2 text-right">
                        <button className="btn" onClick={() => removeEquip(r)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {!equipRows.length && (
                    <tr>
                      <td className="p-2 opacity-70" colSpan={3}>No equipment yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="text-xs opacity-70 mt-4">
          These lists are stored locally on this device (IndexedDB) and are used to populate dropdowns in Site Admin validation.
        </div>
      </Card>
    </div>
  );
}
