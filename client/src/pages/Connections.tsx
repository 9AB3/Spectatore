import Header from '../components/Header';
import { useNavigate } from 'react-router-dom';

export default function Connections() {
  const nav = useNavigate();

  return (
    <div>
      <Header />

      <div className="p-6 max-w-2xl mx-auto">
        <div className="card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-lg font-semibold">Crew Connections</div>
              <div className="text-sm text-slate-600 mt-1">
                Connect with crew mates to compare performance, share milestones, and build your network.
              </div>
            </div>
            <button className="btn btn-secondary flex-shrink-0" onClick={() => nav('/Main')}>
              Back
            </button>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mt-5">
            <button
              className="text-left rounded-xl border border-slate-200 hover:bg-slate-50 p-4 transition"
              onClick={() => nav('/AddConnection')}
              type="button"
            >
              <div className="font-semibold">Add crew member</div>
              <div className="text-sm text-slate-600 mt-1">
                Send a connection request to another operator.
              </div>
              <div className="mt-3">
                <span className="btn btn-primary">Add</span>
              </div>
            </button>

            <button
              className="text-left rounded-xl border border-slate-200 hover:bg-slate-50 p-4 transition"
              onClick={() => nav('/ViewConnections')}
              type="button"
            >
              <div className="font-semibold">View connections</div>
              <div className="text-sm text-slate-600 mt-1">
                Manage requests, accept/decline, and see your current network.
              </div>
              <div className="mt-3">
                <span className="btn btn-primary">Open</span>
              </div>
            </button>
          </div>

          <div className="mt-5 text-xs text-slate-500">
            Tip: once connected, you can compare against a specific crew member inside <strong>You vs Crew</strong>.
          </div>
        </div>
      </div>
    </div>
  );
}
