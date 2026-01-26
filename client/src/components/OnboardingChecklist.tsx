import React, { useEffect, useMemo, useState } from 'react';
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
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 430px)');
    const apply = () => setIsMobile(Boolean(mq.matches));
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  async function markDone(key: string) {
    await api('/api/user/onboarding/complete', { method: 'POST', body: { key } });
    await onRefresh();
  }

  function go(key: string) {
    // Close the onboarding sheet before navigating/opening other UI (e.g. Start Shift modal),
    // otherwise the target modal can render "behind" this overlay on mobile.
    onClose();
    window.setTimeout(() => {
      if (key === 'setup_equipment_locations') nav('/Equipment&Locations');
      if (key === 'start_shift') nav('/Main?openStartShift=1');
      if (key === 'connect_crew') nav('/Connections');
      if (key === 'review_progress') nav('/You');
    }, 50);
  }

  const pct = status.total ? Math.round((status.completedCount / status.total) * 100) : 0;

  const styles = useMemo(() => {
    const backdrop = {
      position: 'fixed' as const,
      inset: 0,
      background: 'rgba(0,0,0,0.86)',
      WebkitBackdropFilter: 'blur(14px)',
      backdropFilter: 'blur(14px)',
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: isMobile ? 12 : 16,
    };

    const shell = {
      width: isMobile ? 'calc(100vw - 24px)' : 'min(560px, 100%)',
      maxHeight: isMobile ? 'none' : 'min(78vh, 720px)',
      overflow: isMobile ? 'hidden' : 'auto',
      overscrollBehavior: 'contain',
      borderRadius: isMobile ? 26 : 18,
      background: 'rgba(18,18,18,0.96)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      padding: isMobile ? 12 : 16,    };

    const item = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: isMobile ? '14px 12px' : '10px 12px',
      borderRadius: 16,
      border: '1px solid rgba(255,255,255,0.10)',
      background: 'rgba(255,255,255,0.04)',
    };

    const btnGhost = {
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'transparent',
      color: '#fff',
      padding: '8px 10px',
      borderRadius: 12,
      cursor: 'pointer',
      fontWeight: 800,
      whiteSpace: 'nowrap' as const,
    };

    const btnPrimary = {
      border: 0,
      background: 'rgba(255,255,255,0.90)',
      color: '#000',
      padding: '8px 10px',
      borderRadius: 12,
      cursor: 'pointer',
      fontWeight: 900,
      whiteSpace: 'nowrap' as const,
    };

    return { backdrop, shell, item, btnGhost, btnPrimary };
  }, [isMobile]);

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.shell} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: isMobile ? 18 : 18, fontWeight: 900 }}>Getting started</div>
            <div style={{ opacity: 0.8, marginTop: 2 }}>
              {status.completedCount}/{status.total} complete ({pct}%)
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              border: 0,
              background: 'transparent',
              fontSize: 26,
              cursor: 'pointer',
              lineHeight: 1,
              opacity: 0.8,
              color: '#fff',
            }}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </div>

        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          {status.steps.map((s) => {
            const rowBase: React.CSSProperties = { ...styles.item, opacity: s.done ? 0.75 : 1 };

            // Mobile: prevent horizontal overflow and keep everything within viewport (no scrolling)
            if (isMobile) {
              return (
                <div key={s.key} style={{ ...rowBase, padding: '10px 10px', gap: 10, alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 999,
                        border: '2px solid rgba(255,255,255,0.35)',
                        background: s.done ? 'rgba(255,255,255,0.92)' : 'transparent',
                        flex: '0 0 auto',
                      }}
                      aria-hidden="true"
                    />
                    <div
                      style={{
                        fontWeight: 850,
                        fontSize: 16,
                        lineHeight: 1.2,
                        minWidth: 0,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical' as const,
                        opacity: s.done ? 0.85 : 1,
                      }}
                    >
                      {s.label}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    {!s.done ? (
                      <>
                        <button
                          onClick={() => go(s.key)}
                          style={{
                            ...styles.btnGhost,
                            padding: '8px 12px',
                            borderRadius: 14,
                            fontSize: 15,
                            fontWeight: 900,
                          }}
                        >
                          Go
                        </button>
                        <button
                          onClick={() => markDone(s.key)}
                          style={{
                            ...styles.btnPrimary,
                            padding: '8px 12px',
                            borderRadius: 14,
                            fontSize: 15,
                            fontWeight: 900,
                          }}
                        >
                          Done
                        </button>
                      </>
                    ) : (
                      <span style={{ fontWeight: 900, opacity: 0.9 }}>Done</span>
                    )}
                  </div>
                </div>
              );
            }

            // Desktop/tablet
            return (
              <div key={s.key} style={rowBase}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 999,
                      border: '2px solid rgba(255,255,255,0.35)',
                      background: s.done ? 'rgba(255,255,255,0.92)' : 'transparent',
                      flex: '0 0 auto',
                    }}
                    aria-hidden="true"
                  />
                  <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.label}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {!s.done ? (
                    <>
                      <button onClick={() => go(s.key)} style={styles.btnGhost}>
                        Go
                      </button>
                      <button onClick={() => markDone(s.key)} style={styles.btnPrimary}>
                        Mark done
                      </button>
                    </>
                  ) : (
                    <span style={{ fontWeight: 900, opacity: 0.9 }}>Done</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
          <button
            onClick={async () => {
              localStorage.setItem('spectatore-onboarding-hide-until', String(Date.now() + 7 * 24 * 3600 * 1000));
              onClose();
            }}
            style={{
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'transparent',
              color: '#fff',
              padding: isMobile ? '8px 12px' : '10px 12px',
              borderRadius: 14,
              cursor: 'pointer',
              fontWeight: 900,
            }}
          >
            Hide for a week
          </button>
        </div>
      </div>
    </div>
  );
}
