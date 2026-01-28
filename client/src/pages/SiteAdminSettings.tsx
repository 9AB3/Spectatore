import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type SiteRow = { id: number; name: string; state?: string | null };

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

export default function SiteAdminSiteTokens() {
  const { setMsg, Toast } = useToast();
  const [siteRows, setSiteRows] = useState<SiteRow[]>([]);
  const [siteId, setSiteId] = useState<number>(0);

  const [statusLoading, setStatusLoading] = useState(false);
  const [enabled, setEnabled] = useState<boolean>(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const [expiresDays, setExpiresDays] = useState<string>('7');
  const [rotating, setRotating] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const [lastCode, setLastCode] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const sorted = useMemo(() => [...siteRows].sort((a, b) => (a.name || '').localeCompare(b.name || '')), [siteRows]);

  async function loadMe() {
    try {
      const r: any = await api('/api/site-admin/me');
      if (!r?.ok) throw new Error('Not authorized');
      const rows: SiteRow[] = Array.isArray(r?.site_rows) ? r.site_rows : [];
      setSiteRows(rows);
      if (!siteId && rows.length) setSiteId(Number(rows[0].id || 0));
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load site scope');
    }
  }

  async function loadStatus(nextSiteId?: number) {
    const sid = Number(nextSiteId || siteId || 0);
    if (!sid) return;
    setStatusLoading(true);
    setLastCode(null);
    setQrUrl(null);
    try {
      const r: any = await api(`/api/site-admin/join-code/status?site_id=${sid}`);
      if (!r?.ok) throw new Error(r?.error || 'Failed to load status');
      setEnabled(!!r.enabled);
      setUpdatedAt(r.join_code_updated_at || null);
      setExpiresAt(r.join_code_expires_at || null);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load join code status');
      setEnabled(false);
      setUpdatedAt(null);
      setExpiresAt(null);
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => {
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (siteId) loadStatus(siteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  async function rotate() {
    const sid = Number(siteId || 0);
    if (!sid) return setMsg('Select a site');
    setRotating(true);
    setLastCode(null);
    setQrUrl(null);
    try {
      const days = expiresDays.trim() ? Number(expiresDays.trim()) : null;
      const r: any = await api('/api/site-admin/join-code/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: sid, expires_days: Number.isFinite(days as any) ? days : null }),
      });
      if (!r?.ok) throw new Error(r?.error || 'Failed to rotate');
      setLastCode(String(r.code || ''));
      setMsg('Join code generated (shown once)');
      await loadStatus(sid);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to rotate join code');
    } finally {
      setRotating(false);
    }
  }

  async function disable() {
    const sid = Number(siteId || 0);
    if (!sid) return setMsg('Select a site');
    const ok = window.confirm('Disable join code for this site? Anyone will be able to request access without a code.');
    if (!ok) return;

    setDisabling(true);
    setLastCode(null);
    setQrUrl(null);
    try {
      const r: any = await api('/api/site-admin/join-code', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: sid }),
      });
      if (!r?.ok) throw new Error(r?.error || 'Failed to disable');
      setMsg('Join code disabled');
      await loadStatus(sid);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to disable join code');
    } finally {
      setDisabling(false);
    }
  }

  async function loadQr() {
    const sid = Number(siteId || 0);
    if (!sid) return setMsg('Select a site');
    setQrLoading(true);
    try {
      const r: any = await api(`/api/site-admin/join-qr?site_id=${sid}`);
      if (!r?.ok) throw new Error(r?.error || 'Failed to create QR');
      setQrUrl(String(r.join_url || ''));
    } catch (e: any) {
      setMsg(e?.message || 'Failed to create QR');
    } finally {
      setQrLoading(false);
    }
  }

  const selectedSite = sorted.find((x) => Number(x.id) === Number(siteId));

  const qrImg = qrUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrUrl)}`
    : null;

  return (
    <div className="min-h-screen flex items-start justify-center p-4">
      <Toast />
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <img src="/logo.png" alt="Spectatore" className="w-12 h-12 object-contain" />
          <div>
            <div className="text-xl font-semibold">Site Tokens</div>
            <div className="text-sm opacity-70">Manage join codes + QR tokens used for users to request access.</div>
          </div>
        </div>

        <div className="p-4 rounded-2xl border mb-4" style={{ borderColor: '#e9d9c3' }}>
          <div className="text-xs opacity-70 mb-1">Site</div>
          <select
            className="input w-full"
            value={siteId ? String(siteId) : ''}
            onChange={(e) => setSiteId(Number(e.target.value || 0))}
          >
            {sorted.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Join Control</div>
              <div className="text-xs opacity-70">
                Require a site join code or signed QR before a user can request membership.
              </div>
            </div>
            <button className="btn" onClick={() => loadStatus()} disabled={statusLoading}>
              {statusLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <div className="mt-3 text-sm">
            <div className="flex items-center justify-between py-1">
              <div className="opacity-70">Status</div>
              <div className={cx('font-semibold', enabled ? '' : 'opacity-60')}>{enabled ? 'Enabled' : 'Disabled'}</div>
            </div>
            <div className="flex items-center justify-between py-1">
              <div className="opacity-70">Last rotated</div>
              <div className="opacity-80">{updatedAt ? new Date(updatedAt).toLocaleString() : '-'}</div>
            </div>
            <div className="flex items-center justify-between py-1">
              <div className="opacity-70">Expires</div>
              <div className="opacity-80">{expiresAt ? new Date(expiresAt).toLocaleString() : 'No expiry'}</div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3 mt-4">
            <div>
              <div className="text-xs opacity-70 mb-1">Expiry (days)</div>
              <input
                className="input w-full"
                value={expiresDays}
                onChange={(e) => setExpiresDays(e.target.value)}
                placeholder="7"
                inputMode="numeric"
              />
              <div className="text-[11px] opacity-60 mt-1">Set blank for “no expiry”.</div>
            </div>

            <div className="flex gap-2 items-end">
              <button className="btn flex-1" onClick={rotate} disabled={rotating}>
                {rotating ? 'Generating…' : 'Generate / Rotate'}
              </button>
              <button className="btn" onClick={disable} disabled={disabling}>
                {disabling ? 'Disabling…' : 'Disable'}
              </button>
            </div>
          </div>

          {lastCode && (
            <div className="mt-4 p-3 rounded-xl" style={{ background: 'rgba(0,0,0,0.04)' }}>
              <div className="text-xs opacity-70 mb-1">New join code (shown once)</div>
              <div className="flex items-center justify-between gap-2">
                <div className="font-mono text-base">{lastCode}</div>
                <button
                  className="btn"
                  onClick={() => {
                    navigator.clipboard?.writeText(lastCode);
                    setMsg('Copied');
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          )}

          <div className="mt-4">
            <button className="btn w-full" onClick={loadQr} disabled={qrLoading}>
              {qrLoading ? 'Creating QR…' : 'Create QR Join Link'}
            </button>
            {qrUrl && (
              <div className="mt-3 p-3 rounded-xl" style={{ background: 'rgba(0,0,0,0.04)' }}>
                <div className="text-xs opacity-70 mb-2">
                  QR link for <b>{selectedSite?.name || 'site'}</b>
                </div>
                <div className="break-all text-[12px] opacity-80">{qrUrl}</div>
                {qrImg && (
                  <div className="mt-3 flex items-center justify-center">
                    <img src={qrImg} alt="Join QR" className="rounded-xl border" style={{ borderColor: '#e9d9c3' }} />
                  </div>
                )}
                <div className="mt-2 text-[11px] opacity-60">
                  Tip: rotate the join code if the QR/code is shared outside the site.
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
