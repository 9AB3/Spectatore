import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

interface UserRow {
  id: number;
  email: string;
  name: string;
  site?: string | null;
  state?: string | null;
  is_admin?: number | boolean;
}

export default function AdminUsers() {
  const { setMsg, Toast } = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await api('/api/admin/users');
      setUsers(res.users || []);
    } catch (e: any) {
      console.error(e);
      setMsg('Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const db = await getDB();
        const session = await db.get('session', 'auth');
        if (session?.user_id != null) {
          setCurrentUserId(Number(session.user_id));
        }
      } catch {}
      await loadUsers();
    })();
  }, []);

  async function makeAdmin(id: number) {
    try {
      await api(`/api/admin/users/${id}/make-admin`, { method: 'POST' });
      setMsg('Admin granted');
      await loadUsers();
    } catch (e: any) {
      console.error(e);
      setMsg('Failed to make admin');
    }
  }

  async function removeAdmin(id: number) {
    try {
      await api(`/api/admin/users/${id}/remove-admin`, { method: 'POST' });
      setMsg('Admin removed');
      await loadUsers();
    } catch (e: any) {
      console.error(e);
      setMsg('Failed to remove admin');
    }
  }

  async function deleteUser(id: number) {
    if (!confirm('Delete this user and all their data? This cannot be undone.')) return;
    try {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      setMsg('User deleted');
      await loadUsers();
    } catch (e: any) {
      console.error(e);
      setMsg('Failed to delete user');
    }
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <h1 className="text-xl font-semibold">Admin &amp; Users</h1>
        <p className="text-sm text-slate-600">
          Manage admin access and delete user accounts. You cannot remove admin from yourself or
          delete your own account.
        </p>
        <div className="card overflow-x-auto">
          {loading ? (
            <div className="py-6 text-center text-sm text-slate-500">Loading users...</div>
          ) : users.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-500">No users found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-2">Name</th>
                  <th className="text-left py-2 pr-2">Email</th>
                  <th className="text-left py-2 pr-2">Site</th>
                  <th className="text-left py-2 pr-2">State</th>
                  <th className="text-left py-2 pr-2">Role</th>
                  <th className="text-right py-2 pl-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isAdmin = !!u.is_admin;
                  const isSelf = currentUserId != null && u.id === currentUserId;
                  return (
                    <tr key={u.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-2">
                        <div className="font-medium">
                          {u.name || '(no name)'}
                          {isSelf && <span className="ml-1 text-xs text-sky-600">(you)</span>}
                        </div>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="text-xs text-slate-700">{u.email}</div>
                      </td>
                      <td className="py-2 pr-2">{u.site || '-'}</td>
                      <td className="py-2 pr-2">{u.state || '-'}</td>
                      <td className="py-2 pr-2">
                        {isAdmin ? (
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                            Admin
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                            User
                          </span>
                        )}
                      </td>
                      <td className="py-2 pl-2 text-right space-x-2">
                        {isAdmin ? (
                          <button
                            className="btn btn-sm"
                            disabled={isSelf}
                            onClick={() => !isSelf && removeAdmin(u.id)}
                          >
                            Remove admin
                          </button>
                        ) : (
                          <button className="btn btn-sm" onClick={() => makeAdmin(u.id)}>
                            Make admin
                          </button>
                        )}
                        <button
                          className="btn btn-sm bg-red-600 text-white"
                          disabled={isSelf}
                          onClick={() => !isSelf && deleteUser(u.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
