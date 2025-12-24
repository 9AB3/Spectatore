import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

const IS_DEV = import.meta.env.MODE !== 'production';

export default function SiteAdminSeed() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [isAdmin, setIsAdmin] = useState(false);
  const [defaultSite, setDefaultSite] = useState('Test');

  const [days, setDays] = useState(60);
  const [site, setSite] = useState('Test');
  const [includeValidated, setIncludeValidated] = useState(true);

  const [running, setRunning] = useState(false);

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const auth: any = await db.get('session', 'auth');
      const ok = !!auth?.token && !!auth?.is_admin;
      setIsAdmin(ok);

      // default site: prefer user's site if present
      const s = String(auth?.site || '').trim();
      const guess = s || 'Test';
      setDefaultSite(guess);
      setSite(guess);

      if (!IS_DEV || !ok) {
        nav('/SiteAdmin');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canRun = useMemo(() => IS_DEV && isAdmin && !running, [isAdmin, running]);

  async function runSeed() {
    if (!canRun) return;
    const d = Math.max(1, Math.min(365, Number(days) || 60));
    const s = (site || defaultSite || 'Test').trim();
    if (!s) return setMsg('Please enter a site');

    setRunning(true);
    try {
      const res: any = await api('/api/admin/seed', {
        method: 'POST',
        body: JSON.stringify({ days: d, site: s, includeValidated }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Seed failed');
      setMsg(`Seeded ${res.days} days for site "${res.site}"`);
    } catch (e: any) {
      setMsg(e?.message || 'Seed failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="min-h-screen p-4 flex flex-col items-center gap-4">
      <Toast />
      <Card>
        <div className="p-4 border-b border-white/10">
          <div className="text-xl font-bold">Dev Seed Data</div>
          <div className="text-sm opacity-80 mt-1">
            Creates demo shifts + activities for reporting/testing. Admin-only and disabled in production.
          </div>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {!IS_DEV && (
            <div className="text-sm p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              Seeding is disabled because this is a production build.
            </div>
          )}

          {!isAdmin && (
            <div className="text-sm p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              You must be logged in as an admin user to seed data.
            </div>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-sm opacity-80">Site</span>
            <input
              className="input"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder={defaultSite}
              disabled={!IS_DEV || !isAdmin || running}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm opacity-80">Days</span>
            <div className="flex gap-2">
              <select
                className="input"
                value={String(days)}
                onChange={(e) => setDays(parseInt(e.target.value || '60', 10))}
                disabled={!IS_DEV || !isAdmin || running}
              >
                <option value="30">30</option>
                <option value="60">60</option>
                <option value="90">90</option>
                <option value="180">180</option>
              </select>
              <input
                className="input"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(parseInt(e.target.value || '60', 10))}
                disabled={!IS_DEV || !isAdmin || running}
              />
            </div>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeValidated}
              onChange={(e) => setIncludeValidated(e.target.checked)}
              disabled={!IS_DEV || !isAdmin || running}
            />
            <span className="text-sm">Also populate validated_* tables (unvalidated)</span>
          </label>

          <div className="flex gap-2">
            <button className="btn w-full" onClick={runSeed} disabled={!canRun}>
              {running ? 'Seeding…' : 'Generate Seed Data'}
            </button>
          </div>

          <div className="text-xs opacity-70 leading-relaxed">
            Tip: you can also run seeding from CLI:
            <div className="mt-1 p-2 rounded bg-black/30 font-mono text-[11px]">
              SEED_USER_EMAIL=you@example.com SEED_SITE=Test SEED_DAYS=60 npm run seed:data
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
