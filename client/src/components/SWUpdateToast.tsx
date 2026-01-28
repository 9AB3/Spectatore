import { useEffect, useState } from 'react';

export default function SWUpdateToast() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const on = () => setShow(true);
    window.addEventListener('spectatore:sw-update', on as any);
    return () => window.removeEventListener('spectatore:sw-update', on as any);
  }, []);

  if (!show) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 12,
        zIndex: 9999,
      }}
    >
      <div className="card p-3" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>Update available</div>
          <div style={{ opacity: 0.9, fontSize: 13 }}>Refresh to load the latest Spectatore version.</div>
        </div>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          REFRESH
        </button>
        <button className="btn btn-secondary" onClick={() => setShow(false)}>
          LATER
        </button>
      </div>
    </div>
  );
}
