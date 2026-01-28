import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type Ann = {
  id: number;
  title: string;
  body_md: string;
  version?: string | null;
  audience: string;
  audience_site_id?: number | null;
  is_pinned: boolean;
  is_urgent: boolean;
  created_at?: string;
  created_by_email?: string | null;
};

const AUDIENCES = [
  { key: 'all', label: 'All users' },
  { key: 'admins', label: 'Super admins only' },
  { key: 'site_admins', label: 'Site admins' },
  { key: 'validators', label: 'Validators' },
  { key: 'members', label: 'All site members' },
];

export default function AdminAnnouncements() {
  const { setMsg, Toast } = useToast();
  const [items, setItems] = useState<Ann[]>([]);
  const [loading, setLoading] = useState(false);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [version, setVersion] = useState('');
  const [audience, setAudience] = useState('all');
  const [audienceSiteId, setAudienceSiteId] = useState('');
  const [pinned, setPinned] = useState(false);
  const [urgent, setUrgent] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api('/api/admin/announcements');
      setItems((r?.announcements || []) as Ann[]);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load announcements');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (!title.trim()) return setMsg('Title required');

    try {
      await api('/api/admin/announcements', {
        method: 'POST',
        body: JSON.stringify({
          title,
          body_md: body,
          version: version || null,
          audience,
          audience_site_id: audienceSiteId.trim() ? Number(audienceSiteId) : null,
          is_pinned: pinned,
          is_urgent: urgent,
        }),
      });
      setMsg('Posted');
      setTitle('');
      setBody('');
      setVersion('');
      setAudience('all');
      setAudienceSiteId('');
      setPinned(false);
      setUrgent(false);
      load();
    } catch (e: any) {
      setMsg(e?.message || 'Create failed');
    }
  }

  async function del(id: number) {
    if (!confirm('Delete this announcement?')) return;
    try {
      await api(`/api/admin/announcements/${id}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (e: any) {
      setMsg(e?.message || 'Delete failed');
    }
  }

  return (
    <div>
      <Header />
      <Toast />
      <div className="p-6" style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800 }}>Announcements (Admin)</h2>
          <button className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'LOADING…' : 'REFRESH'}
          </button>
        </div>

        <div className="card p-4" style={{ marginTop: 12 }}>
          <div style={{ display: 'grid', gap: 10 }}>
            <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="input" style={{ minHeight: 120 }} placeholder="Body (plain text / markdown-ish)" value={body} onChange={(e) => setBody(e.target.value)} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <input className="input" placeholder="Version (optional) e.g. FIX34" value={version} onChange={(e) => setVersion(e.target.value)} />
              <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>
                {AUDIENCES.map((a) => (
                  <option key={a.key} value={a.key}>{a.label}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <input className="input" placeholder="Audience Site ID (optional)" value={audienceSiteId} onChange={(e) => setAudienceSiteId(e.target.value)} />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
                  Pinned
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
                  Urgent
                </label>
                <div style={{ flex: 1 }} />
                <button className="btn btn-primary" onClick={create}>POST</button>
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
          {items.map((a) => (
            <div key={a.id} className="card p-4">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div style={{ fontWeight: 800, flex: 1 }}>
                  {a.title}{a.version ? <span style={{ opacity: 0.8 }}> · {a.version}</span> : null}
                </div>
                {a.is_urgent ? <span className="badge" style={{ fontWeight: 800 }}>URGENT</span> : null}
                {a.is_pinned ? <span className="badge" style={{ fontWeight: 800 }}>PINNED</span> : null}
                <button className="btn btn-secondary" onClick={() => del(a.id)}>DELETE</button>
              </div>
              <div style={{ marginTop: 8, opacity: 0.85, fontSize: 12 }}>
                Audience: <b>{a.audience}</b>{a.audience_site_id ? ` · site_id=${a.audience_site_id}` : ''} · By: {a.created_by_email || 'unknown'} · {a.created_at ? new Date(a.created_at).toLocaleString() : ''}
              </div>
              {a.body_md ? <div style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{a.body_md}</div> : null}
            </div>
          ))}
          {items.length === 0 ? <div className="card p-4" style={{ opacity: 0.9 }}>No announcements yet.</div> : null}
        </div>
      </div>
    </div>
  );
}
