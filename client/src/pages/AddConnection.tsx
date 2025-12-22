import Header from '../components/Header';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

export default function AddConnection() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [uid, setUid] = useState(0);
  const { setMsg, Toast } = useToast();
  const lastQueryRef = useRef<string>('');

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');
      setUid(session?.user_id || 0);
    })();
  }, []);

  useEffect(() => {
    const query = q.trim();
    // Clear results quickly when input is empty
    if (!query) {
      lastQueryRef.current = '';
      setResults([]);
      setLoading(false);
      return;
    }

    // Debounce to avoid hammering the API on every keystroke
    const t = window.setTimeout(async () => {
      try {
        setLoading(true);
        lastQueryRef.current = query;
        const res = await api(`/api/user/search?name=${encodeURIComponent(query)}`);

        // Only apply results if this is still the latest query
        if (lastQueryRef.current === query) {
          setResults(res.items || []);
        }
      } catch {
        // keep quiet; toast isn't needed for every keystroke failure
        if (lastQueryRef.current === query) setResults([]);
      } finally {
        if (lastQueryRef.current === query) setLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(t);
  }, [q]);

  async function add(id: number) {
    const db = await getDB();
    const session = await db.get('session', 'auth');
    const uid = session?.user_id || 0;
    if (!uid) {
      setMsg('Please TAG IN again');
      return;
    }
    if (id === uid) {
      setMsg("You can't add yourself as a crew member");
      return;
    }
    await api(`/api/connections/request`, {
      method: 'POST',
      body: JSON.stringify({ requester_id: uid, addressee_id: id }),
    });
    setMsg('Crew member request sent');
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-xl mx-auto space-y-3">
        <div className="card space-y-3">
          <div className="text-sm text-slate-600">Search crew members</div>
          <input
            className="input w-full"
            placeholder="Search Crew Member by name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {loading && <div className="text-xs text-slate-500">Searching…</div>}
        </div>

        <div className="card">
          <ul className="space-y-2">
            {results
              .filter((r: any) => (uid ? r.id !== uid : true))
              .map((r: any) => (
              <li key={r.id} className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{r.name}</div>
                </div>
                <button className="btn btn-primary" onClick={() => add(r.id)}>
                  Add Crew Member
                </button>
              </li>
            ))}
            {!loading && results.length === 0 && q.trim() !== '' && (
              <div className="text-slate-500 text-sm">No results</div>
            )}
            {q.trim() === '' && <div className="text-slate-500 text-sm">Start typing to search</div>}
          </ul>
        </div>

        <button className="btn w-full" onClick={() => nav('/Connections')}>
          BACK
        </button>
      </div>
    </div>
  );
}
