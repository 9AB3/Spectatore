import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

export default function SiteAdmin() {
  const nav = useNavigate();
  const [label, setLabel] = useState<string>('');
  const [superAdmin, setSuperAdmin] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [isSiteAdminUser, setIsSiteAdminUser] = useState(false);

function applyScope(payload: any) {
  // Support both snake_case and camelCase keys, and both direct and nested payloads.
  const p = payload?.data ?? payload;
  const isSuper = !!(p?.is_super ?? p?.isSuper ?? p?.super_admin ?? p?.superAdmin);
  const canManageVal =
    !!(p?.can_manage ?? p?.canManage ?? p?.can_manage_members ?? p?.canManageMembers) || isSuper;
  setSuperAdmin(isSuper);
  setCanManage(canManageVal);
  setIsSiteAdminUser(true);
}


  useEffect(() => {
    (async () => {
      const db = await getDB();
      const auth = await db.get('session', 'auth');
      setLabel(auth?.user_id ? 'Site Admin' : 'Site Admin');
      try {
        const me: any = await api('/api/site-admin/me');
        applyScope(me);
      } catch {
        setSuperAdmin(false);
        setCanManage(false);
        setIsSiteAdminUser(false);
      }
    })();
  }, []);

  async function logout() {
    const db = await getDB();
    await db.delete('session', 'auth');
    nav('/Home');
  }

  return (
    <div className="min-h-screen flex items-start justify-center p-4">
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <img src="/logo.png" alt="Spectatore" className="w-14 h-14 object-contain" />
          <div className="flex-1">
            <div className="text-xl font-semibold">Site Admin</div>
            <div className="text-sm opacity-70">{label || 'Admin tools'}</div>
          </div>
          <button className="btn" onClick={logout}>
            Logout
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="font-semibold mb-2">Validation</div>
            <div className="text-sm opacity-70 mb-3">
              Review finalized shifts, make edits, and validate daily totals.
            </div>
            <button className="btn w-full" onClick={() => nav('/SiteAdmin/Validate')}>
              Go to Validate
            </button>
          </div>

          {isSiteAdminUser && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Reconciliation</div>
              <div className="text-sm opacity-70 mb-3">
                Enter month-end reconciled totals and generate daily adjustment allocations for reporting.
              </div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/Reconciliation')}>
                Reconcile
              </button>
            </div>
          )}

          {superAdmin && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Power BI Tokens</div>
              <div className="text-sm opacity-70 mb-3">
                Create per-site tokens for Power BI “From Web” endpoints.
              </div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/PowerBiTokens')}>
                Manage Tokens
              </button>
            </div>
          )}

          {(canManage || superAdmin) && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">People</div>
              <div className="text-sm opacity-70 mb-3">
                Review requests, manage memberships, and adjust roles.
              </div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/People')}>
                Manage People
              </button>
            </div>
          )}
          {isSiteAdminUser && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Equipment & Locations</div>
              <div className="text-sm opacity-70 mb-3">
                Manage equipment and location lists used in validation dropdowns.
              </div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/Equipment&Locations')}>
                Equipment & Locations
              </button>
            </div>
          )}


          {superAdmin && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Sites</div>
              <div className="text-sm opacity-70 mb-3">Create sites and view the admin site list.</div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/Sites')}>
                Manage Sites
              </button>
            </div>
          )}

          {superAdmin && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Feedback</div>
              <div className="text-sm opacity-70 mb-3">Approve or decline user-submitted feedback.</div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/ApproveFeedback')}>
                Approve Feedback
              </button>
            </div>
          )}

          {/* Legacy duplicate cards removed (People covers membership + roles) */}
        </div>
      </Card>
    </div>
  );
}
