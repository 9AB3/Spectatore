import Header from '../components/Header';

export default function Privacy() {
  return (
    <div>
      <Header />
      <div className="max-w-3xl mx-auto p-4 pb-24">
        <div className="card p-5 space-y-4">
          <div className="text-xl font-semibold">Spectatore – Privacy &amp; Data Use (v1)</div>
<section className="space-y-2">
            <div className="font-semibold">1. What we collect</div>
            <div className="text-sm text-slate-700">
              We collect account details (email, name) and the shift/activity data you enter (e.g. metres, loads, locations,
              equipment selections). If you enable notifications, we store push subscription details so we can send alerts.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">2. How we use it</div>
            <div className="text-sm text-slate-700">
              We use your data to provide the app features: personal tracking, crew comparisons (if you connect),
              and site reporting (if you join a site). We may also use aggregated, de-identified statistics to improve the app.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">3. Sharing</div>
            <div className="text-sm text-slate-700">
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <b>Personal mode:</b> your data is visible only to you.
                </li>
                <li>
                  <b>Crew connections:</b> if you connect with other users, limited performance metrics may be visible between
                  connected users.
                </li>
                <li>
                  <b>Sites:</b> if you request or accept membership to a site, validated shift data may be visible to site
                  admins/validators for reporting and reconciliation.
                </li>
              </ul>
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">4. Your choices</div>
            <div className="text-sm text-slate-700">
              You can leave a site at any time from Settings. You can disable push notifications in Settings. You can also
              request access to your data or deletion by contacting support.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">5. Security</div>
            <div className="text-sm text-slate-700">
              We take reasonable steps to protect your data, but no system is 100% secure. Do not enter information you are
              not authorised to share.
            </div>
          </section>

          <div className="text-xs text-slate-500 pt-2">Last updated: 12 Jan 2026 (AEST)</div>
        </div>
      </div>
    </div>
  );
}
