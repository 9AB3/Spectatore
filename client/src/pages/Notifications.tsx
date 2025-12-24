import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type Notif = {
  id: number;
  type: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
  payload_json: any;
};

function fmt(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

export default function Notifications() {
  const { Toast, setMsg } = useToast();
  const [items, setItems] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const r = await api('/api/notifications?limit=80');
      setItems((r?.items || []) as Notif[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function markRead(id: number) {
    await api(`/api/notifications/${id}/read`, { method: 'POST' });
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    window.dispatchEvent(new Event('spectatore:notifications'));
  }

  async function markAll() {
    await api('/api/notifications/read-all', { method: 'POST' });
    setMsg('Marked all as read');
    await load();
    window.dispatchEvent(new Event('spectatore:notifications'));
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-lg font-semibold">Notifications</div>
              <div className="text-sm opacity-70">Crew requests and milestone updates.</div>
            </div>
            <button className="btn" onClick={markAll}>
              Mark all read
            </button>
          </div>

          {loading ? (
            <div className="text-sm opacity-70">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-sm opacity-70">No notifications yet</div>
          ) : (
            <ul className="space-y-2">
              {items.map((n) => (
                <li key={n.id} className="p-3 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold">{n.title}</div>
                        {!n.read_at ? (
                          <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: '#f2e8d9' }}>
                            New
                          </span>
                        ) : null}
                      </div>
                      <div className="text-sm opacity-80 mt-1">{n.body}</div>
                      <div className="text-xs opacity-60 mt-2">{fmt(n.created_at)}</div>
                    </div>
                    {!n.read_at ? (
                      <button className="btn" onClick={() => markRead(n.id)}>
                        Read
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
