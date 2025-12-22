import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';
import { api } from '../lib/api';

type ApprovedFeedbackRow = {
  id: number;
  message: string;
  user_name: string | null;
  site: string | null;
  created_at: string;
  upvotes: number;
  has_upvoted: boolean;
};

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

function Tabs({
  value,
  onChange,
}: {
  value: 'share' | 'review';
  onChange: (v: 'share' | 'review') => void;
}) {
  const b = (v: 'share' | 'review') =>
    value === v
      ? 'px-3 py-2 rounded-xl font-semibold bg-[rgba(0,0,0,0.06)]'
      : 'px-3 py-2 rounded-xl opacity-70';
  return (
    <div className="flex gap-2">
      <button className={b('share')} onClick={() => onChange('share')}>
        Share feedback
      </button>
      <button className={b('review')} onClick={() => onChange('review')}>
        Review feedback
      </button>
    </div>
  );
}

export default function Feedback() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [tab, setTab] = useState<'share' | 'review'>('share');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const [rows, setRows] = useState<ApprovedFeedbackRow[]>([]);
  const [loading, setLoading] = useState(false);

  const canSend = useMemo(() => message.trim().length >= 5, [message]);

  async function submit() {
    const msg = message.trim();
    if (!msg) return setMsg('Please enter feedback');
    if (msg.length < 5) return setMsg('Please add a bit more detail');

    setSending(true);
    try {
      const res: any = await api('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({ message: msg }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to send feedback');
      setMsg('Thanks — feedback sent');
      setMessage('');
      // Optional: switch to review tab after send
      setTab('review');
      await loadApproved();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to send feedback');
    } finally {
      setSending(false);
    }
  }

  async function loadApproved() {
    setLoading(true);
    try {
      const res: any = await api('/api/feedback/approved');
      if (!res?.ok) throw new Error(res?.error || 'Failed to load feedback');
      setRows(res.rows || []);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load feedback');
    } finally {
      setLoading(false);
    }
  }

  async function upvote(id: number) {
    try {
      const res: any = await api('/api/feedback/upvote', {
        method: 'POST',
        body: JSON.stringify({ feedback_id: id }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to upvote');
      // Refresh list so ordering updates
      await loadApproved();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to upvote');
    }
  }

  useEffect(() => {
    if (tab === 'review') loadApproved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div>
      <Toast />
      <Header />
      <div className="min-h-screen flex items-start justify-center p-4">
        <Card>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <div className="text-xl font-semibold">Share your feedback</div>
              <div className="text-sm opacity-70">Suggest upgrades, features, or improvements.</div>
            </div>
            <button className="btn" onClick={() => nav('/Main')}>
              Back
            </button>
          </div>

          <div className="mb-4">
            <Tabs value={tab} onChange={setTab} />
          </div>

          {tab === 'share' ? (
            <div className="grid gap-3">
              <label className="text-sm font-semibold">Your message</label>
              <textarea
                className="input min-h-[140px]"
                placeholder="Type your suggestion / upgrade / feedback here…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="flex gap-2">
                <button className="btn flex-1" onClick={submit} disabled={!canSend || sending}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
                <button className="btn" onClick={() => nav('/Main')}>
                  Back
                </button>
              </div>
              <div className="text-xs opacity-70">
                Your feedback will be reviewed before it appears in the public list.
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              {loading ? (
                <div className="opacity-70">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="opacity-70">No approved feedback yet.</div>
              ) : (
                <div className="grid gap-3">
                  {rows.map((r) => (
                    <div key={r.id} className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                      <div className="text-sm whitespace-pre-wrap">{r.message}</div>
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <div className="text-xs opacity-70">
                          {(r.user_name || 'User') + (r.site ? ` • ${r.site}` : '')}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-xs opacity-70">{r.upvotes} upvotes</div>
                          <button className="btn" disabled={r.has_upvoted} onClick={() => upvote(r.id)}>
                            {r.has_upvoted ? 'Upvoted' : 'Upvote'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
