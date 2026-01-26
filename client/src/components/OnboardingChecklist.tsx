import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

type Step = {
  key: string;
  title: string;
  description?: string;
  completed: boolean;
  cta?: { label: string; path: string };
};

type Status = {
  steps: Step[];
  completedCount: number;
  totalCount: number;
  completed: boolean;
};

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CircleIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export default function OnboardingChecklist() {
  const nav = useNavigate();
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api('/api/user/onboarding/status');
        if (!alive) return;
        setStatus(res);
      } catch {
        // If this fails, don't block the UI.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const remaining = useMemo(() => {
    if (!status) return 0;
    return status.totalCount - status.completedCount;
  }, [status]);

  if (dismissed) return null;
  if (!status) return null;
  if (status.completed) return null;

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-black/30 p-4 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">Quick start checklist</div>
          <div className="mt-1 text-sm text-white/70">
            {status.completedCount}/{status.totalCount} complete • {remaining} left
          </div>
        </div>
        <button
          className="rounded-lg px-3 py-1 text-sm text-white/70 hover:bg-white/10"
          onClick={() => setDismissed(true)}
        >
          Hide
        </button>
      </div>

      <div className="mt-3 space-y-2">
        {status.steps.slice(0, 6).map((s) => (
          <div key={s.key} className="flex items-start justify-between gap-3 rounded-xl bg-white/5 p-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-white/80">
                {s.completed ? <CheckIcon className="h-5 w-5" /> : <CircleIcon className="h-5 w-5" />}
              </div>
              <div>
                <div className="text-sm font-medium">{s.title}</div>
                {s.description ? <div className="mt-0.5 text-xs text-white/60">{s.description}</div> : null}
              </div>
            </div>

            {!s.completed && s.cta?.path ? (
              <button
                className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-xs font-medium hover:bg-white/15"
                onClick={() => nav(s.cta!.path)}
              >
                {s.cta?.label || 'Open'}
              </button>
            ) : (
              <div className="shrink-0 text-xs text-white/50">{s.completed ? 'Done' : ''}</div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <button
          className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
          onClick={() => {
            const next = status.steps.find((x) => !x.completed && x.cta?.path)?.cta?.path;
            if (next) nav(next);
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
