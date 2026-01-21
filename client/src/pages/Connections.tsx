import Header from '../components/Header';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

type TabKey = 'crew' | 'incoming' | 'outgoing' | 'invite';

function getTabFromSearch(search: string): TabKey {
  try {
    const sp = new URLSearchParams(search);
    const t = (sp.get('tab') || '').toLowerCase();
    if (t === 'incoming') return 'incoming';
    if (t === 'outgoing') return 'outgoing';
    if (t === 'invite') return 'invite';
    return 'crew';
  } catch {
    return 'crew';
  }
}

export default function Connections() {
  const location = useLocation();
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [tab, setTab] = useState<TabKey>(() => getTabFromSearch(window.location.search));

  const [incoming, setIncoming] = useState<any[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [accepted, setAccepted] = useState<any[]>([]);

  const [removeId, setRemoveId] = useState<number | null>(null);
  const [removeName, setRemoveName] = useState<string>('');

  // Invite/search state
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [uid, setUid] = useState(0);
  const lastQueryRef = useRef<string>('');

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');
      setUid(session?.user_id || 0);
    })();
  }, []);

  async function reloadConnections() {
    // Server infers the authed user (no query param required)
    const inc = await api(`/api/connections/incoming`);
    const out = await api(`/api/connections/outgoing`);
    const acc = await api(`/api/connections/accepted`);
    setIncoming(inc.items || []);
    setOutgoing(out.items || []);
    setAccepted(acc.items || []);
  }

  useEffect(() => {
    (async () => {
      await reloadConnections();
    })();
  }, []);

  // Sync tab from URL (?tab=crew|incoming|outgoing|invite)
  useEffect(() => {
    setTab(getTabFromSearch(location.search));
  }, [location.search]);

  const tabTitle = useMemo(() => {
    if (tab === 'crew') return 'Your Crew';
    if (tab === 'incoming') return 'Crew Requests';
    if (tab === 'outgoing') return 'Sent Requests';
    return 'Invite Crew';
  }, [tab]);

  async function accept(id: number) {
    await api(`/api/connections/${id}/accept`, { method: 'POST' });
    setMsg('Request accepted');
    await reloadConnections();
    window.dispatchEvent(new Event('spectatore:connections'));
  }

  async function decline(id: number) {
    await api(`/api/connections/${id}/decline`, { method: 'POST' });
    setMsg('Request declined');
    await reloadConnections();
    window.dispatchEvent(new Event('spectatore:connections'));
  }

  async function removeAccepted() {
    if (!removeId) return;
    await api(`/api/connections/${removeId}/remove`, { method: 'POST' });
    setMsg('Removed from your crew');
    setRemoveId(null);
    setRemoveName('');
    await reloadConnections();
    window.dispatchEvent(new Event('spectatore:connections'));
  }

  // Invite search debounce
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      lastQueryRef.current = '';
      setResults([]);
      setSearching(false);
      return;
    }

    const t = window.setTimeout(async () => {
      try {
        setSearching(true);
        lastQueryRef.current = query;
        const res = await api(`/api/user/search?name=${encodeURIComponent(query)}`);
        if (lastQueryRef.current === query) setResults(res.items || []);
      } catch {
        if (lastQueryRef.current === query) setResults([]);
      } finally {
        if (lastQueryRef.current === query) setSearching(false);
      }
    }, 250);

    return () => window.clearTimeout(t);
  }, [q]);

  async function sendInvite(id: number) {
    const db = await getDB();
    const session = await db.get('session', 'auth');
    const requesterId = session?.user_id || 0;
    if (!requesterId) {
      setMsg('Please TAG IN again');
      return;
    }
    if (id === requesterId) {
      setMsg("You can't add yourself as a crew member");
      return;
    }
    await api(`/api/connections/request`, {
      method: 'POST',
      body: JSON.stringify({ requester_id: requesterId, addressee_id: id }),
    });
    setMsg('Crew member request sent');
    // keep user on invite tab but refresh outgoing list
    await reloadConnections();
    nav('/Connections?tab=outgoing');
  }

  function goto(t: TabKey) {
    setTab(t);
    nav(`/Connections?tab=${t}`);
  }

  return (
    <div>
      <Toast />
      <Header />

      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <div className="card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-lg font-semibold">Crew Hub</div>
              <div className="text-sm text-slate-600 mt-1">
                Manage your crew, requests, and invites in one place.
              </div>
            </div>
            <button className="btn btn-secondary flex-shrink-0" onClick={() => nav('/Main')}>
              Back
            </button>
          </div>

          <div className="mt-4 flex gap-2 border-b border-slate-200">
            <button
              onClick={() => goto('crew')}
              className={`px-3 py-2 text-sm ${tab === 'crew' ? 'border-b-2 border-slate-900 font-semibold' : ''}`}
            >
              Crew
              {accepted.length > 0 ? <span className="ml-2 text-xs text-slate-500">({accepted.length})</span> : null}
            </button>
            <button
              onClick={() => goto('incoming')}
              className={`px-3 py-2 text-sm ${tab === 'incoming' ? 'border-b-2 border-slate-900 font-semibold' : ''}`}
            >
              Requests
              {incoming.length > 0 ? (
                <span className="ml-2 text-xs text-slate-500">({incoming.length})</span>
              ) : null}
            </button>
            <button
              onClick={() => goto('outgoing')}
              className={`px-3 py-2 text-sm ${tab === 'outgoing' ? 'border-b-2 border-slate-900 font-semibold' : ''}`}
            >
              Sent
              {outgoing.length > 0 ? (
                <span className="ml-2 text-xs text-slate-500">({outgoing.length})</span>
              ) : null}
            </button>
            <button
              onClick={() => goto('invite')}
              className={`px-3 py-2 text-sm ${tab === 'invite' ? 'border-b-2 border-slate-900 font-semibold' : ''}`}
            >
              Invite
            </button>
          </div>

          <div className="mt-4">
            <h2 className="text-base font-semibold">{tabTitle}</h2>

            {tab === 'crew' && (
              <div className="mt-3">
                {accepted.length === 0 ? (
                  <div className="text-slate-500 text-sm">No crew mates yet</div>
                ) : (
                  <ul className="space-y-2">
                    {accepted.map((r: any) => (
                      <li key={r.id} className="flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{r.name || 'Unknown'}</div>
                          {r.work_site_name ? (
                            <div className="text-xs text-slate-500 truncate">{r.work_site_name}</div>
                          ) : null}
                        </div>
                        <button
                          className="ml-3 w-8 h-8 rounded-full border flex items-start justify-center text-slate-600 hover:bg-slate-50"
                          title="Remove"
                          onClick={() => {
                            setRemoveId(r.id);
                            setRemoveName(r.name || 'this crew member');
                          }}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === 'incoming' && (
              <div className="mt-3">
                {incoming.length === 0 ? (
                  <div className="text-slate-500 text-sm">No crew requests</div>
                ) : (
                  <ul className="space-y-2">
                    {incoming.map((r: any) => (
                      <li key={r.id} className="flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{r.name || 'Unknown'}</div>
                          {r.work_site_name ? (
                            <div className="text-xs text-slate-500 truncate">{r.work_site_name}</div>
                          ) : null}
                        </div>
                        <div className="flex gap-2">
                          <button className="btn" onClick={() => accept(r.id)}>
                            Accept
                          </button>
                          <button className="btn" onClick={() => decline(r.id)}>
                            Decline
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === 'outgoing' && (
              <div className="mt-3">
                {outgoing.length === 0 ? (
                  <div className="text-slate-500 text-sm">No sent requests</div>
                ) : (
                  <ul className="space-y-2">
                    {outgoing.map((r: any) => (
                      <li key={r.id} className="flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{r.name || 'Unknown'}</div>
                          {r.work_site_name ? (
                            <div className="text-xs text-slate-500 truncate">{r.work_site_name}</div>
                          ) : null}
                        </div>
                        <div className="text-xs text-slate-500">Pending</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === 'invite' && (
              <div className="mt-3 space-y-3">
                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="text-sm text-slate-600">Search crew members</div>
                  <input
                    className="input w-full mt-2"
                    placeholder="Search by name"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                  {searching && <div className="text-xs text-slate-500 mt-2">Searching…</div>}
                </div>

                <div className="rounded-xl border border-slate-200 p-4">
                  <ul className="space-y-2">
                    {results
                      .filter((r: any) => (uid ? r.id !== uid : true))
                      .map((r: any) => (
                        <li key={r.id} className="flex items-center justify-between">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{r.name}</div>
                          </div>
                          <button className="btn btn-primary" onClick={() => sendInvite(r.id)}>
                            Invite
                          </button>
                        </li>
                      ))}
                    {!searching && results.length === 0 && q.trim() !== '' && (
                      <div className="text-slate-500 text-sm">No results</div>
                    )}
                    {q.trim() === '' && <div className="text-slate-500 text-sm">Start typing to search</div>}
                  </ul>
                </div>

                <div className="text-xs text-slate-500">
                  Tip: once connected, you can compare against a specific crew member inside <strong>You vs Crew</strong>.
                </div>
              </div>
            )}
          </div>
        </div>

        {removeId !== null && (
          <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-[1000] overflow-auto pt-6 pb-24">
            <div className="card w-full max-w-sm">
              <div className="text-lg font-semibold mb-2">Remove crew mate?</div>
              <div className="text-sm text-slate-600 mb-4">
                Remove <span className="font-medium">{removeName}</span> from your crew?
              </div>
              <div className="flex gap-2">
                <button className="btn btn-primary flex-1" onClick={removeAccepted}>
                  Yes, remove
                </button>
                <button
                  className="btn flex-1"
                  onClick={() => {
                    setRemoveId(null);
                    setRemoveName('');
                  }}
                >
                  No
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
