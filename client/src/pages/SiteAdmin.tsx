import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function TileRow({ title, subtitle, children }: { title: string; subtitle?: string; children: any }) {
  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-lg font-extrabold tracking-tight">{title}</div>
          {subtitle ? (
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
      <div className="tv-row">{children}</div>
    </div>
  );
}

function TvTileButton({
  title,
  subtitle,
  tone,
  right,
  onClick,
  children,
}: {
  title: string;
  subtitle?: string;
  tone: 'brand' | 'neutral' | 'danger' | 'gold';
  right?: React.ReactNode;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const toneBorder =
    tone === 'brand'
      ? 'border-white/10'
      : tone === 'danger'
        ? 'border-red-500/30'
        : tone === 'gold'
          ? 'border-amber-400/25'
          : 'border-white/10';

  const bg =
    tone === 'brand'
      ? 'linear-gradient(180deg, rgba(10,132,255,0.18), rgba(0,0,0,0.10))'
      : tone === 'danger'
        ? 'linear-gradient(180deg, rgba(255,69,58,0.12), rgba(0,0,0,0.10))'
        : tone === 'gold'
          ? 'linear-gradient(180deg, rgba(245,158,11,0.12), rgba(0,0,0,0.10))'
          : 'linear-gradient(180deg, rgba(0,0,0,0.04), rgba(0,0,0,0.10))';

  const Tag = onClick ? 'button' : 'div';
  const props: any = onClick
    ? { type: 'button', onClick }
    : {};

  return (
    <Tag
      {...props}
      className={cx(
        'tv-tile text-left min-w-[260px] w-[260px] md:w-[320px]',
        'transition-all active:translate-y-[1px]',
        toneBorder,
      )}
      style={{ background: bg }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
            {subtitle || ' '}
          </div>
          <div className="text-xl font-extrabold leading-tight mt-1">{title}</div>
        </div>
        {right ? (
          <div className="shrink-0 rounded-2xl px-3 py-2 border" style={{ borderColor: 'var(--hairline)', background: 'rgba(255,255,255,0.06)' }}>
            {right}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </Tag>
  );
}

function ymNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function SiteAdmin() {
  const nav = useNavigate();
  const [superAdmin, setSuperAdmin] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [isSiteAdminUser, setIsSiteAdminUser] = useState(false);

  const [sites, setSites] = useState<string[]>([]);
  const [activeSite, setActiveSite] = useState<string>('');
  const [monthYm, setMonthYm] = useState<string>(ymNow());

  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [reconStatus, setReconStatus] = useState<{ state: 'open' | 'in_progress' | 'closed'; metrics: number } | null>(null);

  function applyScope(payload: any) {
    const p = payload?.data ?? payload;
    const isSuper = !!(p?.is_super ?? p?.isSuper ?? p?.super_admin ?? p?.superAdmin);
    const canManageVal =
      !!(p?.can_manage ?? p?.canManage ?? p?.can_manage_members ?? p?.canManageMembers) || isSuper;
    setSuperAdmin(isSuper);
    setCanManage(canManageVal);
    setIsSiteAdminUser(true);

    const siteRows = Array.isArray(p?.site_rows) ? p.site_rows : [];
    const names = siteRows.map((r: any) => String(r?.name || '').trim()).filter(Boolean);
    const tokens = Array.isArray(p?.sites) ? p.sites : [];

    const list = names.length ? names : tokens.filter((x: any) => x && x !== '*');
    setSites(list);

    if (!activeSite) {
      const pick = list.length === 1 ? list[0] : list[0] || '';
      setActiveSite(pick);
    }
  }

  async function logout() {
    const db = await getDB();
    await db.delete('session', 'auth');
    nav('/Home');
  }

  async function loadSummary(site: string, ym: string) {
    if (!site || site === '*') {
      setSummary(null);
      return;
    }
    setLoading(true);
    try {
      const r: any = await api(`/api/site-admin/dashboard-summary?site=${encodeURIComponent(site)}&month_ym=${encodeURIComponent(ym)}`);
      setSummary(r);
      try {
        const rs: any = await api(`/api/site-admin/reconciliation/status?site=${encodeURIComponent(site)}&month_ym=${encodeURIComponent(ym)}`);
        const state = (rs?.state || 'open') as any;
        const metrics = Number(rs?.metrics || 0);
        setReconStatus({ state, metrics });
      } catch {
        setReconStatus(null);
      }
    } catch {
      setSummary(null);
      setReconStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const me: any = await api('/api/site-admin/me');
        applyScope(me);
      } catch {
        setSuperAdmin(false);
        setCanManage(false);
        setIsSiteAdminUser(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeSite) loadSummary(activeSite, monthYm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSite, monthYm]);

  const monthLabel = useMemo(() => {
    if (!/^\d{4}-\d{2}$/.test(monthYm)) return monthYm;
    const [y, m] = monthYm.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }, [monthYm]);

  const pendingDays = summary?.pending_days ?? 0;
  const shiftsTotal = summary?.shifts?.total ?? 0;
  const shiftsValidated = summary?.shifts?.validated ?? 0;
  const shiftsUnvalidated = summary?.shifts?.unvalidated ?? 0;
  const daysWithData = summary?.days?.with_data ?? 0;
  const daysValidated = summary?.days?.validated ?? 0;
  const activeUsers = summary?.crew?.active_users ?? 0;
  const lastShiftDate = summary?.crew?.last_shift_date ?? null;

  const validateFrac = useMemo(() => {
    const a = Number(daysValidated) || 0;
    const b = Number(daysWithData) || 0;
    return `${a}/${b}`;
  }, [daysValidated, daysWithData]);

  const reconLabel = useMemo(() => {
    if (!reconStatus) return 'Open';
    if (reconStatus.state === 'closed') return 'Closed';
    if (reconStatus.state === 'in_progress') return 'In progress';
    return 'Open';
  }, [reconStatus]);

  const reconTone = useMemo(() => {
    if (!reconStatus) return 'gold' as const;
    if (reconStatus.state === 'closed') return 'brand' as const;
    if (reconStatus.state === 'in_progress') return 'gold' as const;
    return 'gold' as const;
  }, [reconStatus]);

  return (
    <div className="min-h-screen">
      <div className="p-4 max-w-6xl mx-auto space-y-6 pb-24">
        {/* Header */}
        <div className="tv-tile">
          <div className="flex items-start gap-3">
            <img src="/logo.png" alt="Spectatore" className="w-14 h-14 object-contain" />
            <div className="flex-1">
              <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
                Site Admin
              </div>
              <div className="mt-1 text-3xl font-extrabold tracking-tight">Dashboard</div>
              <div className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
                Manage validation, reconciliation, people, and site assets.
              </div>
              {activeSite ? (
                <div className="mt-4 inline-flex items-center gap-2 rounded-2xl px-3 py-2 border" style={{ borderColor: 'var(--hairline)', background: 'rgba(255,255,255,0.06)' }}>
                  <div className="h-2 w-2 rounded-full" style={{ background: 'var(--brand)' }} />
                  <div className="text-sm font-semibold">{activeSite} • {monthLabel}</div>
                </div>
              ) : null}
            </div>
            <button className="btn" onClick={logout}>
              Logout
            </button>
          </div>
        </div>

        {/* Scope row (Apple TV style) */}
        <TileRow title="Scope" subtitle="Site + month selection">
          <TvTileButton title="Active site" subtitle="Scope" tone="neutral">
            <select className="input w-full" value={activeSite} onChange={(e) => setActiveSite(e.target.value)}>
              {sites.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              Dashboard is site-scoped
            </div>
          </TvTileButton>

          <TvTileButton title="Month" subtitle="Scope" tone="neutral">
            <input className="input w-full" type="month" value={monthYm} onChange={(e) => setMonthYm(e.target.value)} />
            <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              {monthLabel}
            </div>
          </TvTileButton>

          <TvTileButton
            title={loading ? 'Loading…' : activeSite ? 'Ready' : 'Pick a site'}
            subtitle="Status"
            tone="neutral"
            right={lastShiftDate ? <div className="text-xs font-semibold">Last: {lastShiftDate}</div> : <div className="text-xs font-semibold"> </div>}
          >
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              {activeSite ? 'You are scoped and ready to manage this site.' : 'Select an active site to continue.'}
            </div>
          </TvTileButton>
        </TileRow>

        {/* Operations */}
        <TileRow title="Operations" subtitle="Workflows">
          <TvTileButton
            title="Validate"
            subtitle="Review & approve"
            tone={pendingDays > 0 ? 'gold' : 'brand'}
            right={
              <div className="text-right">
                <div className="text-lg font-extrabold leading-none">{validateFrac}</div>
                <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                  days
                </div>
              </div>
            }
            onClick={() => nav('/SiteAdmin/Validate')}
          >
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              {pendingDays > 0 ? (
                <>
                  <b className="text-[color:var(--text)]">{pendingDays}</b> day(s) need review.{' '}
                </>
              ) : (
                <>All days validated so far. </>
              )}
              <span className="tv-muted">Shifts: {shiftsTotal.toLocaleString()}</span>
            </div>
          </TvTileButton>

          {isSiteAdminUser ? (
            <TvTileButton
              title="Reconcile"
              subtitle="Month-end"
              tone={reconTone}
              right={<div className="text-lg font-extrabold">{reconLabel}</div>}
              onClick={() => nav('/SiteAdmin/Reconciliation')}
            >
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                {reconStatus?.state === 'closed'
                  ? 'Locked for reporting.'
                  : reconStatus?.state === 'in_progress'
                    ? 'Started but not locked.'
                    : 'Not started yet.'}
                {reconStatus && typeof reconStatus.metrics === 'number' ? (
                  <span className="tv-muted">{' '}• Metrics: {reconStatus.metrics}</span>
                ) : null}
              </div>
            </TvTileButton>
          ) : null}

          {(canManage || superAdmin) ? (
            <TvTileButton
              title="People"
              subtitle="Membership"
              tone="neutral"
              right={<div className="text-2xl font-extrabold">{String(activeUsers)}</div>}
              onClick={() => nav('/SiteAdmin/People')}
            >
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Operators with shifts this month.
              </div>
            </TvTileButton>
          ) : null}
        </TileRow>

        {/* Configuration */}
        <TileRow title="Configuration" subtitle="Site setup & tools">
          {isSiteAdminUser ? (
            <TvTileButton title="Site Assets" subtitle="Equipment & locations" tone="neutral" onClick={() => nav('/SiteAdmin/Equipment&Locations')}>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Manage equipment and location lists used across dropdowns and reporting.
              </div>
            </TvTileButton>
          ) : null}

          {(canManage || superAdmin) ? (
            <TvTileButton title="Expected Work" subtitle="Validation rules" tone="neutral" onClick={() => nav('/SiteAdmin/ExpectedWork')}>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Configure which activities & sub-activities are expected each day (used on Validate).
              </div>
            </TvTileButton>
          ) : null}

          {(canManage || superAdmin) ? (
            <TvTileButton title="Site Tokens" subtitle="Access" tone="neutral" onClick={() => nav('/SiteAdmin/SiteTokens')}>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Manage join code + QR tokens used for users to request access to this site.
              </div>
            </TvTileButton>
          ) : null}

          {superAdmin ? (
            <TvTileButton title="Power BI Tokens" subtitle="Integrations" tone="neutral" onClick={() => nav('/SiteAdmin/PowerBiTokens')}>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Create per-site tokens for Power BI “From Web” endpoints.
              </div>
            </TvTileButton>
          ) : null}

          {superAdmin ? (
            <TvTileButton title="Engagement" subtitle="Presence analytics" tone="neutral" onClick={() => nav('/SiteAdmin/Engagement')}>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Online now + DAU/WAU from heartbeat sessions.
              </div>
            </TvTileButton>
          ) : null}

          {superAdmin ? (
            <TvTileButton title="Sites" subtitle="Admin list" tone="neutral" onClick={() => nav('/SiteAdmin/Sites')}>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Create sites and view the admin site list.
              </div>
            </TvTileButton>
          ) : null}

          {superAdmin ? (
            <TvTileButton title="Feedback" subtitle="Moderation" tone="neutral" onClick={() => nav('/SiteAdmin/ApproveFeedback')}>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                Approve or decline user-submitted feedback.
              </div>
            </TvTileButton>
          ) : null}
        </TileRow>
      </div>
    </div>
  );
}
