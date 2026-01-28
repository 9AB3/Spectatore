import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { getDB } from '../lib/idb';

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export default function JoinOfficialSite() {
  const loc = useLocation();
  const q = useQuery();
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  const token = useMemo(() => {
    const fromQuery = String(q.get('token') || q.get('join_token') || q.get('t') || '').trim();
    if (fromQuery) return fromQuery;
    const hash = String(loc.hash || '').replace(/^#/, '');
    if (hash.includes('=')) {
      const hp = new URLSearchParams(hash);
      const ht = String(hp.get('token') || hp.get('join_token') || '').trim();
      if (ht) return ht;
    }
    const m = String(loc.pathname || '').match(/\/join\/(.+)$/i);
    return m ? String(m[1] || '').trim() : '';
  }, [q, loc.hash, loc.pathname]);

  useEffect(() => {
    (async () => {
      try {
        const db = await getDB();
        const session = await db.get('session', 'auth');
        setLoggedIn(!!session?.token);
      } catch {
        setLoggedIn(false);
      }
    })();
  }, []);


  // If we were redirected to login and lost URL params, restore the pending token.
  useEffect(() => {
    if (token) return;
    try {
      const pending = (sessionStorage.getItem('spectatore-pending-join-token') || '').trim();
      if (!pending) return;
      const next = sessionStorage.getItem('spectatore-pending-join-next') || '';
      // Restore URL so refreshes keep working.
      nav(`/join?token=${encodeURIComponent(pending)}`, { replace: true });
    } catch {
      // ignore
    }
  }, [token, nav]);

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
    if (loggedIn === false) {
      const next = `${loc.pathname}${loc.search}${loc.hash || ''}`;
      sessionStorage.setItem('spectatore-pending-join-next', next);
      sessionStorage.setItem('spectatore-pending-join-token', token);
      nav(`/Home?next=${encodeURIComponent(next)}`);

      return;
    }
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

            {loggedIn === false && (
              <div className="p-3 rounded-xl" style={{ background: 'rgba(0,0,0,0.04)' }}>
                <div className="text-sm">
                  You need to <b>log in</b> before we can attach this request to your account.
                </div>
              </div>
            )}

            <button className="btn w-full" onClick={submit} disabled={sending || loggedIn === null}>
              {sending ? 'Sending…' : loggedIn === false ? 'Log in to request access' : 'Request Access'}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
