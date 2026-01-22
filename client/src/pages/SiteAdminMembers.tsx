import Header from '../components/Header';
import SiteAdminBottomNav from '../components/SiteAdminBottomNav';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type Row = {
  id: number;
  user_id: number;
  name: string;
  email: string;
  site: string;
  role: string;
  status: string;
  requested_at?: string;
  approved_at?: string;
};

export default function SiteAdminMembers() {
  const { setMsg, Toast } = useToast();
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberResults, setMemberResults] = useState<Array<{ id: number; name: string; email: string }>>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedUserLabel, setSelectedUserLabel] = useState('');
  const [addRole, setAddRole] = useState<'member' | 'validator' | 'admin'>('member');

  useEffect(() => {
    (async () => {
      try {
        const me: any = await api('/api/site-admin/me');
        const s = Array.isArray(me?.sites) ? me.sites : [];
        setSites(s);
        if (!site && s.length) setSite(s[0]);
      } catch {
        // ignore
      }
    })();
  }, []); // eslint-disable-line

  async function load() {
    if (!site) return;
    try {
      const r: any = await api(`/api/site-admin/members?site=${encodeURIComponent(site)}`);
      setRows((r?.rows || []) as Row[]);
    } catch (e: any) {
      // Don't silently fail – this makes it impossible to debug membership scope issues.
      setMsg(e?.message || 'Failed to load members');
      // keep the previous rows if any
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, [site]);

  const requested = useMemo(() => rows.filter((r) => r.status === 'requested'), [rows]);
  const active = useMemo(() => rows.filter((r) => r.status === 'active'), [rows]);

  async function approveMember(user_id: number) {
    try {
      await api('/api/site-admin/members/approve', {
        method: 'POST',
        body: JSON.stringify({ user_id, site }),
      });
      setMsg('Updated');
      await load();
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    }
  }

  async function revoke(user_id: number) {
    try {
      await api('/api/site-admin/members/revoke', {
        method: 'POST',
        body: JSON.stringify({ user_id, site }),
      });
      setMsg('Revoked');
      await load();
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    }
  }

  async function decline(user_id: number) {
    try {
      await api('/api/site-admin/members/decline', {
        method: 'POST',
        body: JSON.stringify({ user_id, site }),
      });
      setMsg('Declined');
      await load();
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    }
  }

  async function searchMembers(q: string) {
    const qq = q.trim();
    setMemberQuery(q);
    setSelectedUserId(null);
    setSelectedUserLabel('');
    if (qq.length < 2) {
      setMemberResults([]);
      return;
    }
    try {
      const r = await api(`/api/site-admin/members/search?q=${encodeURIComponent(qq)}`);
      setMemberResults(Array.isArray(r?.users) ? r.users : []);
    } catch {
      setMemberResults([]);
    }
  }

  async function addMember() {
    if (!selectedUserId) {
      setMsg('Select a user');
      return;
    }
    try {
      await api('/api/site-admin/members/add', {
        method: 'POST',
        body: JSON.stringify({ user_id: selectedUserId, site, role: addRole }),
      });
      setMemberQuery('');
      setMemberResults([]);
      setSelectedUserId(null);
      setSelectedUserLabel('');
      setMsg('Added');
      await load();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to add');
    }
  }

  return (
    <div>
      <Toast />
      <Header title="Site Members (v7)" />

      <div className="p-4 max-w-3xl mx-auto space-y-4">
        <div className="card p-4 space-y-3">
          <div className="font-semibold">Site</div>
          <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
            {sites.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <div className="pt-2 border-t" />
          <div className="font-semibold">Add member</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="relative">
              <input
                className="input w-full"
                placeholder="Search name (e.g. Alan)"
                value={memberQuery}
                onChange={(e) => searchMembers(e.target.value)}
              />
              {memberResults.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-xl border bg-[color:var(--card)] text-slate-900 shadow-xl">
                  {memberResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-slate-100"
                      onClick={() => {
                        setSelectedUserId(u.id);
                        setSelectedUserLabel(`${u.name || 'Unnamed'}`);
                        setMemberResults([]);
                        setMemberQuery(u.name || '');
                      }}
                    >
                      <div className="font-medium">{u.name || 'Unnamed'}</div>
                    </button>
                  ))}
                </div>
              )}
              {selectedUserId && selectedUserLabel && (
                <div className="mt-1 text-xs opacity-80">Selected: {selectedUserLabel}</div>
              )}
            </div>
            <select className="input" value={addRole} onChange={(e) => setAddRole(e.target.value as any)}>
              <option value="member">Member</option>
              <option value="validator">Validator</option>
              <option value="admin">Site admin</option>
            </select>
            <button className="btn btn-primary" onClick={addMember}>
              Add / Move
            </button>
          </div>
          <div className="text-xs text-[color:var(--muted)]">
            Use this if someone nominated the wrong site during signup.
          </div>
        </div>

        <div className="card p-4">
          <div className="font-semibold mb-2">Membership requests</div>
          {!requested.length ? (
            <div className="text-sm text-[color:var(--muted)]">No pending requests.</div>
          ) : (
            <div className="space-y-2">
              {requested.map((r) => (
                <div key={r.id} className="p-3 rounded-xl border flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                  <div>
                    <div className="font-semibold">{r.name || 'Unnamed'}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn" onClick={() => approveMember(r.user_id)}>
                      Approve member
                    </button>
<button className="btn btn-outline" onClick={() => decline(r.user_id)}>
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-4">
          <div className="font-semibold mb-2">Active members</div>
          {!active.length ? (
            <div className="text-sm text-[color:var(--muted)]">No active members for this site.</div>
          ) : (
            <div className="space-y-2">
              {active.map((r) => (
                <div key={r.id} className="p-3 rounded-xl border flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                  <div>
                    <div className="font-semibold">{r.name || 'Unnamed'}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs px-2 py-1 rounded-full bg-slate-100">{r.role}</span>
                    <button className="btn" onClick={() => approveMember(r.user_id)}>
                      Member
                    </button>
<button className="btn" onClick={() => revoke(r.user_id)}>
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <SiteAdminBottomNav />
    </div>
  );
}
