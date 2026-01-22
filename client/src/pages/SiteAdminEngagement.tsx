import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function StatCard({ title, value, subtitle }: { title: string; value: any; subtitle?: string }) {
  return (
    <div className="tv-tile min-w-[220px] w-[220px] md:w-[260px]">
      <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
        {title}
      </div>
      <div className="mt-2 text-3xl font-extrabold">{value}</div>
      {subtitle ? (
        <div className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

export default function SiteAdminEngagement() {
  const nav = useNavigate();
  const [sites, setSites] = useState<Array<{ name: string }>>([]);
  const [site, setSite] = useState<string>('');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const me: any = await api('/api/site-admin/me');
        const rows = Array.isArray(me?.site_rows) ? me.site_rows : [];
        const list = rows
          .map((r: any) => ({ name: String(r?.name || '').trim() }))
          .filter((x: any) => x.name && x.name !== '*');
        setSites(list);
        if (!site && list.length) setSite(list[0].name);
      } catch {
        // ignore
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    if (!site) return;
    setLoading(true);
    setErr('');
    try {
      const r: any = await api(`/api/site-admin/engagement?site=${encodeURIComponent(site)}`);
      setData(r);
    } catch (e: any) {
      try {
        const j = JSON.parse(e?.message || '{}');
        setErr(j?.error || 'Failed to load engagement');
      } catch {
        setErr('Failed to load engagement');
      }
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  const onlineNow = Array.isArray(data?.online_now) ? data.online_now : [];
  const daily = Array.isArray(data?.daily) ? data.daily : [];
  const weekly = Array.isArray(data?.weekly) ? data.weekly : [];

  const dau = useMemo(() => (daily.length ? Number(daily[0]?.dau || 0) : 0), [daily]);
  const wau = useMemo(() => (weekly.length ? Number(weekly[0]?.wau || 0) : 0), [weekly]);

  return (
    <div className="min-h-screen">
      <div className="p-4 max-w-6xl mx-auto space-y-6 pb-24">
        <div className="tv-tile">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
                Site Admin
              </div>
              <div className="mt-1 text-3xl font-extrabold tracking-tight">Engagement</div>
              <div className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
                Realtime presence + daily/weekly activity.
              </div>
            </div>
            <button className="btn" onClick={() => nav('/SiteAdmin')}>Back</button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="text-sm" style={{ color: 'var(--muted)' }}>Site</div>
            <select
              className={cx('input', 'min-w-[220px]')}
              value={site}
              onChange={(e) => setSite(e.target.value)}
            >
              {sites.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={load} disabled={loading}>
              Refresh
            </button>
            {loading ? <div className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</div> : null}
          </div>
          {err ? <div className="mt-3 text-sm text-red-400">{err}</div> : null}
        </div>

        <div className="tv-row">
          <StatCard title="Online now" value={onlineNow.length} subtitle="Last ~5 minutes" />
          <StatCard title="DAU" value={dau} subtitle="Latest day" />
          <StatCard title="WAU" value={wau} subtitle="Latest week" />
        </div>

        <div className="tv-tile">
          <div className="text-lg font-extrabold">Online now</div>
          <div className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Users with a recent heartbeat.
          </div>
          <div className="mt-4 space-y-2">
            {!onlineNow.length ? (
              <div className="text-sm" style={{ color: 'var(--muted)' }}>No one online right now.</div>
            ) : (
              onlineNow.map((u: any) => (
                <div key={String(u.user_id)} className="flex items-center justify-between gap-3 rounded-2xl border p-3" style={{ borderColor: 'var(--hairline)', background: 'rgba(255,255,255,0.04)' }}>
                  <div>
                    <div className="font-semibold">{u.name || u.email}</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>{u.email}</div>
                  </div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>{u.region_code || u.country_code || ''}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="tv-tile">
          <div className="text-lg font-extrabold">Daily</div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  <th className="text-left py-2">Day</th>
                  <th className="text-right py-2">DAU</th>
                  <th className="text-right py-2">Sessions</th>
                  <th className="text-right py-2">Minutes</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r: any) => (
                  <tr key={String(r.day)} className="border-t" style={{ borderColor: 'var(--hairline)' }}>
                    <td className="py-2">{String(r.day)}</td>
                    <td className="py-2 text-right">{Number(r.dau || 0)}</td>
                    <td className="py-2 text-right">{Number(r.sessions || 0)}</td>
                    <td className="py-2 text-right">{Number(r.total_minutes || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="tv-tile">
          <div className="text-lg font-extrabold">Weekly</div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  <th className="text-left py-2">Week start</th>
                  <th className="text-right py-2">WAU</th>
                  <th className="text-right py-2">Sessions</th>
                  <th className="text-right py-2">Minutes</th>
                </tr>
              </thead>
              <tbody>
                {weekly.map((r: any) => (
                  <tr key={String(r.week_start)} className="border-t" style={{ borderColor: 'var(--hairline)' }}>
                    <td className="py-2">{String(r.week_start)}</td>
                    <td className="py-2 text-right">{Number(r.wau || 0)}</td>
                    <td className="py-2 text-right">{Number(r.sessions || 0)}</td>
                    <td className="py-2 text-right">{Number(r.total_minutes || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
