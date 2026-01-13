import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type SiteRow = { id: number; name: string; state?: string | null };
type TokenRow = {
  id: number;
  site: string;
  label?: string | null;
  token: string;
  created_at?: string;
  revoked_at?: string | null;
};

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-3xl">{children}</div>;
}

function fmtTs(v?: string | null) {
  if (!v) return '';
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return String(v);
  return d.toLocaleString();
}

export default function SiteAdminPowerBiTokens() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [sp, setSp] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [isSuper, setIsSuper] = useState(false);
  const [siteRows, setSiteRows] = useState<SiteRow[]>([]);

  const [site, setSite] = useState<string>(sp.get('site') || '');
  const [tokens, setTokens] = useState<TokenRow[]>([]);

  const [newLabel, setNewLabel] = useState('Power BI');
  const [creating, setCreating] = useState(false);

  const apiBase = useMemo(() => {
    // api() already resolves BASE properly, but we want to show a copy/paste URL.
    const fromEnv = (import.meta as any)?.env?.VITE_API_BASE;
    if (fromEnv) return String(fromEnv);
    if (typeof window !== 'undefined') return window.location.origin;
    return '';
  }, []);

  async function loadScope() {
    const me: any = await api('/api/site-admin/me');
    const ok = !!me?.ok;
    if (!ok) throw new Error(me?.error || 'Not authorized');
    const sites = Array.isArray(me?.sites) ? me.sites : [];
    const superAdmin = !!me?.is_super || sites.includes('*');
    // Power BI token management is super-admin only (users.is_admin=true).
    const manage = superAdmin;
    setIsSuper(superAdmin);
    setCanManage(manage);
    setSiteRows(Array.isArray(me?.site_rows) ? me.site_rows : []);

    // Default site:
    // - if query param provided, keep it
    // - else if only one site is available, lock to it
    if (!site) {
      const only = !superAdmin && sites.length === 1 && sites[0] !== '*' ? sites[0] : '';
      const fallback = only || (me?.site_rows?.[0]?.name || '');
      if (fallback) {
        setSite(fallback);
        sp.set('site', fallback);
        setSp(sp, { replace: true });
      }
    }
  }

  async function loadTokens(selSite: string) {
    if (!selSite) return;
    const res: any = await api(`/api/site-admin/powerbi-tokens?site=${encodeURIComponent(selSite)}`);
    if (!res?.ok) throw new Error(res?.error || 'Failed to load tokens');
    setTokens(Array.isArray(res?.tokens) ? res.tokens : []);
  }

  useEffect(() => {
    (async () => {
      try {
        await loadScope();
      } catch (e: any) {
        setMsg(e?.message || 'Not authorized');
        nav('/SiteAdmin');
        return;
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!site) return;
    (async () => {
      try {
        await loadTokens(site);
      } catch (e: any) {
        setMsg(e?.message || 'Failed to load tokens');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  async function createToken() {
    if (!canManage) return setMsg('You do not have permission to manage tokens');
    if (!site) return setMsg('Select a site');
    setCreating(true);
    try {
      const res: any = await api('/api/site-admin/powerbi-tokens', {
        method: 'POST',
        body: { site, label: newLabel.trim() || 'Power BI' },
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to create token');
      const row: TokenRow = res?.token;
      setMsg('Token created');
      // Refresh list
      await loadTokens(site);
      // Best-effort copy to clipboard
      try {
        await navigator.clipboard.writeText(String(row?.token || ''));
      } catch {
        // ignore
      }
    } catch (e: any) {
      setMsg(e?.message || 'Failed to create token');
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(id: number) {
    const ok = window.confirm('Revoke this token? Existing Power BI refreshes using it will fail.');
    if (!ok) return;
    try {
      const res: any = await api(`/api/site-admin/powerbi-tokens/${id}/revoke`, { method: 'POST' });
      if (!res?.ok) throw new Error(res?.error || 'Failed to revoke token');
      setMsg('Token revoked');
      await loadTokens(site);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to revoke token');
    }
  }

  function copy(text: string) {
    (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setMsg('Copied');
      } catch {
        setMsg('Copy failed');
      }
    })();
  }

  const sortedSites = useMemo(() => {
    const s = [...siteRows];
    s.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return s;
  }, [siteRows]);

  const tokenHelpUrl = useMemo(() => {
    if (!apiBase || !site || !tokens?.[0]?.token) return '';
    const t = tokens[0].token;
    return `${apiBase}/api/powerbi/validated/fact-production-drilling?site=${encodeURIComponent(site)}&token=${encodeURIComponent(t)}`;
  }, [apiBase, site, tokens]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-start justify-center p-4">
        <Card>
          <div className="p-6">Loading…</div>
        </Card>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="min-h-screen flex items-start justify-center p-4">
        <Toast />
        <Card>
          <div className="p-6">
            <div className="text-xl font-semibold mb-2">Power BI Tokens</div>
            <div className="opacity-80">You don’t have permission to manage Power BI tokens.</div>
            <div className="mt-4">
              <button className="btn" onClick={() => nav('/SiteAdmin')}>
                Back
              </button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-start justify-center p-4">
      <Toast />
      <Card>
        <div className="p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <div className="text-xl font-semibold">Power BI Tokens</div>
              <div className="text-sm opacity-70">Create per-site tokens for Power BI “From Web” endpoints.</div>
            </div>
            <button className="btn" onClick={() => nav('/SiteAdmin')}>
              Back
            </button>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Site</div>
              <div className="text-sm opacity-70 mb-3">Select which site you want to manage tokens for.</div>
              <select
                className="input w-full"
                value={site}
                onChange={(e) => {
                  const v = e.target.value;
                  setSite(v);
                  const next = new URLSearchParams(sp);
                  if (v) next.set('site', v);
                  else next.delete('site');
                  setSp(next, { replace: true });
                }}
                disabled={!isSuper && sortedSites.length <= 1}
              >
                <option value="">Select site…</option>
                {sortedSites.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}{s.state ? ` (${s.state})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Create token</div>
              <div className="text-sm opacity-70 mb-3">Give it a label (e.g. “Power BI Prod”). New tokens are active immediately.</div>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Label"
                />
                <button className="btn" onClick={createToken} disabled={creating || !site}>
                  {creating ? 'Creating…' : 'Generate'}
                </button>
              </div>
              <div className="text-xs opacity-60 mt-2">
                Tip: creating a new token does not invalidate existing ones. Revoke old tokens when you’re ready.
              </div>
            </div>
          </div>

          <div className="mt-6">
            <div className="font-semibold mb-2">Tokens for {site || '…'}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-70">
                    <th className="py-2 pr-3">Label</th>
                    <th className="py-2 pr-3">Token</th>
                    <th className="py-2 pr-3">Created</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.length === 0 ? (
                    <tr>
                      <td className="py-3 opacity-70" colSpan={5}>
                        No tokens yet.
                      </td>
                    </tr>
                  ) : (
                    tokens.map((t) => {
                      const revoked = !!t.revoked_at;
                      return (
                        <tr key={t.id} className="border-t" style={{ borderColor: '#eee' }}>
                          <td className="py-2 pr-3">{t.label || ''}</td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            <span className="break-all">{t.token}</span>
                          </td>
                          <td className="py-2 pr-3">{fmtTs(t.created_at)}</td>
                          <td className="py-2 pr-3">
                            {revoked ? (
                              <span className="opacity-70">Revoked</span>
                            ) : (
                              <span className="text-emerald-700">Active</span>
                            )}
                          </td>
                          <td className="py-2">
                            <div className="flex gap-2">
                              <button className="btn" onClick={() => copy(t.token)}>
                                Copy
                              </button>
                              {!revoked && (
                                <button className="btn" onClick={() => revokeToken(t.id)}>
                                  Revoke
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-6 p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="font-semibold mb-2">How to use in Power BI</div>
            <ol className="list-decimal pl-5 text-sm opacity-80 space-y-1">
              <li>Power BI Desktop → Get Data → Web</li>
              <li>Choose <span className="font-semibold">Anonymous</span></li>
              <li>Use a URL like:</li>
            </ol>
            <div className="mt-2 p-3 rounded-xl bg-black/5 text-xs font-mono break-all">
              {tokenHelpUrl || 'Create a token to see an example URL here.'}
            </div>
            {tokenHelpUrl && (
              <div className="mt-2">
                <button className="btn" onClick={() => copy(tokenHelpUrl)}>
                  Copy example URL
                </button>
              </div>
            )}
            <div className="text-xs opacity-60 mt-3">
              Tokens are site-scoped. Even if someone changes the <span className="font-semibold">site=</span> parameter, the API will only return data for the site bound to the token.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
