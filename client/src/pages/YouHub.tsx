import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Header from '../components/Header';

export default function YouHub() {
  const loc = useLocation();
  const nav = useNavigate();
  const path = loc.pathname.toLowerCase();
  const crew = path.includes('/you/crew');

  return (
    <div>
      <Header />
      <div className="p-4 pb-24 max-w-2xl mx-auto space-y-4">
        <div className="card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs tv-muted">Performance</div>
              <div className="text-2xl font-bold">You</div>
              <div className="text-sm tv-muted">Personal trends and crew comparisons.</div>
            </div>

            <div className="seg-tabs" role="tablist" aria-label="Performance pages">
              <button
                role="tab"
                aria-selected={!crew}
                className={crew ? 'seg-tab' : 'seg-tab seg-tab--active'}
                onClick={() => nav('/You')}
                title="Personal trends"
              >
                You vs You
              </button>
              <button
                role="tab"
                aria-selected={crew}
                className={crew ? 'seg-tab seg-tab--active' : 'seg-tab'}
                onClick={() => nav('/You/Crew')}
                title="Compare to crew"
              >
                You vs Crew
              </button>
            </div>
          </div>
        </div>

        <Outlet />
      </div>
    </div>
  );
}
