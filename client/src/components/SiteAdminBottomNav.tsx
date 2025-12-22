import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { getDB } from '../lib/idb';

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

function IconMap(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M3 6l6-2 6 2 6-2v16l-6 2-6-2-6 2V6z" />
      <path d="M9 4v16" />
      <path d="M15 6v16" />
    </svg>
  );
}

function IconUsers(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconCheck(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconTool(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M14.7 6.3a5 5 0 0 0-6.9 6.9l-5.3 5.3a2 2 0 0 0 2.8 2.8l5.3-5.3a5 5 0 0 0 6.9-6.9l-2 2-3-3 2-2z" />
    </svg>
  );
}

export default function SiteAdminBottomNav() {
  const [superAdmin, setSuperAdmin] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const db = await getDB();
        const sa: any = await db.get('session', 'site_admin');
        setSuperAdmin(!!sa?.super_admin || (Array.isArray(sa?.sites) && sa.sites.includes('*')));
      } catch {
        setSuperAdmin(false);
      }
    })();
  }, []);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t"
      style={{ background: 'var(--card)', borderColor: '#e9d9c3' }}
    >
      <div
        className={cx(
          'max-w-2xl mx-auto px-2 py-1 grid text-[var(--text)]',
          superAdmin ? 'grid-cols-5' : 'grid-cols-4',
        )}
      >
        <Item to="/SiteAdmin" label="Home" icon={<IconHome className="h-6 w-6" />} />
        {superAdmin && (
          <Item to="/SiteAdmin/Sites" label="Sites" icon={<IconMap className="h-6 w-6" />} />
        )}
        <Item to="/SiteAdmin/SiteAdmins" label={'Site\nAdmins'} icon={<IconUsers className="h-6 w-6" />} />
        <Item to="/SiteAdmin/Validate" label="Validate" icon={<IconCheck className="h-6 w-6" />} />
        <Item
          to="/SiteAdmin/Equipment&Locations"
          label={'Equipment\nLocations'}
          icon={<IconTool className="h-6 w-6" />}
        />
      </div>
    </nav>
  );
}
