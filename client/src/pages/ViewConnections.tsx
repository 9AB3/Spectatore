import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

export default function ViewConnections() {
  const { setMsg, Toast } = useToast();
  const [incoming, setIncoming] = useState<any[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [accepted, setAccepted] = useState<any[]>([]);

  async function reloadConnections() {
    const db = await getDB();
    const session = await db.get('session', 'auth');
    const uid = session?.user_id || 0;
    const inc = await api(`/api/connections/incoming?user_id=${uid}`);
    const out = await api(`/api/connections/outgoing?user_id=${uid}`);
    const acc = await api(`/api/connections/accepted?user_id=${uid}`);
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

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <div className="card">
          <h2 className="text-lg font-semibold mb-2">Accepted</h2>
          {accepted.length === 0 ? (
            <div className="text-slate-500 text-sm">No accepted connections</div>
          ) : (
            <ul className="space-y-2">
              {accepted.map((r: any) => (
                <li key={r.id} className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{r.name || 'Unknown'}</div>
                    <div className="text-xs text-slate-600">{r.email}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-2">Incoming Requests</h2>
          {incoming.length === 0 ? (
            <div className="text-slate-500 text-sm">No incoming requests</div>
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

        <div className="card">
          <h2 className="text-lg font-semibold mb-2">Outgoing (Pending)</h2>
          {outgoing.length === 0 ? (
            <div className="text-slate-500 text-sm">No pending requests</div>
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

        <a href="/Connections" className="btn w-full text-center">
          BACK
        </a>
      </div>
    </div>
  );
}
