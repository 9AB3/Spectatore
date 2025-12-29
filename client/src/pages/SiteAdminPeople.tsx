import Header from '../components/Header';
import SiteAdminBottomNav from '../components/SiteAdminBottomNav';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type SiteRow = { id: number; name: string; state?: string | null };

type Row = {
  id: number;
  user_id: number;
  name: string;
  email: string;
  site: string;
  role: 'member' | 'validator' | 'admin' | string;
  status: 'requested' | 'active' | 'revoked' | string;
  requested_at?: string | null;
  approved_at?: string | null;
};

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function Badge({ children, tone }: { children: any; tone: 'gray' | 'green' | 'blue' | 'amber' | 'red' }) {
  const cls =
    tone === 'green'
      ? 'bg-green-100 text-green-900'
      : tone === 'blue'
        ? 'bg-blue-100 text-blue-900'
        : tone === 'amber'
          ? 'bg-amber-100 text-amber-900'
          : tone === 'red'
            ? 'bg-red-100 text-red-900'
            : 'bg-slate-100 text-slate-900';
  return <span className={cx('px-2 py-1 rounded-full text-xs font-semibold', cls)}>{children}</span>;
}

export default function SiteAdminPeople() {
  const { setMsg, Toast } = useToast();
  const nav = useNavigate();
  const [canManage, setCanManage] = useState<boolean | null>(null);

  const [siteRows, setSiteRows] = useState<SiteRow[]>([]);
  const [site, setSite] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [tab, setTab] = useState<'requests' | 'active'>('requests');

  const [memberQuery, setMemberQuery] = useState('');
  const [memberResults, setMemberResults] = useState<Array<{ id: number; name: string; email: string }>>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedUserLabel, setSelectedUserLabel] = useState('');
  const [addRole, setAddRole] = useState<'member' | 'validator' | 'admin'>('member');

  useEffect(() => {
    (async () => {
      try {
        const me: any = await api('/api/site-admin/me');
        const sr = Array.isArray(me?.site_rows) ? (me.site_rows as SiteRow[]) : [];
        setSiteRows(sr);
        if (!site && sr.length === 1) setSite(sr[0].name);

        const can = !!me?.is_super || !!me?.can_manage;
        setCanManage(can);

        // Defensive: if someone types /SiteAdmin/People without access, bounce to SiteAdmin Home.
        if (!can) nav('/SiteAdmin', { replace: true });
      } catch {
        setCanManage(false);
        // If auth is broken, bounce to login (RequireSiteAdmin should normally handle this)
        nav('/SiteAdminLogin', { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMembers(chosenSite: string) {
    if (!chosenSite) return;
    try {
      const r: any = await api('/api/site-admin/members?site=' + encodeURIComponent(chosenSite));
      setRows(Array.isArray(r?.rows) ? (r.rows as Row[]) : []);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load people');
    }
  }

  useEffect(() => {
    loadMembers(site);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  const requests = useMemo(() => rows.filter((r) => r.status === 'requested' || r.status === 'invited'), [rows]);
  const active = useMemo(() => rows.filter((r) => r.status === 'active'), [rows]);

  async function approve(user_id: number, role: 'member' | 'validator' | 'admin') {
    try {
      await api('/api/site-admin/members/approve', {
        method: 'POST',
        body: { site, user_id, role },
      });
      setMsg('Updated');
      await loadMembers(site);
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    }
  }

  async function revoke(user_id: number) {
    try {
      await api('/api/site-admin/members/revoke', {
        method: 'POST',
        body: { site, user_id },
      });
      setMsg('Revoked');
      await loadMembers(site);
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    }
  }

  async function searchPeople(q: string) {
    setMemberQuery(q);
    setSelectedUserId(null);
    setSelectedUserLabel('');
    if (!q.trim() || !site) {
      setMemberResults([]);
      return;
    }
    try {
      const r: any = await api(
        '/api/site-admin/members/search?site=' + encodeURIComponent(site) + '&q=' + encodeURIComponent(q.trim()),
      );
      setMemberResults(Array.isArray(r?.rows) ? r.rows : []);
    } catch {
      setMemberResults([]);
    }
  }

  async function addPerson() {
    try {
      if (!site) return setMsg('Pick a site');
      if (!selectedUserId) return setMsg('Pick a user');
      await api('/api/site-admin/members/add', {
        method: 'POST',
        body: { site, user_id: selectedUserId, role: addRole },
      });
      setMsg('Invite sent (user must accept)');
      setMemberQuery('');
      setMemberResults([]);
      setSelectedUserId(null);
      setSelectedUserLabel('');
      await loadMembers(site);
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    }
  }

  // While checking permissions, render nothing.
  if (canManage === null) return null;
  // If user lacks manage rights, the effect will redirect; render nothing to avoid flashing.
  if (!canManage) return null;

  return (
    <div className="min-h-screen bg-slate-50">
      <Header title="People" />
      <Toast />

      <div className="max-w-4xl mx-auto px-4 pb-28">
        <div className="mt-4 bg-white rounded-2xl shadow p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-sm font-semibold text-slate-700">Site</div>
            <select
              className="border rounded-xl px-3 py-2 text-sm bg-white"
              value={site}
              onChange={(e) => setSite(e.target.value)}
            >
              <option value="">Select site…</option>
              {siteRows.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>

            <div className="ml-auto flex items-center gap-2">
              <button
                className={cx(
                  'px-3 py-2 rounded-xl text-sm font-semibold border',
                  tab === 'requests' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-800',
                )}
                onClick={() => setTab('requests')}
              >
                Requests <span className="ml-1 text-xs opacity-90">({requests.length})</span>
              </button>
              <button
                className={cx(
                  'px-3 py-2 rounded-xl text-sm font-semibold border',
                  tab === 'active' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-800',
                )}
                onClick={() => setTab('active')}
              >
                Active <span className="ml-1 text-xs opacity-90">({active.length})</span>
              </button>
            </div>
          </div>

          <div className="mt-4 border-t pt-4">
            <div className="text-sm font-semibold text-slate-800">Add / Search</div>
            <div className="mt-2 flex gap-2 flex-wrap items-center">
              <input
                className="border rounded-xl px-3 py-2 text-sm bg-white min-w-[260px]"
                placeholder="Search user by name/email…"
                value={memberQuery}
                onChange={(e) => searchPeople(e.target.value)}
              />
              <select
                className="border rounded-xl px-3 py-2 text-sm bg-white"
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as any)}
              >
                <option value="member">Member</option>
                <option value="validator">Validator</option>
                <option value="admin">Admin</option>
              </select>
              <button className="px-3 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white" onClick={addPerson}>
                Invite
              </button>
              {selectedUserLabel ? (
                <div className="text-xs text-slate-600">Selected: {selectedUserLabel}</div>
              ) : (
                <div className="text-xs text-slate-500">Pick a user from results</div>
              )}
            </div>

            {memberResults.length > 0 && (
              <div className="mt-2 max-h-48 overflow-auto border rounded-xl">
                {memberResults.map((u) => (
                  <button
                    key={u.id}
                    className={cx(
                      'w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex justify-between gap-2',
                      selectedUserId === u.id ? 'bg-slate-100' : '',
                    )}
                    onClick={() => {
                      setSelectedUserId(u.id);
                      setSelectedUserLabel(`${u.name || ''} (${u.email})`.trim());
                    }}
                  >
                    <span className="font-medium text-slate-800">{u.name || '(no name)'}</span>
                    <span className="text-slate-500">{u.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 bg-white rounded-2xl shadow">
          <div className="p-4 border-b">
            <div className="text-sm font-semibold text-slate-800">{tab === 'requests' ? 'Membership Requests' : 'Active Members'}</div>
            <div className="text-xs text-slate-500">
              Authority comes from <span className="font-mono">site_memberships</span>. User.site is legacy only.
            </div>
          </div>

          <div className="divide-y">
            {(tab === 'requests' ? requests : active).map((r) => (
              <div key={`${r.user_id}-${r.id}`} className="p-4 flex flex-col md:flex-row md:items-center gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-semibold text-slate-900">{r.name || '(no name)'}</div>
                    <Badge tone={r.status === 'active' ? 'green' : r.status === 'requested' ? 'amber' : 'gray'}>{r.status}</Badge>
                    <Badge tone={r.role === 'admin' ? 'blue' : r.role === 'validator' ? 'green' : 'gray'}>{r.role}</Badge>
                  </div>
                  <div className="text-sm text-slate-600">{r.email}</div>
                </div>

                {tab === 'requests' ? (
                  <div className="flex gap-2 flex-wrap">
                    {String(r.status).toLowerCase() === 'invited' ? (
                      <>
                        <div className="text-xs text-slate-500 flex items-center">
                          Invited — waiting for user to accept/deny
                        </div>
                        <button
                          className="px-3 py-2 rounded-xl text-sm font-semibold border"
                          onClick={() => revoke(r.user_id)}
                          title="Revoke invitation"
                        >
                          Revoke invite
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="px-3 py-2 rounded-xl text-sm font-semibold bg-slate-900 text-white"
                          onClick={() => approve(r.user_id, 'member')}
                        >
                          Approve member
                        </button>
                        <button
                          className="px-3 py-2 rounded-xl text-sm font-semibold bg-green-600 text-white"
                          onClick={() => approve(r.user_id, 'validator')}
                        >
                          Approve validator
                        </button>
                        <button
                          className="px-3 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white"
                          onClick={() => approve(r.user_id, 'admin')}
                        >
                          Approve admin
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex gap-2 flex-wrap items-center">
                    <select className="border rounded-xl px-3 py-2 text-sm bg-white" value={r.role} onChange={(e) => approve(r.user_id, e.target.value as any)}>
                      <option value="member">Member</option>
                      <option value="validator">Validator</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button className="px-3 py-2 rounded-xl text-sm font-semibold border" onClick={() => revoke(r.user_id)}>
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            ))}

            {(tab === 'requests' ? requests : active).length === 0 && <div className="p-6 text-sm text-slate-500">Nothing here yet.</div>}
          </div>
        </div>
      </div>

      <SiteAdminBottomNav />
    </div>
  );
}
