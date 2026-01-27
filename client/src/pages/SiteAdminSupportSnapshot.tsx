import { useMemo, useState } from 'react';
import { api } from '../lib/api';

function Card({ title, children }: { title: string; children: any }) {
  return (
    <div className="card">
      <div className="text-lg font-semibold">{title}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: any }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 border-b" style={{ borderColor: 'var(--hairline)' }}>
      <div className="text-sm tv-muted">{k}</div>
      <div className="text-sm text-right break-all" style={{ maxWidth: '70%' }}>
        {v === null || typeof v === 'undefined' || v === '' ? <span className="tv-muted">—</span> : String(v)}
      </div>
    </div>
  );
}

export default function SiteAdminSupportSnapshot() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [snap, setSnap] = useState<any>(null);

  const normalized = useMemo(() => email.trim().toLowerCase(), [email]);

  async function load() {
    setErr('');
    setBusy(true);
    setSnap(null);
    try {
      const r: any = await api(`/api/site-admin/support-snapshot?email=${encodeURIComponent(normalized)}`);
      setSnap(r);
    } catch (e: any) {
      let msg = e?.message || 'Could not load snapshot';
      try {
        const j = JSON.parse(msg);
        msg = j?.error || msg;
      } catch {
        // ignore
      }
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  const u = snap?.user || null;

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <div className="text-2xl font-semibold">Support Snapshot</div>
          <div className="text-sm tv-muted mt-1">Super-admin tool: diagnose login / subscription / roles / presence in one view.</div>
        </div>
        <div className="flex gap-2">
          <input
            className="input"
            placeholder="user@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ minWidth: 260 }}
          />
          <button className="btn btn-primary" disabled={!normalized || busy} onClick={load}>
            {busy ? 'Loading…' : 'Load'}
          </button>
        </div>
      </div>

      {err ? <div className="card border border-red-300 text-red-700">{err}</div> : null}

      {snap?.ok && u ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <Card title="User">
            <Row k="id" v={u.id} />
            <Row k="name" v={u.name} />
            <Row k="email" v={u.email} />
            <Row k="is_admin" v={u.is_admin} />
            <Row k="billing_exempt" v={u.billing_exempt} />
            <Row k="work_site_id" v={u.work_site_id} />
            <Row k="legacy site (users.site)" v={u.site} />
          </Card>

          <Card title="Subscription">
            <Row k="status" v={u.subscription_status} />
            <Row k="interval" v={u.subscription_interval} />
            <Row k="price_id" v={u.subscription_price_id} />
            <Row k="current_period_end" v={u.current_period_end} />
            <Row k="cancel_at_period_end" v={u.cancel_at_period_end} />
            <Row k="stripe_customer_id" v={u.stripe_customer_id} />
            <Row k="stripe_subscription_id" v={u.stripe_subscription_id} />
            {snap?.scheduled_change?.next ? (
              <div className="mt-3 p-3 rounded-xl" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.25)' }}>
                <div className="text-sm font-semibold">Scheduled change</div>
                <div className="text-sm tv-muted mt-1">Effective: {snap?.scheduled_change?.effective_at || '—'}</div>
                <div className="mt-2 text-sm">
                  Next: {snap?.scheduled_change?.next?.interval || '—'} ({snap?.scheduled_change?.next?.price_id || '—'})
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm tv-muted">No scheduled change detected.</div>
            )}
          </Card>

          <Card title="Memberships">
            {(snap?.memberships || []).length ? (
              <div className="space-y-2">
                {snap.memberships.map((m: any) => (
                  <div key={m.id} className="p-3 rounded-2xl border" style={{ borderColor: 'var(--hairline)' }}>
                    <div className="font-semibold">{m.site_name || '(unknown site)'}</div>
                    <div className="text-sm tv-muted mt-1">
                      role: {m.role || '—'} · status: {m.status || '—'}
                    </div>
                    <div className="text-xs tv-muted mt-1">created: {m.created_at ? new Date(m.created_at).toLocaleString() : '—'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm tv-muted">No admin-site memberships found.</div>
            )}
          </Card>

          <Card title="Presence">
            <div className="text-sm font-semibold mb-2">Current</div>
            <Row k="online" v={snap?.presence_current?.online} />
            <Row k="last_seen" v={snap?.presence_current?.last_seen} />
            <Row k="site_id" v={snap?.presence_current?.site_id} />
            <Row k="site" v={snap?.presence_current?.site} />
            <Row k="state" v={snap?.presence_current?.state} />
            <Row k="region" v={snap?.presence_current?.region} />

            <div className="text-sm font-semibold mt-4 mb-2">Last session</div>
            <Row k="started_at" v={snap?.last_session?.started_at} />
            <Row k="last_seen" v={snap?.last_session?.last_seen} />
            <Row k="ended_at" v={snap?.last_session?.ended_at} />
            <Row k="seconds" v={snap?.last_session?.seconds} />
          </Card>

          <Card title="Audit (last 20)">
            {(snap?.audits || []).length ? (
              <div className="space-y-2">
                {snap.audits.map((a: any, idx: number) => (
                  <div key={idx} className="p-3 rounded-2xl border" style={{ borderColor: 'var(--hairline)' }}>
                    <div className="text-sm font-semibold">{a.action}</div>
                    <div className="text-xs tv-muted mt-1">{a.ts ? new Date(a.ts).toLocaleString() : ''}</div>
                    {a.ip ? <div className="text-xs tv-muted mt-1">ip: {a.ip}</div> : null}
                    {a.meta ? (
                      <pre className="mt-2 text-xs overflow-auto p-2 rounded-xl" style={{ background: 'rgba(0,0,0,0.04)' }}>
{JSON.stringify(a.meta, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm tv-muted">No audit logs found for this user.</div>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
