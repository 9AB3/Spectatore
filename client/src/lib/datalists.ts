import { api } from './api';
import { getDB } from './idb';

export async function loadEquipment(user_id: number) {
  const db = await getDB();
  // return cached first
  const cached = await db.getAll('equipment');
  // fire-and-forget network refresh
  try {
    const res = await api(`/api/equipment?user_id=${user_id}`);
    // reset store
    const tx = (await getDB()).transaction('equipment', 'readwrite');
    const store = tx.objectStore('equipment');
    const all = await store.getAll();
    for (const item of all) await store.delete(item.id);
    for (const row of res.items) await store.put(row);
    await tx.done;
    return res.items.map((r: any) => r.equipment_id);
  } catch {
    /* offline */
  }
  return cached.map((r: any) => r.equipment_id);
}

export async function loadLocations(user_id: number) {
  const db = await getDB();
  const cached = await db.getAll('locations');
  try {
    const res = await api(`/api/locations?user_id=${user_id}`);
    const tx = (await getDB()).transaction('locations', 'readwrite');
    const store = tx.objectStore('locations');
    const all = await store.getAll();
    for (const item of all) await store.delete(item.id);
    for (const row of res.items) await store.put(row);
    await tx.done;
    return res.items.map((r: any) => r.name);
  } catch {}
  return cached.map((r: any) => r.name);
}
