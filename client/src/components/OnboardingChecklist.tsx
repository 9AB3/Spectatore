import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

type Step = { key: string; label: string; done: boolean };
type Status = { steps: Step[]; completedCount: number; total: number; allDone: boolean };

export default function OnboardingChecklist({
  status,
  onRefresh,
  onClose,
}: {
  status: Status;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const nav = useNavigate();

  async function markDone(key: string) {
    await api('/api/user/onboarding/complete', { method: 'POST', body: { key } });
    await onRefresh();
  }

  const pct = status.total ? Math.round((status.completedCount / status.total) * 100) : 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(560px, 100%)',
          borderRadius: 18,
          background: 'var(--card, #fff)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          padding: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Getting started</div>
            <div style={{ opacity: 0.7, marginTop: 2 }}>
              {status.completedCount}/{status.total} complete ({pct}%)
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              border: 0,
              background: 'transparent',
              fontSize: 22,
              cursor: 'pointer',
              lineHeight: 1,
              opacity: 0.7,
            }}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </div>

        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          {status.steps.map((s) => (
            <div
              key={s.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 12px',
                borderRadius: 14,
                border: '1px solid rgba(0,0,0,0.08)',
                background: s.done ? 'rgba(0,0,0,0.03)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    border: '2px solid rgba(0,0,0,0.35)',
                    background: s.done ? 'rgba(0,0,0,0.75)' : 'transparent',
                  }}
                  aria-hidden="true"
                />
                <div style={{ fontWeight: 700 }}>{s.label}</div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!s.done ? (
                  <>
                    <button
                      onClick={() => {
                        // Helpful shortcuts
                        if (s.key === 'start_shift') nav('/Main');
                        if (s.key === 'submit_feedback') nav('/Feedback');
                        if (s.key === 'join_site') nav('/Connections');
                        if (s.key === 'tag_out') nav('/Main');
                      }}
                      style={{
                        border: '1px solid rgba(0,0,0,0.18)',
                        background: 'transparent',
                        padding: '8px 10px',
                        borderRadius: 12,
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      Go
                    </button>
                    <button
                      onClick={() => markDone(s.key)}
                      style={{
                        border: 0,
                        background: 'rgba(0,0,0,0.85)',
                        color: '#fff',
                        padding: '8px 10px',
                        borderRadius: 12,
                        cursor: 'pointer',
                        fontWeight: 800,
                      }}
                    >
                      Mark done
                    </button>
                  </>
                ) : (
                  <span style={{ fontWeight: 800, opacity: 0.7 }}>Done</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button
            onClick={async () => {
              localStorage.setItem('spectatore-onboarding-hide-until', String(Date.now() + 7 * 24 * 3600 * 1000));
              onClose();
            }}
            style={{
              border: '1px solid rgba(0,0,0,0.18)',
              background: 'transparent',
              padding: '10px 12px',
              borderRadius: 14,
              cursor: 'pointer',
              fontWeight: 800,
            }}
          >
            Hide for a week
          </button>
        </div>
      </div>
    </div>
  );
}
