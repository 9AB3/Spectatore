import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type Announcement = {
  id: number;
  title: string;
  body_md: string;
  version?: string | null;
  audience?: string;
  audience_site_id?: number | null;
  is_pinned?: boolean;
  is_urgent?: boolean;
  created_at?: string;
  seen?: boolean;
  seen_at?: string | null;
};

export default function WhatsNew() {
  const { setMsg, Toast } = useToast();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api('/api/user/announcements?limit=100');
      setItems((r?.announcements || []) as Announcement[]);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load announcements');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function markSeen(id: number) {
    try {
      await api(`/api/user/announcements/${id}/seen`, { method: 'POST' });
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, seen: true, seen_at: new Date().toISOString() } : x)));
    } catch {}
  }

  return (
    <div>
      <Header />
      <Toast />
      <div className="p-6" style={{ maxWidth: 900, margin: '0 auto' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800 }}>What&apos;s New</h2>
          <button className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'LOADING…' : 'REFRESH'}
          </button>
        </div>

        {items.length === 0 ? (
          <div className="card p-4" style={{ opacity: 0.9 }}>
            No updates yet.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {items.map((a) => (
              <div key={a.id} className="card p-4">
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>
                    {a.title}
                    {a.version ? <span style={{ opacity: 0.8, fontWeight: 600 }}> · {a.version}</span> : null}
                  </div>
                  {a.is_urgent ? <span className="badge" style={{ fontWeight: 800 }}>URGENT</span> : null}
                  {a.is_pinned ? <span className="badge" style={{ fontWeight: 800 }}>PINNED</span> : null}
                </div>

                {a.body_md ? (
                  <div style={{ marginTop: 10, whiteSpace: 'pre-wrap', lineHeight: 1.4, opacity: 0.95 }}>
                    {a.body_md}
                  </div>
                ) : null}

                <div style={{ marginTop: 12, display: 'flex', gap: 10, justifyContent: 'space-between', opacity: 0.8, fontSize: 12 }}>
                  <div>{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</div>
                  <div>
                    {a.seen ? 'Seen' : (
                      <button className="btn btn-secondary" onClick={() => markSeen(a.id)}>
                        MARK SEEN
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
