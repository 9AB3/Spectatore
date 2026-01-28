import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';
import { loadEquipment, loadLocations } from '../lib/datalists';

type EquipRow = { id?: number; type: string; equipment_id: string; is_site_asset?: boolean; site?: string };
type LocationRow = { id?: number; name: string; type: 'Heading' | 'Stope' | 'Stockpile'; is_site_asset?: boolean; site?: string };

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
  // Equipment IDs are site-specific; allow any non-empty value.
  return !!String(s || '').trim();
}

function activityForType(type: string): string {
  const acts = EQUIPMENT_ACTIVITY_MAP[type];
  return acts && acts.length ? acts.join(', ') : '—';
}

type Tab = 'equipment' | 'locations';

export default function EquipmentLocations() {
  const { setMsg, Toast } = useToast();
  const [online, setOnline] = useState(navigator.onLine);

  // Hub state
  const [tab, setTab] = useState<Tab>('equipment');
  const [query, setQuery] = useState('');
  const [equipTypeFilter, setEquipTypeFilter] = useState<string>('All');
  const [locTypeFilter, setLocTypeFilter] = useState<LocationRow['type'] | 'All'>('All');
  // Site assets are read-only and can be toggled for clarity
  const [showSiteAssets, setShowSiteAssets] = useState(true);

  // Data
  const [equipRows, setEquipRows] = useState<EquipRow[]>([]);
  const [locRows, setLocRows] = useState<LocationRow[]>([]);

  // Drawer / modal
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit'>('create');
  const [bulkOpen, setBulkOpen] = useState(false);

  // Form fields (drawer)
  const [type, setType] = useState(EQUIP_TYPES[0]);
  const [equipId, setEquipId] = useState('');
  const [location, setLocation] = useState('');
  const [locationType, setLocationType] = useState<LocationRow['type']>('Heading');

  // Selected item (edit)
  const [selectedEquip, setSelectedEquip] = useState<EquipRow | null>(null);
  const [selectedLoc, setSelectedLoc] = useState<LocationRow | null>(null);

  // Bulk add
  const [bulkText, setBulkText] = useState('');
  const [rangePrefix, setRangePrefix] = useState('UT');
  const [rangeFrom, setRangeFrom] = useState('1');
  const [rangeTo, setRangeTo] = useState('10');
  const [rangePad, setRangePad] = useState('2');

  const [siteLabel, setSiteLabel] = useState<string>('');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [userId, setUserId] = useState<number | null>(null);

  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

  async function getSession() {
    const db = await getDB();
    const session = await db.get('session', 'auth');
    const uid = session?.user_id ?? null;
    const sid = session?.work_site_id ?? session?.subscribed_site_id ?? null;
    const sname = session?.work_site_name ?? session?.subscribed_site_name ?? '';
    setUserId(uid);
    setSiteId(typeof sid === 'number' ? sid : null);
    setSiteLabel(String(sname || ''));
    return { session, uid, sid, sname };
  }

  async function refreshLists(uid: number) {
    // show cached immediately
    const db = await getDB();
    const cachedEq = (await db.getAll('equipment')) as any[];
    const cachedLoc = (await db.getAll('locations')) as any[];

    setEquipRows(
      (cachedEq || [])
        .map((r) => ({ id: r.id, type: r.type, equipment_id: r.equipment_id, is_site_asset: !!r.is_site_asset, site: r.site }))
        .filter((r) => r.equipment_id && r.type),
    );
    setLocRows(
      (cachedLoc || [])
        .map((r) => ({ id: r.id, name: r.name, type: r.type, is_site_asset: !!r.is_site_asset, site: r.site }))
        .filter((r) => r.name),
    );

    // refresh from network (also updates cache)
    await loadEquipment(uid);
    await loadLocations(uid);

    // re-read cache
    const db2 = await getDB();
    const updatedEq = (await db2.getAll('equipment')) as any[];
    const updatedLoc = (await db2.getAll('locations')) as any[];

    setEquipRows(
      (updatedEq || [])
        .map((r) => ({ id: r.id, type: r.type, equipment_id: r.equipment_id, is_site_asset: !!r.is_site_asset, site: r.site }))
        .filter((r) => r.equipment_id && r.type),
    );
    setLocRows(
      (updatedLoc || [])
        .map((r) => ({ id: r.id, name: r.name, type: r.type, is_site_asset: !!r.is_site_asset, site: r.site }))
        .filter((r) => r.name),
    );
  }

  useEffect(() => {
    (async () => {
      const s = await getSession();
      await refreshLists(s.uid || 0);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const filteredEquipment = useMemo(() => {
    const q = query.trim().toLowerCase();
    return equipListSorted.filter((r) => {
      const matchesType = equipTypeFilter === 'All' ? true : r.type === equipTypeFilter;
      const matchesQ = !q ? true : `${r.equipment_id} ${r.type}`.toLowerCase().includes(q);
      return matchesType && matchesQ;
    });
  }, [equipListSorted, query, equipTypeFilter]);

  const filteredLocations = useMemo(() => {
    const q = query.trim().toLowerCase();
    return locListSorted.filter((r) => {
      const matchesType = locTypeFilter === 'All' ? true : r.type === locTypeFilter;
      const matchesQ = !q ? true : `${r.name} ${r.type}`.toLowerCase().includes(q);
      return matchesType && matchesQ;
    });
  }, [locListSorted, query, locTypeFilter]);

  const groupedEquipment = useMemo(() => {
    const user = filteredEquipment.filter((r) => !r.is_site_asset);
    const site = filteredEquipment.filter((r) => !!r.is_site_asset);
    return { user, site };
  }, [filteredEquipment]);

  const groupedLocations = useMemo(() => {
    const user = filteredLocations.filter((r) => !r.is_site_asset);
    const site = filteredLocations.filter((r) => !!r.is_site_asset);
    return { user, site };
  }, [filteredLocations]);

  function openCreate() {
    setDrawerMode('create');
    setSelectedEquip(null);
    setSelectedLoc(null);
    setEquipId('');
    setLocation('');
    setLocationType('Heading');
    setType(EQUIP_TYPES[0]);
    setDrawerOpen(true);
  }

  function openEditEquip(r: EquipRow) {
    if (r?.is_site_asset) return;
    setDrawerMode('edit');
    setSelectedEquip(r);
    setSelectedLoc(null);
    setType(r.type);
    setEquipId(r.equipment_id);
    setDrawerOpen(true);
  }

  function openEditLoc(r: LocationRow) {
    if (r?.is_site_asset) return;
    setDrawerMode('edit');
    setSelectedLoc(r);
    setSelectedEquip(null);
    setLocationType(r.type);
    setLocation(r.name);
    setDrawerOpen(true);
  }

  async function createOrUpdateEquipment(oneEquipId: string, oneType: string) {
    const uid = userId ?? (await getSession()).uid;
    const sid = siteId ?? (await getSession()).sid;
    // Edit mode should update the selected row (including renames) instead of inserting a new one.
    if (drawerMode === 'edit' && selectedEquip?.id) {
      await api(`/api/equipment/${selectedEquip.id}` as any, {
        method: 'PATCH',
        body: JSON.stringify({ user_id: uid, site_id: sid, type: oneType, equipment_id: oneEquipId }),
      });
      return;
    }
    await api('/api/equipment', {
      method: 'POST',
      body: JSON.stringify({ user_id: uid, site_id: sid, type: oneType, equipment_id: oneEquipId }),
    });
  }

  async function createOrUpdateLocation(oneName: string, oneType: LocationRow['type']) {
    const uid = userId ?? (await getSession()).uid;
    const sid = siteId ?? (await getSession()).sid;
    if (drawerMode === 'edit' && selectedLoc?.id) {
      await api(`/api/locations/${selectedLoc.id}` as any, {
        method: 'PATCH',
        body: JSON.stringify({ user_id: uid, site_id: sid, name: oneName, type: oneType }),
      });
      return;
    }
    await api('/api/locations', {
      method: 'POST',
      body: JSON.stringify({ user_id: uid, site_id: sid, name: oneName, type: oneType }),
    });
  }

  async function submitDrawer() {
    if (!online) {
      setMsg('Please ensure network connection');
      return;
    }

    try {
      const uid = userId ?? (await getSession()).uid;
      if (!uid) {
        setMsg('Missing user session');
        return;
      }

      if (tab === 'equipment') {
        const id = equipId.trim().toUpperCase();
        if (!id) {
          setMsg('Enter an Equipment ID');
          return;
        }
        // Any non-empty ID is allowed.
        if (drawerMode === 'create') {
          const dupSite = (equipRows || []).some((r) => r.is_site_asset && String(r.equipment_id || '').toUpperCase() === id);
          if (dupSite) {
            setMsg('That equipment already exists in the Site list (read-only)');
            return;
          }
        }
        await createOrUpdateEquipment(id, type);
      } else {
        const nm = location.trim();
        if (!nm) {
          setMsg('Enter a location');
          return;
        }
        if (drawerMode === 'create') {
          const dupSite = (locRows || []).some((r) => r.is_site_asset && String(r.name || '').trim().toLowerCase() === nm.trim().toLowerCase());
          if (dupSite) {
            setMsg('That location already exists in the Site list (read-only)');
            return;
          }
        }

        await createOrUpdateLocation(nm, locationType);
      }

      setDrawerOpen(false);
      setMsg('Saved');
      await refreshLists(uid || 0);
    } catch {
      setMsg('Submission failed');
    }
  }

  async function deleteEquipment(equipmentId: string) {
    const isSite = (equipRows || []).some((r) => String(r.equipment_id||'').toUpperCase()===String(equipmentId||'').toUpperCase() && r.is_site_asset);
    if (isSite) {
      setMsg('Site equipment is read-only');
      return;
    }
    if (!online) {
      setMsg('Please ensure network connection');
      return;
    }
    try {
      const uid = userId ?? (await getSession()).uid;
      const sid = siteId ?? (await getSession()).sid;
      if (!uid) {
        setMsg('Missing user session');
        return;
      }
      await api('/api/equipment', {
        method: 'DELETE',
        body: JSON.stringify({ user_id: uid, site_id: sid, equipment_id: equipmentId }),
      });
      await refreshLists(uid || 0);
    } catch {
      setMsg('Failed to remove equipment');
    }
  }

  async function deleteLocation(name: string) {
    const isSite = (locRows || []).some((r) => String(r.name||'').trim().toLowerCase()===String(name||'').trim().toLowerCase() && r.is_site_asset);
    if (isSite) {
      setMsg('Site location is read-only');
      return;
    }
    if (!online) {
      setMsg('Please ensure network connection');
      return;
    }
    try {
      const uid = userId ?? (await getSession()).uid;
      const sid = siteId ?? (await getSession()).sid;
      if (!uid) {
        setMsg('Missing user session');
        return;
      }
      await api('/api/locations', {
        method: 'DELETE',
        body: JSON.stringify({ user_id: uid, site_id: sid, name }),
      });
      await refreshLists(uid || 0);
    } catch {
      setMsg('Failed to remove location');
    }
  }

  function generateRange() {
    const pfx = (rangePrefix || '').toUpperCase();
    const start = Math.max(0, parseInt(rangeFrom || '0', 10));
    const end = Math.max(0, parseInt(rangeTo || '0', 10));
    const pad = Math.max(0, Math.min(6, parseInt(rangePad || '0', 10)));
    const out: string[] = [];
    const a = Math.min(start, end);
    const b = Math.max(start, end);
    for (let i = a; i <= b; i++) {
      const n = String(i).padStart(pad, '0');
      out.push(`${pfx}${n}`);
    }
    setBulkText(out.join('\n'));
  }

  async function submitBulk() {
    if (!online) {
      setMsg('Please ensure network connection');
      return;
    }
    const lines = bulkText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) {
      setMsg('Paste or generate at least one item');
      return;
    }

    try {
      const uid = userId ?? (await getSession()).uid;
      if (!uid) {
        setMsg('Missing user session');
        return;
      }
      if (tab === 'equipment') {
        // Any non-empty ID is allowed.
        for (const raw of lines) {
          const id = raw.toUpperCase();
          const dupSite = (equipRows || []).some((r) => r.is_site_asset && String(r.equipment_id || '').toUpperCase() === id);
          if (dupSite) continue;
          await api('/api/equipment', {
            method: 'POST',
            body: JSON.stringify({ user_id: userId ?? (await getSession()).uid, site_id: siteId ?? (await getSession()).sid, type, equipment_id: raw.toUpperCase() }),
          });
        }
      } else {
        for (const raw of lines) {
          const nm = String(raw || '').trim();
          const dupSite = (locRows || []).some((r) => r.is_site_asset && String(r.name || '').trim().toLowerCase() === nm.toLowerCase());
          if (dupSite) continue;
          await api('/api/locations', {
            method: 'POST',
            body: JSON.stringify({ user_id: userId ?? (await getSession()).uid, site_id: siteId ?? (await getSession()).sid, name: raw, type: locationType }),
          });
        }
      }

      setBulkOpen(false);
      setBulkText('');
      setMsg('Bulk add complete');
      await refreshLists(uid || 0);
    } catch {
      setMsg('Bulk add failed');
    }
  }

  return (
    <div>
      <Toast />
      <Header />

      <div className="p-6 max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <div className="card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">Site Assets Hub</div>
              <div className="text-sm text-[color:var(--muted)] mt-1">
                Manage the equipment and location lists used across Spectatore.
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--muted)]">
                <span className="px-2 py-1 rounded-lg border border-[color:var(--hairline)] bg-white/60">
                  Site: <strong className="text-slate-800">{siteLabel || '—'}</strong>
                </span>
                <span className="px-2 py-1 rounded-lg border border-[color:var(--hairline)] bg-white/60">
                  {equipRows.length} equipment
                </span>
                <span className="px-2 py-1 rounded-lg border border-[color:var(--hairline)] bg-white/60">
                  {locRows.length} locations
                </span>
                {!online && (
                  <span className="px-2 py-1 rounded-lg border border-red-200 bg-red-50 text-red-700">
                    Offline
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button className="btn" type="button" onClick={() => setBulkOpen(true)}>
                Bulk add
              </button>
              <button className="btn btn-primary" type="button" onClick={openCreate}>
                + Add
              </button>
            </div>
          </div>
        </div>

        {/* Tabs + tools */}
        <div className="card p-4">
          <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`btn ${tab === 'equipment' ? 'btn-primary' : ''}`}
                onClick={() => {
                  setTab('equipment');
                  setQuery('');
                }}
              >
                Equipment
              </button>
              <button
                type="button"
                className={`btn ${tab === 'locations' ? 'btn-primary' : ''}`}
                onClick={() => {
                  setTab('locations');
                  setQuery('');
                }}
              >
                Locations
              </button>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <input
                className="input w-full sm:w-64"
                placeholder={`Search ${tab}...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {tab === 'equipment' ? (
                <select className="input" value={equipTypeFilter} onChange={(e) => setEquipTypeFilter(e.target.value)}>
                  <option value="All">All types</option>
                  {EQUIP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="input"
                  value={locTypeFilter}
                  onChange={(e) => setLocTypeFilter(e.target.value as any)}
                >
                  <option value="All">All types</option>
                  <option value="Heading">Heading</option>
                  <option value="Stope">Stope</option>
                  <option value="Stockpile">Stockpile</option>
                </select>
              )}

              <label className="flex items-center gap-2 text-xs text-[color:var(--muted)] select-none">
                <input
                  type="checkbox"
                  checked={showSiteAssets}
                  onChange={(e) => setShowSiteAssets(e.target.checked)}
                />
                Show site lists
              </label>
            </div>
          </div>
        </div>

        {/* Content grid */}
        <div className="grid md:grid-cols-2 gap-4">
          {tab === 'equipment' ? (
            <div className="card p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold">Equipment</div>
                <div className="text-xs text-[color:var(--muted)]">
                  {groupedEquipment.user.length} yours{showSiteAssets ? ` • ${groupedEquipment.site.length} site` : ''}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="px-2 py-1 rounded-full border border-[color:var(--hairline)] bg-white/60">Yours</span>
                <span className="px-2 py-1 rounded-full border border-[color:var(--hairline)] bg-white/60">
                  Site (read-only) <span className="ml-1" aria-hidden>🔒</span>
                </span>
              </div>

              <div className="mt-3 space-y-4">
                {/* Your equipment */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-semibold">Your equipment</div>
                    <div className="text-xs text-[color:var(--muted)]">{groupedEquipment.user.length}</div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {groupedEquipment.user.map((e) => (
                      <button
                        key={`u-${e.type}-${e.equipment_id}`}
                        type="button"
                        onClick={() => openEditEquip(e)}
                        className="text-left rounded-2xl border border-[color:var(--hairline)] p-4 transition hover:shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-base font-semibold truncate">{e.equipment_id}</div>
                            <div className="text-xs text-[color:var(--muted)] truncate">{e.type}</div>
                          </div>
                          <span className="text-[11px] px-2 py-1 rounded-lg border border-[color:var(--hairline)] bg-white/60">
                            {activityForType(e.type)}
                          </span>
                        </div>
                      </button>
                    ))}
                    {!groupedEquipment.user.length && (
                      <div className="text-sm text-[color:var(--muted)]">No personal equipment yet.</div>
                    )}
                  </div>
                </div>

                {/* Site equipment */}
                {showSiteAssets && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-semibold">Site equipment (read-only)</div>
                      <div className="text-xs text-[color:var(--muted)]">{groupedEquipment.site.length}</div>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3">
                      {groupedEquipment.site.map((e) => (
                        <div
                          key={`s-${e.type}-${e.equipment_id}`}
                          className="text-left rounded-2xl border border-[color:var(--hairline)] p-4 opacity-95"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="text-base font-semibold truncate">{e.equipment_id}</div>
                                <span className="text-[10px] px-2 py-0.5 rounded-full border border-[color:var(--hairline)] bg-white/70">
                                  Site 🔒
                                </span>
                              </div>
                              <div className="text-xs text-[color:var(--muted)] truncate">{e.type}</div>
                            </div>
                            <span className="text-[11px] px-2 py-1 rounded-lg border border-[color:var(--hairline)] bg-white/60">
                              {activityForType(e.type)}
                            </span>
                          </div>
                        </div>
                      ))}
                      {!groupedEquipment.site.length && (
                        <div className="text-sm text-[color:var(--muted)]">No site equipment assigned.</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="card p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold">Locations</div>
                <div className="text-xs text-[color:var(--muted)]">
                  {groupedLocations.user.length} yours{showSiteAssets ? ` • ${groupedLocations.site.length} site` : ''}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="px-2 py-1 rounded-full border border-[color:var(--hairline)] bg-white/60">Yours</span>
                <span className="px-2 py-1 rounded-full border border-[color:var(--hairline)] bg-white/60">
                  Site (read-only) <span className="ml-1" aria-hidden>🔒</span>
                </span>
              </div>

              <div className="mt-3 space-y-4">
                {/* Your locations */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-semibold">Your locations</div>
                    <div className="text-xs text-[color:var(--muted)]">{groupedLocations.user.length}</div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {groupedLocations.user.map((l) => (
                      <button
                        key={`u-${l.type}-${l.name}`}
                        type="button"
                        onClick={() => openEditLoc(l)}
                        className="text-left rounded-2xl border border-[color:var(--hairline)] p-4 transition hover:shadow-sm"
                      >
                        <div className="min-w-0">
                          <div className="text-base font-semibold truncate">{l.name}</div>
                          <div className="text-xs text-[color:var(--muted)] truncate">{l.type}</div>
                        </div>
                      </button>
                    ))}
                    {!groupedLocations.user.length && (
                      <div className="text-sm text-[color:var(--muted)]">No personal locations yet.</div>
                    )}
                  </div>
                </div>

                {/* Site locations */}
                {showSiteAssets && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-semibold">Site locations (read-only)</div>
                      <div className="text-xs text-[color:var(--muted)]">{groupedLocations.site.length}</div>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3">
                      {groupedLocations.site.map((l) => (
                        <div
                          key={`s-${l.type}-${l.name}`}
                          className="text-left rounded-2xl border border-[color:var(--hairline)] p-4 opacity-95"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="text-base font-semibold truncate">{l.name}</div>
                            <span className="text-[10px] px-2 py-0.5 rounded-full border border-[color:var(--hairline)] bg-white/70">
                              Site 🔒
                            </span>
                          </div>
                          <div className="text-xs text-[color:var(--muted)] truncate">{l.type}</div>
                        </div>
                      ))}
                      {!groupedLocations.site.length && (
                        <div className="text-sm text-[color:var(--muted)]">No site locations assigned.</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Side panel hints / shortcuts */}
          <div className="card p-4">
            <div className="font-semibold">Tips</div>
            <div className="text-sm text-[color:var(--muted)] mt-2 space-y-2">
              <div>
                <strong className="text-slate-800">Bulk add</strong> is perfect for UT01–UT20, LHD01–LHD06, or heading
                lists.
              </div>
              <div>
                Equipment IDs are site-specific — you can use <strong className="text-slate-800">any</strong> naming scheme.
              </div>
              <div>
                Tap a card to <strong className="text-slate-800">edit</strong> or <strong className="text-slate-800">remove</strong>.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close"
          />
	          <div
	            // Mobile: bottom-sheet (easier to read + thumb-friendly). Desktop: right drawer.
	            className="absolute inset-x-0 bottom-0 top-auto h-[85vh] sm:inset-y-0 sm:right-0 sm:left-auto sm:top-0 sm:bottom-auto sm:h-full w-full sm:w-[520px] tv-surface-soft shadow-xl overflow-y-auto rounded-t-3xl sm:rounded-none"
	            style={{ paddingTop: 'calc(env(safe-area-inset-top) + 12px)' }}
	          >
	            <div className="sticky top-0 z-10 tv-surface-soft backdrop-blur px-5 pt-1 pb-3 border-b tv-divider">
	              <div className="mx-auto mt-1 mb-2 h-1 w-10 rounded-full" style={{ background: 'var(--hairline)' }} />
	              <div className="flex items-start justify-between gap-3">
	                <div>
	                  <div className="text-xl font-semibold tracking-tight">
	                    {drawerMode === 'create' ? 'Add' : 'Edit'} {tab === 'equipment' ? 'equipment' : 'location'}
	                  </div>
	                  <div className="text-sm tv-muted mt-1">Site: {siteLabel || '—'}</div>
	                </div>
	                <button type="button" className="btn" onClick={() => setDrawerOpen(false)}>
	                  Close
	                </button>
	              </div>
	            </div>

	            <div className="px-5 pb-6 pt-4 space-y-4" style={{ color: 'var(--text)' }}>
              {tab === 'equipment' ? (
                <>
	                  <div className="rounded-2xl border tv-border tv-surface shadow-sm p-4">
	                    <div className="text-base font-semibold">Equipment</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
	                      <select className="input text-base min-h-[52px]" value={type} onChange={(e) => setType(e.target.value)}>
                        {EQUIP_TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                      <input
	                        className="input text-base min-h-[52px] sm:col-span-2"
                        placeholder="Equipment ID (e.g. UJ01)"
                        value={equipId}
                        onChange={(e) => setEquipId(e.target.value.toUpperCase())}
                      />
                    </div>
		            	<div className="text-sm tv-muted mt-2">
                      Activity: <strong>{activityForType(type)}</strong>
                    </div>
                  </div>

                  {drawerMode === 'edit' && selectedEquip && (
	                    <div className="rounded-2xl border tv-border tv-surface shadow-sm p-4">
	                      <div className="text-base font-semibold">Remove</div>
		            	<div className="text-sm tv-muted mt-1">
                        Removes <strong>{selectedEquip.equipment_id}</strong> from your site list.
                      </div>
                      <button
                        type="button"
                        className="btn w-full mt-3"
                        onClick={async () => {
                          await deleteEquipment(selectedEquip.equipment_id);
                          setDrawerOpen(false);
                        }}
                      >
                        Remove equipment
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <>
	                  <div className="rounded-2xl border tv-border tv-surface shadow-sm p-4">
	                    <div className="text-base font-semibold">Location</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
                      <select
	                        className="input text-base min-h-[52px]"
                        value={locationType}
                        onChange={(e) => setLocationType(e.target.value as any)}
                      >
                        <option value="Heading">Heading</option>
                        <option value="Stope">Stope</option>
                        <option value="Stockpile">Stockpile</option>
                      </select>
                      <input
	                        className="input text-base min-h-[52px] sm:col-span-2"
                        placeholder="Location name"
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                      />
                    </div>
                  </div>

                  {drawerMode === 'edit' && selectedLoc && (
	                    <div className="rounded-2xl border tv-border tv-surface shadow-sm p-4">
	                      <div className="text-base font-semibold">Remove</div>
	                      <div className="text-sm tv-muted mt-1">
                        Removes <strong>{selectedLoc.name}</strong> from your site list.
                      </div>
                      <button
                        type="button"
                        className="btn w-full mt-3"
                        onClick={async () => {
                          await deleteLocation(selectedLoc.name);
                          setDrawerOpen(false);
                        }}
                      >
                        Remove location
                      </button>
                    </div>
                  )}
                </>
              )}

              {!online && (
                <div className="rounded-2xl border border-red-400/30" style={{ background: 'rgba(255, 59, 48, 0.10)', color: 'rgba(255, 59, 48, 0.95)' }}>
                  <div className="text-sm p-3">
                  You are currently offline. Please reconnect to save changes.
                  </div>
                </div>
              )}

	              <button className="btn btn-primary w-full text-base" onClick={submitDrawer} type="button">
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk modal */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            onClick={() => setBulkOpen(false)}
            aria-label="Close"
          />
          <div className="absolute inset-x-3 top-10 mx-auto max-w-2xl bg-white shadow-xl rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">Bulk add</div>
	                      <div className="text-sm text-slate-600 mt-1">
                  {tab === 'equipment'
                    ? 'Paste equipment IDs (one per line), or generate a range.'
                    : 'Paste locations (one per line).'}
                </div>
              </div>
              <button type="button" className="btn" onClick={() => setBulkOpen(false)}>
                Close
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {tab === 'equipment' && (
                <div className="rounded-2xl border border-[color:var(--hairline)] p-4">
                  <div className="text-sm font-semibold">Range generator</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
                    <input className="input" value={rangePrefix} onChange={(e) => setRangePrefix(e.target.value)} placeholder="Prefix" />
                    <input className="input" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} placeholder="From" />
                    <input className="input" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} placeholder="To" />
                    <input className="input" value={rangePad} onChange={(e) => setRangePad(e.target.value)} placeholder="Pad" />
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-3">
                    <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                      {EQUIP_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <button type="button" className="btn" onClick={generateRange}>
                      Generate
                    </button>
                  </div>
                </div>
              )}

              {tab === 'locations' && (
                <div className="rounded-2xl border border-[color:var(--hairline)] p-4">
                  <div className="text-sm font-semibold">Location type</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
                    <select
                      className="input"
                      value={locationType}
                      onChange={(e) => setLocationType(e.target.value as any)}
                    >
                      <option value="Heading">Heading</option>
                      <option value="Stope">Stope</option>
                      <option value="Stockpile">Stockpile</option>
                    </select>
                    <div className="text-xs text-[color:var(--muted)] flex items-center">
                      Each line becomes a location of this type.
                    </div>
                  </div>
                </div>
              )}

              <textarea
                className="input w-full min-h-[180px]"
                placeholder={tab === 'equipment' ? 'UT01\nUT02\nUT03' : '101\n102\n103'}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
              />

              <button className="btn btn-primary w-full" type="button" onClick={submitBulk}>
                Add items
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
