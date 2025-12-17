import React from 'react';
import { NavLink } from 'react-router-dom';
import jumboIcon from '../assets/jumbo-icon.png';
import crewIcon from '../assets/crew.png';
import youIcon from '../assets/you.png';
import settingsIcon from '../assets/settings.png';

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function Item({
  to,
  label,
  icon,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'flex flex-col items-center justify-center gap-1 px-2 py-2 rounded-xl min-w-[56px]',
          isActive ? 'font-semibold text-[var(--brand)]' : 'opacity-70',
        )
      }
    >
      <div className="h-6 w-6 flex items-center justify-center">{icon}</div>
      <div className="text-[11px] leading-none text-center whitespace-pre-line">{label}</div>
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

// NOTE: Crew / You / Settings icons are provided as raster assets for a consistent mining theme.

export default function BottomNav() {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t"
      style={{ background: 'var(--card)', borderColor: '#e9d9c3' }}
    >
      <div className="max-w-2xl mx-auto px-2 py-1 grid grid-cols-5 text-[var(--text)]">
        <Item to="/Main" label="Home" icon={<IconHome className="h-6 w-6" />} />
        <Item
          to="/Equipment&Locations"
          label={'Equipment\nLocations'}
          icon={
            <img
              src={jumboIcon}
              className="h-6 w-6 filter brightness-0 contrast-200"
              alt="Equipment Locations"
            />
          }
        />
        <Item
          to="/Connections"
          label="Crew"
          icon={<img src={crewIcon} className="h-6 w-6 filter brightness-0" alt="Crew" />}
        />
        <Item
          to="/PerformanceReview"
          label="You"
          icon={<img src={youIcon} className="h-6 w-6 filter brightness-0" alt="You" />}
        />
        <Item
          to="/Settings"
          label="Settings"
          icon={
            <img
              src={settingsIcon}
              className="h-6 w-6 filter brightness-0"
              alt="Settings"
            />
          }
        />
      </div>
    </nav>
  );
}
