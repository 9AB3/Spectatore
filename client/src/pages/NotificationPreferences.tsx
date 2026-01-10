import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type Prefs = {
  in_app_milestones: boolean;
  in_app_crew_requests: boolean;
  push_milestones: boolean;
  push_crew_requests: boolean;
};

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      className="btn w-full flex items-center justify-between"
      onClick={onChange}
      aria-pressed={checked}
      style={{ justifyContent: 'space-between' }}
    >
      <span>{label}</span>
      <span
        className="text-[12px] px-2 py-1 rounded-full"
        style={{ background: checked ? 'rgba(0,200,120,0.18)' : 'rgba(255,255,255,0.06)' }}
      >
        {checked ? 'On' : 'Off'}
      </span>
    </button>
  );
}

export default function NotificationPreferences() {
  const { Toast, setMsg } = useToast();
  const nav = useNavigate();

  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busyKey, setBusyKey] = useState<string>('');

  async function load() {
    try {
      const r = await api('/api/notification-preferences/me');
      setPrefs(r as Prefs);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load preferences');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(k: keyof Prefs) {
    if (!prefs) return;
    const next = { ...prefs, [k]: !prefs[k] } as Prefs;
    setPrefs(next);
    setBusyKey(String(k));
    try {
      const r = await api('/api/notification-preferences/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [k]: next[k] }),
      });
      setPrefs(r as Prefs);
      setMsg('Saved');
    } catch (e: any) {
      // revert if save failed
      setPrefs(prefs);
      setMsg(e?.message || 'Save failed');
    } finally {
      setBusyKey('');
    }
  }

  return (
    <div>
      <Toast />
      <Header title="Notification preferences" />

      <div className="p-6 max-w-xl mx-auto space-y-4">
        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-lg font-semibold">Notification preferences</div>
              <div className="text-sm opacity-70">Choose what shows in-app and what pushes to your phone.</div>
            </div>
            <button className="btn" onClick={() => nav(-1)}>
              Back
            </button>
          </div>

          {!prefs ? (
            <div className="text-sm opacity-70">Loading…</div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 rounded-2xl border" style={{ borderColor: 'var(--hairline)' }}>
                <div className="font-semibold mb-2">Milestones</div>
                <div className="grid gap-2">
                  <Toggle
                    label={busyKey === 'in_app_milestones' ? 'In-app (saving…) ' : 'In-app'}
                    checked={!!prefs.in_app_milestones}
                    onChange={() => toggle('in_app_milestones')}
                  />
                  <Toggle
                    label={busyKey === 'push_milestones' ? 'Push (saving…) ' : 'Push'}
                    checked={!!prefs.push_milestones}
                    onChange={() => toggle('push_milestones')}
                  />
                </div>
              </div>

              <div className="p-3 rounded-2xl border" style={{ borderColor: 'var(--hairline)' }}>
                <div className="font-semibold mb-2">Crew requests</div>
                <div className="grid gap-2">
                  <Toggle
                    label={busyKey === 'in_app_crew_requests' ? 'In-app (saving…) ' : 'In-app'}
                    checked={!!prefs.in_app_crew_requests}
                    onChange={() => toggle('in_app_crew_requests')}
                  />
                  <Toggle
                    label={busyKey === 'push_crew_requests' ? 'Push (saving…) ' : 'Push'}
                    checked={!!prefs.push_crew_requests}
                    onChange={() => toggle('push_crew_requests')}
                  />
                </div>
              </div>

              <div className="text-xs opacity-70">
                Tip: If you switch off **Push**, the alert will still appear in your in-app notification list (unless you
                switch that off too).
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
