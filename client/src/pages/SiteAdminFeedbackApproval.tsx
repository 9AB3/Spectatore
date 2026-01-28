import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type PendingFeedbackRow = {
  id: number;
  message: string;
  user_name: string | null;
  user_email: string | null;
  site: string | null;
  created_at: string;
};

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

export default function SiteAdminFeedbackApproval() {
  const { setMsg, Toast } = useToast();
  const [isSuper, setIsSuper] = useState(false);
  const [rows, setRows] = useState<PendingFeedbackRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadScope() {
    try {
      const me: any = await api('/api/site-admin/me');
      const sites: string[] = Array.isArray(me?.sites) ? me.sites : [];
      setIsSuper(!!me?.is_super || sites.includes('*'));
    } catch {
      setIsSuper(false);
    }
  }

  async function loadPending() {
    setLoading(true);
    try {
      const res: any = await api('/api/site-admin/feedback/pending');
      if (!res?.ok) throw new Error(res?.error || 'Failed to load feedback');
      setRows(res.rows || []);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load feedback');
    } finally {
      setLoading(false);
    }
  }

  async function decide(id: number, decision: 'approve' | 'decline') {
    try {
      const res: any = await api('/api/site-admin/feedback/decision', {
        method: 'POST',
        body: JSON.stringify({ id, decision }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to update feedback');
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (e: any) {
      setMsg(e?.message || 'Failed to update feedback');
    }
  }

  async function del(id: number) {
    await api(`/api/site-admin/feedback/${id}`, { method: 'DELETE' });
    setMsg('Feedback deleted');
    await loadPending();
  }


  useEffect(() => {
    loadScope();
    loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isSuper) {
    return (
      <div>
        <Toast />
        <div className="min-h-screen flex items-start justify-center p-4">
          <Card>
            <div className="text-xl font-semibold mb-2">Approve feedback</div>
            <div className="opacity-70">Only the super admin can access this page.</div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Toast />
      <div className="min-h-screen flex items-start justify-center p-4">
        <Card>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <div className="text-xl font-semibold">Approve feedback</div>
              <div className="text-sm opacity-70">Approve or decline user suggestions.</div>
            </div>
            <button className="btn" onClick={loadPending}>
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="opacity-70">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="opacity-70">No feedback awaiting approval.</div>
          ) : (
            <div className="grid gap-3">
              {rows.map((r) => (
                <div key={r.id} className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                  <div className="text-sm whitespace-pre-wrap">{r.message}</div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="text-xs opacity-70">
                      {(r.user_name || 'User') + (r.user_email ? ` • ${r.user_email}` : '') + (r.site ? ` • ${r.site}` : '')}
                    </div>
                    <div className="flex gap-2">
                      <button className="btn" onClick={() => decide(r.id, 'approve')}>
                        ✓
                      </button>
                      <button className="btn" onClick={() => decide(r.id, 'decline')}>
                        ✕
                      </button>
                      <button className="btn" onClick={() => del(r.id)} title="Delete">
                        🗑
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
