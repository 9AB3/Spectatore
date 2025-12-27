import Header from '../components/Header';

export default function Terms() {
  return (
    <div>
      <Header />
      <div className="max-w-3xl mx-auto p-4 pb-24">
        <div className="card p-5 space-y-4">
          <div className="text-xl font-semibold">Spectatore – Terms &amp; Conditions (v1)</div>

          <div className="text-sm text-slate-600">
            This is a plain-English summary. For production use, have a lawyer review these terms for your jurisdiction.
          </div>

          <section className="space-y-2">
            <div className="font-semibold">1. Using the app</div>
            <div className="text-sm text-slate-700">
              Spectatore lets you record shift activity and performance metrics. You agree to use the app lawfully and
              only for authorised work purposes.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">2. Data you provide</div>
            <div className="text-sm text-slate-700">
              You are responsible for the accuracy of the information you enter. Do not upload confidential information
              unless you have permission to do so.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">3. Company and site information</div>
            <div className="text-sm text-slate-700">
              Your employer/site may treat operational data as confidential. You must follow your employer&apos;s policies.
              If you are unsure, do not share or publish site-identifiable information.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">4. Crew connections &amp; sharing</div>
            <div className="text-sm text-slate-700">
              If you connect with other crew members, your name and selected performance metrics may be visible to them.
              You control who you connect with. Do not connect if this would breach workplace policy or contract terms.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">5. Public / cross-site comparisons</div>
            <div className="text-sm text-slate-700">
              The app may display aggregated comparisons (e.g., network averages) across users and sites. We aim to
              aggregate and de-identify wherever possible, but you acknowledge that some information could be inferred
              from context.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">6. No warranties</div>
            <div className="text-sm text-slate-700">
              The app is provided “as is”. It is not a safety system and must not be relied upon for operational or safety
              critical decisions.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">7. Liability</div>
            <div className="text-sm text-slate-700">
              To the maximum extent permitted by law, Spectatore is not liable for any indirect or consequential loss,
              including lost production, business interruption, or policy breaches caused by user input or sharing.
            </div>
          </section>

          <section className="space-y-2">
            <div className="font-semibold">8. Changes</div>
            <div className="text-sm text-slate-700">
              We may update these terms. If the terms version changes, you may be asked to accept again.
            </div>
          </section>

          <div className="text-xs text-slate-500 pt-2">
            Last updated: 27 Dec 2025 (AEST)
          </div>
        </div>
      </div>
    </div>
  );
}
