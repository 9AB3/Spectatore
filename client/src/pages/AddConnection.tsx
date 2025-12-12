import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

export default function AddConnection() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const { setMsg, Toast } = useToast();

  async function search() {
    const res = await api(`/api/user/search?name=${encodeURIComponent(q)}`);
    setResults(res.items || []);
  }

  async function add(userId: number) {
    const db = await getDB();
    const session = await db.get('session', 'auth');
    const requester = session?.user_id;
    await api('/api/connections/request', {
      method: 'POST',
      body: JSON.stringify({ requester_id: requester, addressee_id: userId }),
    });
    setMsg('Crew member request sent');
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-xl mx-auto space-y-3">
        <div className="card space-y-3">
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Search Crew Member by name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="btn btn-primary" onClick={search}>
              Search
            </button>
          </div>
        </div>
        <div className="card">
          <ul className="space-y-2">
            {results.map((r: any) => (
              <li key={r.id} className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-slate-500">{r.email}</div>
                </div>
                <button className="btn btn-primary" onClick={() => add(r.id)}>
                  Add Crew Member
                </button>
              </li>
            ))}
            {results.length === 0 && <div className="text-slate-500 text-sm">No results</div>}
          </ul>
        </div>
      </div>
    </div>
  );
}
