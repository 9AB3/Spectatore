import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Header from '../components/Header';
import useToast from '../hooks/useToast';
import ACTIVITIES from '../data/activities.json';

type ExpectedWorkRow = {
  id: number;
  dn: string; // '*', 'D', 'N'
  dow: number; // -1 or 0..6
  activity: string;
  sub_activity: string; // '*' or concrete
  enabled: boolean;
  created_at?: string;
};

const DOW: { k: number; label: string }[] = [
  { k: 0, label: 'Sun' },
  { k: 1, label: 'Mon' },
  { k: 2, label: 'Tue' },
  { k: 3, label: 'Wed' },
  { k: 4, label: 'Thu' },
  { k: 5, label: 'Fri' },
  { k: 6, label: 'Sat' },
];

function dnLabel(dn: string) {
  if (dn === 'D') return 'Day';
  if (dn === 'N') return 'Night';
  return 'Any';
}

function dowLabel(dow: number) {
  if (dow === -1) return 'All days';
  const hit = DOW.find((d) => d.k === dow);
  return hit ? hit.label : 'All days';
}

function normalizeDn(dn: string) {
  return dn === 'D' || dn === 'N' ? dn : '*';
}

export default function SiteAdminExpectedWork() {
  const { setMsg, Toast } = useToast();
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState<string>('');
  const [rows, setRows] = useState<ExpectedWorkRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Config form state
  const [dn, setDn] = useState<'*' | 'D' | 'N'>('*');
  const [dowSel, setDowSel] = useState<Set<number>>(new Set());
  const [activity, setActivity] = useState<string>('');
  const [subSearch, setSubSearch] = useState('');
  const [subSel, setSubSel] = useState<Set<string>>(new Set());
  const [anySub, setAnySub] = useState(false);

  const activityList = useMemo(() => Object.keys(ACTIVITIES as any), []);

  const subList = useMemo(() => {
    const root: any = (ACTIVITIES as any) || {};
    const subs = activity && root[activity] ? Object.keys(root[activity]) : [];
    const q = subSearch.trim().toLowerCase();
    const out = subs.filter((s: string) => (!q ? true : s.toLowerCase().includes(q)));
    return out.sort((a: string, b: string) => a.localeCompare(b));
  }, [activity, subSearch]);

  async function refresh() {
    if (!site) return;
    setLoading(true);
    try {
      const r = await api(`/api/site-admin/expected-work?site=${encodeURIComponent(site)}`);
      setRows((r?.rows || []) as any);
    } catch (e: any) {
      setRows([]);
      setMsg(e?.message || 'Failed to load expected work');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const s = await api('/api/site-admin/sites');
        const list = (s?.sites || []) as string[];
        setSites(list);
        const first = (list && list[0]) || 'default';
        setSite(first);
        setActivity(Object.keys(ACTIVITIES as any)[0] || '');
      } catch {
        setSites(['default']);
        setSite('default');
        setActivity(Object.keys(ACTIVITIES as any)[0] || '');
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  useEffect(() => {
    // When activity changes, clear selections
    setSubSel(new Set());
    setAnySub(false);
    setSubSearch('');
  }, [activity]);

  function toggleDow(k: number) {
    setDowSel((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  async function addSelected() {
    if (!site) return;
    if (!activity) return setMsg('Choose an activity');

    const dows = (() => {
      if (dowSel.size === 0 || dowSel.size === 7) return [-1];
      return Array.from(dowSel.values()).sort((a, b) => a - b);
    })();

    const subs = (() => {
      if (anySub) return ['*'];
      const list = Array.from(subSel.values()).filter(Boolean);
      return list.length ? list : ['*'];
    })();

    setLoading(true);
    try {
      for (const dow of dows) {
        for (const sub of subs) {
          await api('/api/site-admin/expected-work', {
            method: 'POST',
            body: {
              site,
              dn,
              dow,
              activity,
              sub_activity: sub,
              enabled: true,
            },
          });
        }
      }
      setMsg('Saved expected work rules');
      await refresh();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to save');
    } finally {
      setLoading(false);
    }
  }

  async function setEnabled(r: ExpectedWorkRow, enabled: boolean) {
    if (!site) return;
    try {
      await api(`/api/site-admin/expected-work/${r.id}`, {
        method: 'PATCH',
        body: { site, enabled },
      });
      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled } : x)));
    } catch (e: any) {
      setMsg(e?.message || 'Failed to update');
    }
  }

  async function delRule(r: ExpectedWorkRow) {
    if (!site) return;
    if (!confirm('Delete this expected work rule?')) return;
    try {
      await api(`/api/site-admin/expected-work/${r.id}`, {
        method: 'DELETE',
        body: { site },
      });
      setRows((prev) => prev.filter((x) => x.id !== r.id));
    } catch (e: any) {
      setMsg(e?.message || 'Failed to delete');
    }
  }

  const grouped = useMemo(() => {
    const out: Record<string, ExpectedWorkRow[]> = {};
    for (const r of rows || []) {
      const k = String(r.activity || '');
      if (!out[k]) out[k] = [];
      out[k].push(r);
    }
    for (const k of Object.keys(out)) {
      out[k] = out[k].sort((a, b) => {
        const e = Number(b.enabled) - Number(a.enabled);
        if (e !== 0) return e;
        const dnC = String(a.dn).localeCompare(String(b.dn));
        if (dnC !== 0) return dnC;
        const dw = (a.dow ?? -1) - (b.dow ?? -1);
        if (dw !== 0) return dw;
        return String(a.sub_activity || '').localeCompare(String(b.sub_activity || ''));
      });
    }
    return out;
  }, [rows]);

  return (
    <div className="min-h-screen">
      <Toast />
      <Header title="Expected Work Checklist" subtitle="Configure what should be present day-by-day" />
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        <div className="card">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm opacity-70">Site</div>
            <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
              {(sites || []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="ml-auto flex items-center gap-2">
              <button className="btn" type="button" onClick={refresh} disabled={loading}>
                Refresh
              </button>
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="card">
            <div className="font-bold mb-2">Add expectations</div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs opacity-70 mb-1">DN</div>
                <select className="input" value={dn} onChange={(e) => setDn(normalizeDn(e.target.value) as any)}>
                  <option value="*">Any</option>
                  <option value="D">Day</option>
                  <option value="N">Night</option>
                </select>
              </div>
              <div>
                <div className="text-xs opacity-70 mb-1">Activity</div>
                <select className="input" value={activity} onChange={(e) => setActivity(e.target.value)}>
                  {activityList.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3">
              <div className="text-xs opacity-70 mb-1">Days of week</div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`tv-pill ${dowSel.size === 0 || dowSel.size === 7 ? 'bg-slate-200' : ''}`}
                  onClick={() => setDowSel(new Set())}
                >
                  All
                </button>
                {DOW.map((d) => (
                  <button
                    key={d.k}
                    type="button"
                    className={`tv-pill ${dowSel.has(d.k) ? 'bg-sky-200' : ''}`}
                    onClick={() => toggleDow(d.k)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="text-xs opacity-60 mt-1">Tip: leave blank for “All days”.</div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div className="text-xs opacity-70">Sub-activities</div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={anySub}
                    onChange={(e) => {
                      setAnySub(e.target.checked);
                      if (e.target.checked) setSubSel(new Set());
                    }}
                  />
                  Any sub-activity counts
                </label>
              </div>

              {!anySub ? (
                <>
                  <input
                    className="input mt-2"
                    placeholder="Search sub-activities…"
                    value={subSearch}
                    onChange={(e) => setSubSearch(e.target.value)}
                  />
                  <div className="mt-2 max-h-[280px] overflow-auto border border-[color:var(--hairline)] rounded-xl p-2">
                    {subList.length ? (
                      <div className="space-y-1">
                        {subList.map((s) => {
                          const checked = subSel.has(s);
                          return (
                            <label key={s} className="flex items-center gap-2 text-sm px-2 py-1 rounded-lg hover:bg-[color:var(--surface-2)]">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  setSubSel((prev) => {
                                    const n = new Set(prev);
                                    if (n.has(s)) n.delete(s);
                                    else n.add(s);
                                    return n;
                                  });
                                }}
                              />
                              <span>{s}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-sm opacity-70">No sub-activities for this activity.</div>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="tv-pill"
                      onClick={() => {
                        const all = new Set(subList);
                        setSubSel(all);
                      }}
                    >
                      Select all shown
                    </button>
                    <button type="button" className="tv-pill" onClick={() => setSubSel(new Set())}>
                      Clear
                    </button>
                  </div>
                </>
              ) : (
                <div className="mt-2 text-sm opacity-70">This expectation is satisfied by any sub-activity logged under “{activity}”.</div>
              )}
            </div>

            <div className="mt-4">
              <button
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                type="button"
                onClick={addSelected}
                disabled={loading || !site || !activity}
              >
                Add expectation(s)
              </button>
            </div>
          </div>

          <div className="card">
            <div className="font-bold mb-2">Existing rules</div>
            {loading ? <div className="opacity-70">Loading…</div> : null}

            {rows.length ? (
              <div className="space-y-3">
                {Object.keys(grouped)
                  .sort((a, b) => a.localeCompare(b))
                  .map((act) => (
                    <div key={act} className="tv-tile p-3">
                      <div className="font-semibold mb-2">{act}</div>
                      <div className="space-y-2">
                        {grouped[act].map((r) => (
                          <div key={r.id} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={!!r.enabled}
                              onChange={(e) => setEnabled(r, e.target.checked)}
                              title="Enable/disable"
                            />
                            <div className="text-sm flex-1">
                              <span className="font-semibold">{dnLabel(r.dn)}</span>
                              <span className="opacity-60"> · </span>
                              <span className="font-semibold">{dowLabel(r.dow)}</span>
                              <span className="opacity-60"> · </span>
                              <span>{r.sub_activity === '*' ? 'Any sub-activity' : r.sub_activity}</span>
                            </div>
                            <button
                              type="button"
                              className="tv-pill"
                              onClick={() => delRule(r)}
                              title="Delete"
                            >
                              Delete
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="opacity-70">No expected work rules configured yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
