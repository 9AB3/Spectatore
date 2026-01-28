import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export default function JoinOfficialSite() {
  const q = useQuery();
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const token = String(q.get('token') || '').trim();

  const [siteName, setSiteName] = useState<string>('');
  const [siteId, setSiteId] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [tick, setTick] = useState(false);

  useEffect(() => {
    (async () => {
      if (!token) return;
      setLoading(true);
      try {
        // We can’t fully decode on client (signed), so ask server for the site list and match after request.
        // For security, the server validates token again during the request.
        const sites: any = await api('/api/user/sites');
        const list = Array.isArray(sites?.sites) ? sites.sites : [];
        // siteId isn’t embedded in the URL visibly, so we can’t prefill name reliably here.
        // We still show a generic prompt; membership request endpoint enforces token validity.
        setSiteName('Selected site');
        setSiteId(0);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function submit() {
    if (!token) return setMsg('Missing join token');
    if (!tick) return setMsg('Please accept the site consent to continue');
    setSending(true);
    try {
      const r: any = await api('/api/user/site-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ join_token: token, site_consent_version: 'v1' }),
      });
      if (r?.ok) {
        setMsg('Request sent');
        setTimeout(() => nav('/Settings'), 600);
        return;
      }
      throw new Error(r?.error || 'Failed');
    } catch (e: any) {
      if (String(e?.message || '').includes('join_code_required')) {
        setMsg('Join link expired or invalid. Ask your site admin for a new QR.');
      } else {
        setMsg(e?.message || 'Failed to request access');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-start justify-center p-4">
      <Toast />
      <Card>
        <div className="flex items-center gap-3 mb-3">
          <img src="/logo.png" alt="Spectatore" className="w-12 h-12 object-contain" />
          <div>
            <div className="text-xl font-semibold">Join Official Site</div>
            <div className="text-sm opacity-70">Request membership using a site QR link.</div>
          </div>
        </div>

        {!token ? (
          <div className="text-sm opacity-70">No join token provided.</div>
        ) : (
          <div className="space-y-4">
            <div className="p-3 rounded-xl" style={{ background: 'rgba(0,0,0,0.04)' }}>
              <div className="text-sm">
                This join link proves you scanned a valid site QR. When you submit, we’ll send a <b>pending</b> request to
                the site admins.
              </div>
            </div>

            <div className="p-3 rounded-xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Site consent</div>
              <div className="text-sm opacity-80">
                You are requesting access as a <b>member</b>. Site admins can promote you after approval.
              </div>
              <label className="flex items-center gap-2 mt-3 text-sm">
                <input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} />
                I accept the site consent terms.
              </label>
            </div>

            <button className="btn w-full" onClick={submit} disabled={sending}>
              {sending ? 'Sending…' : 'Request Access'}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
