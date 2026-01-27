import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../lib/api';

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function Item({
  to,
  label,
  icon,
  end,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'bottomnav-link flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-2xl min-w-[64px] transition-all',
          isActive ? 'is-active' : 'is-inactive',
        )
      }
    >
      {({ isActive }) => (
        <>
          <div className={cx('h-6 w-6 flex items-center justify-center', isActive && 'scale-[1.03]')}>{icon}</div>
          <div className="text-[11px] leading-none text-center whitespace-pre-line font-semibold">{label}</div>
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

function IconSites(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M3 21V7l9-4 9 4v14" />
      <path d="M9 21V12h6v9" />
      <path d="M6 10h.01M6 14h.01M18 10h.01M18 14h.01" />
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

function IconSeed(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M12 3v6" />
      <path d="M9 6h6" />
      <path d="M4 13h16" />
      <path d="M6 21h12" />
      <path d="M6 13v8" />
      <path d="M18 13v8" />
    </svg>
  );
}

function IconTool(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M14.7 6.3a5 5 0 0 0-6.9 6.9l-5.3 5.3a2 2 0 0 0 2.8 2.8l5.3-5.3a5 5 0 0 0 6.9-6.9l-2 2-3-3 2-2z" />
    </svg>
  );


function IconLife(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <path d="M4.93 4.93 8 8" />
      <path d="M19.07 4.93 16 8" />
      <path d="M4.93 19.07 8 16" />
      <path d="M19.07 19.07 16 16" />
    </svg>
  );
}
}

const IS_DEV = import.meta.env.MODE !== 'production';

export default function SiteAdminBottomNav() {
  const [canManageMembers, setCanManageMembers] = useState(false);
  const [canManageSites, setCanManageSites] = useState(false);
  const [canUseTools, setCanUseTools] = useState(false);
  const [canSupport, setCanSupport] = useState(false);
  const [canReconcile, setCanReconcile] = useState(false);

  useEffect(() => {
    (async () => {
      // Single source of truth: server-scoped SiteAdmin permissions.
      try {
        const me: any = await api('/api/site-admin/me');
        setCanUseTools(!!me?.ok);
        setCanManageMembers(!!me?.is_super || !!me?.can_manage);
        setCanManageSites(!!me?.is_super);
        setCanSupport(!!me?.is_super);
        // Reconciliation is available to validators + admins (any SiteAdmin-authorized user)
        setCanReconcile(!!me?.ok);
      } catch {
        setCanManageMembers(false);
        setCanManageSites(false);
        setCanUseTools(false);
        setCanReconcile(false);
        setCanSupport(false);
      }
    })();
  }, []);

  function IconCalc(props: React.SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
        <path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
        <path d="M8 7h8" />
        <path d="M8 11h2" />
        <path d="M12 11h2" />
        <path d="M16 11h0" />
        <path d="M8 15h2" />
        <path d="M12 15h2" />
        <path d="M8 19h8" />
      </svg>
    );
  }


  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t"
      style={{
        background: 'var(--card)',
        borderColor: '#e9d9c3',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div
        className={cx('max-w-2xl mx-auto px-2 py-1 grid text-[var(--text)]')}
        style={{
          gridTemplateColumns: `repeat(${2 + (canManageSites ? 1 : 0) + (canManageMembers ? 1 : 0) + (canReconcile ? 1 : 0) + (canUseTools ? 1 : 0) + (canSupport ? 1 : 0) + (IS_DEV && canManageSites ? 1 : 0)}, minmax(0, 1fr))`,
        }}
      >
        <Item to="/SiteAdmin" end label="Home" icon={<IconHome className="h-6 w-6" />} />
        {canManageSites && (
          <Item to="/SiteAdmin/Sites" label="Sites" icon={<IconSites className="h-6 w-6" />} />
        )}
        {canManageMembers && (<Item to="/SiteAdmin/People" label={'People'} icon={<IconUsers className="h-6 w-6" />} />)}
        <Item to="/SiteAdmin/Validate" label="Validate" icon={<IconCheck className="h-6 w-6" />} />
        {canReconcile && (
          <Item to="/SiteAdmin/Reconciliation" label="Reconcile" icon={<IconCalc className="h-6 w-6" />} />
        )}
        {IS_DEV && canManageSites && (
          <Item to="/SiteAdmin/Seed" label="Seed" icon={<IconSeed className="h-6 w-6" />} />
        )}
        {canUseTools && (
          <Item
            to="/SiteAdmin/Equipment&Locations"
            label={'Equipment\nLocations'}
            icon={<IconTool className="h-6 w-6" />}
          />
        )}
        {canSupport && (
          <Item to="/SiteAdmin/Support" label="Support" icon={<IconLife className="h-6 w-6" />} />
        )}

      </div>
    </nav>
  );
}
