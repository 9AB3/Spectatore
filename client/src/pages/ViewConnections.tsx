import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type TabKey = 'accepted' | 'incoming' | 'outgoing';

export default function ViewConnections() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [incoming, setIncoming] = useState<any[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [accepted, setAccepted] = useState<any[]>([]);

  const [tab, setTab] = useState<TabKey>('accepted');

  const [removeId, setRemoveId] = useState<number | null>(null);
  const [removeName, setRemoveName] = useState<string>('');

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

  async function accept(id: number) {
    await api(`/api/connections/${id}/accept`, { method: 'POST' });
    setMsg('Request accepted');
    await reloadConnections();
  }

  async function decline(id: number) {
    await api(`/api/connections/${id}/decline`, { method: 'POST' });
    setMsg('Request declined');
    await reloadConnections();
  }

  async function removeAccepted() {
    if (!removeId) return;
    await api(`/api/connections/${removeId}/remove`, { method: 'POST' });
    setMsg('Removed from your crew');
    setRemoveId(null);
    setRemoveName('');
    await reloadConnections();
  }

  const tabTitle = useMemo(() => {
    if (tab === 'accepted') return 'Crew Mates';
    if (tab === 'incoming') return 'Crew Requests';
    return 'Sent Requests';
  }, [tab]);

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <div className="card space-y-3">
          <h2 className="text-lg font-semibold">{tabTitle}</h2>

          <div className="flex gap-2 border-b border-slate-200">
            <button
              onClick={() => setTab('accepted')}
              className={`px-3 py-2 text-sm ${
                tab === 'accepted' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Crew Mates
            </button>
            <button
              onClick={() => setTab('incoming')}
              className={`px-3 py-2 text-sm ${
                tab === 'incoming' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Crew Requests
            </button>
            <button
              onClick={() => setTab('outgoing')}
              className={`px-3 py-2 text-sm ${
                tab === 'outgoing' ? 'border-b-2 border-slate-900 font-semibold' : ''
              }`}
            >
              Sent Requests
            </button>
          </div>

          {tab === 'accepted' && (
            <div>
              {accepted.length === 0 ? (
                <div className="text-slate-500 text-sm">No crew mates yet</div>
              ) : (
                <ul className="space-y-2">
                  {accepted.map((r: any) => (
                    <li key={r.id} className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{r.name || 'Unknown'}</div>
                        <div className="text-xs text-slate-600">{r.email}</div>
                      </div>
                      <button
                        className="ml-3 w-8 h-8 rounded-full border flex items-center justify-center text-slate-600 hover:bg-slate-50"
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
            <div>
              {incoming.length === 0 ? (
                <div className="text-slate-500 text-sm">No crew requests</div>
              ) : (
                <ul className="space-y-2">
                  {incoming.map((r: any) => (
                    <li key={r.id} className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{r.name || 'Unknown'}</div>
                        <div className="text-xs text-slate-600">{r.email}</div>
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
            <div>
              {outgoing.length === 0 ? (
                <div className="text-slate-500 text-sm">No sent requests</div>
              ) : (
                <ul className="space-y-2">
                  {outgoing.map((r: any) => (
                    <li key={r.id} className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{r.name || 'Unknown'}</div>
                        <div className="text-xs text-slate-600">{r.email}</div>
                      </div>
                      <div className="text-xs text-slate-500">Pending</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button className="btn w-full text-center" onClick={() => nav('/Connections')}>
            BACK
          </button>
        </div>

        {removeId !== null && (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
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
