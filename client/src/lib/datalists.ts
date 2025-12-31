import { api } from './api';
import { getDB } from './idb';

function uniqByName(items: any[]) {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const it of items || []) {
    const name = String(it?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...it, name });
  }
  return out;
}


export async function loadEquipment(user_id: number) {
  const db = await getDB();
  // return cached first
  const cached = await db.getAll('equipment');
  // fire-and-forget network refresh
  try {
    const res = await api(`/api/equipment?user_id=${user_id}`);
    // Merge personal equipment + (if member of a current site) site equipment.
    let merged: any[] = (res.items || []).map((r: any) => ({ ...r }));
    try {
      const me: any = await api('/api/user/me');
      const site = String(me?.site || '').trim();
      if (site) {
        const sa: any = await api(`/api/user/site-assets?site=${encodeURIComponent(site)}`);
        const siteRows = (sa?.equipment || []).map((r: any) => ({
          equipment_id: String(r?.name || '').trim(),
          type: String(r?.type || '').trim(),
          site,
          is_site_asset: true,
        }));
        // Deduplicate by equipment_id (case-insensitive)
        const seen = new Set<string>();
        const out: any[] = [];
        for (const row of [...merged, ...siteRows]) {
          const eid = String(row?.equipment_id || '').trim();
          const t = String(row?.type || '').trim();
          if (!eid || !t) continue;
          const key = eid.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ ...row, equipment_id: eid, type: t });
        }
        merged = out;
      }
    } catch {
      // ignore site merge failures
    }

    // reset store to merged list
    const tx = (await getDB()).transaction('equipment', 'readwrite');
    const store = tx.objectStore('equipment');
    const all = await store.getAll();
    for (const item of all) await store.delete(item.id);
    for (const row of merged) await store.put(row);
    await tx.done;
    return merged.map((r: any) => r.equipment_id);
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
    let items = res.items.map((r: any) => ({ id: r.id, name: r.name, type: r.type }));
    try {
      const me: any = await api('/api/user/me');
      const site = String(me?.site || '').trim();
      if (site) {
        const sa: any = await api(`/api/user/site-assets?site=${encodeURIComponent(site)}`);
        const siteItems = (sa?.locations || []).map((r: any) => ({ id: `site-${r.id}`, name: r.name, type: r.type }));
        items = uniqByName([...items, ...siteItems]);
      }
    } catch {}
    return items;
  } catch {}
  return cached.map((r: any) => ({ id: r.id, name: r.name, type: r.type }));
}
