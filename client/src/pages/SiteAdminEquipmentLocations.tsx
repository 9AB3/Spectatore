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

type Tab = 'equipment' | 'locations';

export default function SiteAdminEquipmentLocations() {
  const { setMsg, Toast } = useToast();
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState<string>('');
  const [tab, setTab] = useState<Tab>('equipment');
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('All');
  const [filterLocType, setFilterLocType] = useState<LocationRow['type'] | 'All'>('All');

  const [equipRows, setEquipRows] = useState<EquipRow[]>([]);
  const [locRows, setLocRows] = useState<LocationRow[]>([]);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [selectedEquip, setSelectedEquip] = useState<EquipRow | null>(null);
  const [selectedLoc, setSelectedLoc] = useState<LocationRow | null>(null);

  // Form state
  const [equipType, setEquipType] = useState(EQUIP_TYPES[0]);
  const [equipId, setEquipId] = useState('');
  const [locName, setLocName] = useState('');
  const [locType, setLocType] = useState<LocationRow['type']>('Heading');

  // Bulk add
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [rangePrefix, setRangePrefix] = useState('UT');
  const [rangeStart, setRangeStart] = useState('1');
  const [rangeEnd, setRangeEnd] = useState('10');
  const [rangePad, setRangePad] = useState('2');

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

  const filteredEquip = useMemo(() => {
    const q = search.trim().toUpperCase();
    return equipListSorted.filter((r) => {
      if (filterType !== 'All' && r.type !== filterType) return false;
      if (!q) return true;
      return (r.equipment_id || '').toUpperCase().includes(q) || (r.type || '').toUpperCase().includes(q);
    });
  }, [equipListSorted, search, filterType]);

  const filteredLocs = useMemo(() => {
    const q = search.trim().toUpperCase();
    return locListSorted.filter((r) => {
      if (filterLocType !== 'All' && r.type !== filterLocType) return false;
      if (!q) return true;
      return (r.name || '').toUpperCase().includes(q) || String(r.type || '').toUpperCase().includes(q);
    });
  }, [locListSorted, search, filterLocType]);

  function openCreate(which: Tab) {
    setTab(which);
    setMode('create');
    setSelectedEquip(null);
    setSelectedLoc(null);
    setEquipType(EQUIP_TYPES[0]);
    setEquipId('');
    setLocName('');
    setLocType('Heading');
    setDrawerOpen(true);
  }

  function openEditEquip(r: EquipRow) {
    setTab('equipment');
    setMode('edit');
    setSelectedEquip(r);
    setSelectedLoc(null);
    setEquipType(r.type || EQUIP_TYPES[0]);
    setEquipId(r.equipment_id || '');
    setDrawerOpen(true);
  }

  function openEditLoc(r: LocationRow) {
    setTab('locations');
    setMode('edit');
    setSelectedLoc(r);
    setSelectedEquip(null);
    setLocName(r.name || '');
    setLocType((r.type as any) || 'Heading');
    setDrawerOpen(true);
  }

  async function saveDrawer() {
    try {
      if (!site) {
        setMsg('Missing site');
        return;
      }
      if (tab === 'equipment') {
        if (!equipId) {
          setMsg('Enter equipment ID');
          return;
        }
        if (!isEquipIdValid(equipId)) {
          setMsg('Equipment ID must be 2 letters + 2 digits (e.g. UJ01)');
          return;
        }
        const payload = { site, type: equipType, equipment_id: equipId.toUpperCase() };
        // Edit mode must update the existing row (including renames) instead of inserting a new one.
        if (mode === 'edit' && selectedEquip?.id) {
          await api(`/api/site-admin/admin-equipment/${selectedEquip.id}` as any, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
        } else {
          await api('/api/site-admin/admin-equipment', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }
      } else {
        if (!locName.trim()) {
          setMsg('Enter location name');
          return;
        }
        const payload = { site, name: locName.trim(), type: locType };
        if (mode === 'edit' && selectedLoc?.id) {
          await api(`/api/site-admin/admin-locations/${selectedLoc.id}` as any, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
        } else {
          await api('/api/site-admin/admin-locations', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }
      }

      setDrawerOpen(false);
      setMsg('Saved');
      await refresh();
    } catch {
      setMsg('Submission failed');
    }
  }

  async function archiveSelected() {
    try {
      if (!site) return;
      if (tab === 'equipment' && (selectedEquip?.equipment_id || equipId)) {
        const equipment_id = (selectedEquip?.equipment_id || equipId).toUpperCase();
        await api('/api/site-admin/admin-equipment', {
          method: 'DELETE',
          body: JSON.stringify({ site, equipment_id }),
        });
      }
      if (tab === 'locations' && (selectedLoc?.name || locName)) {
        const name = (selectedLoc?.name || locName).trim();
        await api('/api/site-admin/admin-locations', {
          method: 'DELETE',
          body: JSON.stringify({ site, name }),
        });
      }
      setDrawerOpen(false);
      setMsg('Archived');
      await refresh();
    } catch {
      setMsg('Failed to archive');
    }
  }

  function generateRange() {
    const p = (rangePrefix || '').toUpperCase().replace(/\s+/g, '');
    const s = Math.max(0, parseInt(rangeStart || '0', 10) || 0);
    const e = Math.max(0, parseInt(rangeEnd || '0', 10) || 0);
    const pad = Math.max(0, Math.min(6, parseInt(rangePad || '0', 10) || 0));
    const out: string[] = [];
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    for (let i = lo; i <= hi; i++) {
      out.push(`${p}${String(i).padStart(pad, '0')}`);
    }
    setBulkText(out.join('\n'));
  }

  async function submitBulk() {
    try {
      if (!site) {
        setMsg('Missing site');
        return;
      }
      const items = bulkText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!items.length) {
        setMsg('Nothing to add');
        return;
      }

      if (tab === 'equipment') {
        for (const id of items) {
          const up = id.toUpperCase();
          if (!isEquipIdValid(up)) continue;
          await api('/api/site-admin/admin-equipment', {
            method: 'POST',
            body: JSON.stringify({ site, type: equipType, equipment_id: up }),
          });
        }
      } else {
        for (const name of items) {
          await api('/api/site-admin/admin-locations', {
            method: 'POST',
            body: JSON.stringify({ site, name, type: locType }),
          });
        }
      }

      setBulkOpen(false);
      setBulkText('');
      setMsg('Bulk add complete');
      await refresh();
    } catch {
      setMsg('Bulk add failed');
    }
  }

  return (
    <div>
      <Toast />
      <Header />

      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <div className="card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">Site Assets Hub</div>
              <div className="text-sm text-[color:var(--muted)] mt-1">
                Manage site-wide equipment IDs and locations used across drop-downs, validation, and reporting.
              </div>
            </div>

            <div className="min-w-[220px]">
              <div className="text-xs text-[color:var(--muted)] mb-1">Active site</div>
              <select className="input w-full" value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`btn ${tab === 'equipment' ? 'btn-primary' : ''}`}
              onClick={() => setTab('equipment')}
            >
              Equipment ({equipRows.length})
            </button>
            <button
              type="button"
              className={`btn ${tab === 'locations' ? 'btn-primary' : ''}`}
              onClick={() => setTab('locations')}
            >
              Locations ({locRows.length})
            </button>

            <div className="flex-1" />

            <button className="btn" type="button" onClick={() => openCreate(tab)}>
              + Add
            </button>
            <button className="btn" type="button" onClick={() => setBulkOpen(true)}>
              Bulk add
            </button>
          </div>
        </div>

        <div className="card p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <input
              className="input flex-1"
              placeholder={tab === 'equipment' ? 'Search equipment (e.g. UT01, Truck)…' : 'Search locations (e.g. 1010, Heading)…'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            {tab === 'equipment' ? (
              <select className="input sm:w-56" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                <option value="All">All types</option>
                {EQUIP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : (
              <select
                className="input sm:w-56"
                value={filterLocType}
                onChange={(e) => setFilterLocType(e.target.value as any)}
              >
                <option value="All">All types</option>
                <option value="Heading">Heading</option>
                <option value="Stope">Stope</option>
                <option value="Stockpile">Stockpile</option>
                <option value="">—</option>
              </select>
            )}
          </div>

          {tab === 'equipment' ? (
            <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredEquip.map((r) => (
                <button
                  key={`${r.type}-${r.equipment_id}`}
                  type="button"
                  className="card p-4 text-left hover:shadow-md transition"
                  onClick={() => openEditEquip(r)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-base font-semibold">{r.equipment_id}</div>
                      <div className="text-xs text-[color:var(--muted)] mt-1">{r.type}</div>
                    </div>
                    <div className="text-xs px-2 py-1 rounded-lg border border-[color:var(--hairline)] text-[color:var(--muted)]">
                      {activityForType(r.type)}
                    </div>
                  </div>
                </button>
              ))}
              {!filteredEquip.length && <div className="text-sm text-[color:var(--muted)]">No equipment found.</div>}
            </div>
          ) : (
            <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredLocs.map((r) => (
                <button
                  key={`${r.type}-${r.name}`}
                  type="button"
                  className="card p-4 text-left hover:shadow-md transition"
                  onClick={() => openEditLoc(r)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-base font-semibold truncate">{r.name}</div>
                      <div className="text-xs text-[color:var(--muted)] mt-1">{r.type || '—'}</div>
                    </div>
                  </div>
                </button>
              ))}
              {!filteredLocs.length && <div className="text-sm text-[color:var(--muted)]">No locations found.</div>}
            </div>
          )}
        </div>
      </div>

      {/* Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-full sm:w-[420px] bg-white shadow-2xl p-5 overflow-auto">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-[color:var(--muted)]">{mode === 'create' ? 'Add' : 'Edit'}</div>
                <div className="text-lg font-semibold">{tab === 'equipment' ? 'Equipment' : 'Location'}</div>
              </div>
              <button className="btn" type="button" onClick={() => setDrawerOpen(false)}>
                Close
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {tab === 'equipment' ? (
                <>
                  <div>
                    <div className="text-xs text-[color:var(--muted)] mb-1">Type</div>
                    <select className="input w-full" value={equipType} onChange={(e) => setEquipType(e.target.value)}>
                      {EQUIP_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <div className="text-xs text-[color:var(--muted)] mt-2">
                      Activity: <strong>{activityForType(equipType)}</strong>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-[color:var(--muted)] mb-1">Equipment ID</div>
                    <input
                      className="input w-full"
                      placeholder="e.g. UT01"
                      value={equipId}
                      onChange={(e) => setEquipId(e.target.value.toUpperCase())}
                    />
                    <div className="text-xs text-[color:var(--muted)] mt-2">
                      Format: 2 letters + 2 digits
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-[color:var(--muted)] mb-1">Type</div>
                    <select className="input w-full" value={locType} onChange={(e) => setLocType(e.target.value as any)}>
                      <option value="Heading">Heading</option>
                      <option value="Stope">Stope</option>
                      <option value="Stockpile">Stockpile</option>
                      <option value="">—</option>
                    </select>
                  </div>
                  <div>
                    <div className="text-xs text-[color:var(--muted)] mb-1">Name</div>
                    <input
                      className="input w-full"
                      placeholder="e.g. 1010"
                      value={locName}
                      onChange={(e) => setLocName(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div className="pt-2 flex gap-2">
                <button className="btn btn-primary flex-1" type="button" onClick={saveDrawer}>
                  Save
                </button>
                {mode === 'edit' && (
                  <button className="btn flex-1" type="button" onClick={archiveSelected}>
                    Archive
                  </button>
                )}
              </div>

              <div className="text-xs text-[color:var(--muted)]">
                Tip: “Archive” removes it from dropdown lists (site-wide).
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bulk add */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setBulkOpen(false)} />
          <div className="absolute left-1/2 top-1/2 w-[min(720px,92vw)] -translate-x-1/2 -translate-y-1/2 bg-white shadow-2xl card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">Bulk add {tab === 'equipment' ? 'equipment' : 'locations'}</div>
                <div className="text-sm text-[color:var(--muted)] mt-1">
                  Paste one per line, or generate a range.
                </div>
              </div>
              <button className="btn" type="button" onClick={() => setBulkOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid md:grid-cols-3 gap-3 mt-4">
              <div className="md:col-span-1 space-y-3">
                {tab === 'equipment' && (
                  <div className="rounded-xl border border-[color:var(--hairline)] p-3">
                    <div className="text-xs text-[color:var(--muted)] mb-1">Equipment type</div>
                    <select className="input w-full" value={equipType} onChange={(e) => setEquipType(e.target.value)}>
                      {EQUIP_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <div className="text-xs text-[color:var(--muted)] mt-2">
                      Activity: <strong>{activityForType(equipType)}</strong>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-[color:var(--hairline)] p-3">
                  <div className="font-medium">Range generator</div>
                  <div className="text-xs text-[color:var(--muted)] mt-1">
                    Creates {tab === 'equipment' ? 'UT01–UT20 style' : 'a list of names'}.
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <input className="input" placeholder="Prefix" value={rangePrefix} onChange={(e) => setRangePrefix(e.target.value)} />
                    <input className="input" placeholder="Pad" value={rangePad} onChange={(e) => setRangePad(e.target.value)} />
                    <input className="input" placeholder="Start" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
                    <input className="input" placeholder="End" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
                  </div>
                  <button className="btn w-full mt-3" type="button" onClick={generateRange}>
                    Generate
                  </button>
                </div>

                <div className="rounded-xl border border-[color:var(--hairline)] p-3">
                  <div className="text-xs text-[color:var(--muted)] mb-1">{tab === 'locations' ? 'Location type' : 'Validation'}</div>
                  {tab === 'locations' ? (
                    <select className="input w-full" value={locType} onChange={(e) => setLocType(e.target.value as any)}>
                      <option value="Heading">Heading</option>
                      <option value="Stope">Stope</option>
                      <option value="Stockpile">Stockpile</option>
                      <option value="">—</option>
                    </select>
                  ) : (
                    <div className="text-xs text-[color:var(--muted)]">
                      Invalid equipment IDs (not 2 letters + 2 digits) are skipped.
                    </div>
                  )}
                </div>
              </div>

              <div className="md:col-span-2">
                <textarea
                  className="input w-full h-[280px] font-mono"
                  placeholder={tab === 'equipment' ? 'UT01\nUT02\nUT03' : '1010\n1015\n1020'}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                />
                <div className="flex gap-2 mt-3">
                  <button className="btn btn-primary flex-1" type="button" onClick={submitBulk}>
                    Add all
                  </button>
                  <button className="btn flex-1" type="button" onClick={() => setBulkText('')}>
                    Clear
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
