import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import jumboIcon from '../assets/jumbo-icon.png';
import crewIcon from '../assets/crew.png';
import youIcon from '../assets/you.png';
import settingsIcon from '../assets/settings.png';
import { api } from '../lib/api';

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function Item({
  to,
  label,
  icon,
  badge,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'bottomnav-link flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-2xl min-w-[64px] transition-all',
          isActive ? 'is-active' : 'is-inactive',
        )
      }
    >
      {({ isActive }) => (
        <>
          <div className={cx('h-6 w-6 flex items-center justify-center', isActive && 'scale-[1.03]')}>
            <div className="relative">
              {icon}
              {badge && badge > 0 ? (
                <span
                  className="absolute -top-2 -right-2 text-[10px] min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center"
                  style={{ background: '#b00020', color: 'white' }}
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              ) : null}
            </div>
          </div>
          <div className="text-[11px] leading-none text-center whitespace-pre-line font-semibold">
            {label}
          </div>
          <div className={cx('mt-1 h-[3px] w-8 rounded-full', isActive ? 'bottomnav-indicator' : 'bg-transparent')} />
        </>
      )}
    </NavLink>
  );
}


function IconHome(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9 21v-6h6v6" />
    </svg>
  );
}

// NOTE: Crew / You / Settings icons are raster assets.
// We use CSS var-driven filtering so they read correctly on desktop (light) and mobile (dark).

export default function BottomNav() {
  const [incomingCount, setIncomingCount] = useState<number>(0);

  // Poll incoming crew requests for the Crew badge
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api('/api/connections/incoming-count');
        if (alive) setIncomingCount(Number(r?.count || 0));
      } catch {
        if (alive) setIncomingCount(0);
      }
    };
    tick();
    const t = setInterval(tick, 20000);
    const on = () => tick();
    window.addEventListener('focus', on);
    window.addEventListener('spectatore:connections', on as any);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('focus', on);
      window.removeEventListener('spectatore:connections', on as any);
    };
  }, []);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t"
      style={{
        background: 'var(--card)',
        borderColor: 'var(--hairline)',
        // Prevent the bar from floating above the bottom on phones with a home indicator.
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="max-w-2xl mx-auto px-2 py-1 grid grid-cols-5 text-[var(--text)]">
        <Item to="/Main" label="Home" icon={<IconHome className="h-6 w-6" />} />
        <Item
          to="/Equipment&Locations"
          label={'Equipment\nLocations'}
          icon={
            <img
              src={jumboIcon}
              className="h-6 w-6 nav-icon"
              alt="Equipment Locations"
            />
          }
        />
        <Item
          to="/Connections"
          label="Crew"
          badge={incomingCount}
          icon={<img src={crewIcon} className="h-6 w-6 nav-icon" alt="Crew" />}
        />
        <Item
          to="/YouVsYou"
          label="You"
          icon={<img src={youIcon} className="h-6 w-6 nav-icon" alt="You" />}
        />
        <Item
          to="/Settings"
          label="Settings"
          icon={
            <img
              src={settingsIcon}
              className="h-6 w-6 nav-icon"
              alt="Settings"
            />
          }
        />
      </div>
    </nav>
  );
}
