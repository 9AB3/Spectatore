import Header from '../components/Header';
import { getDB } from '../lib/idb';

export default function ClearData() {
  async function clearAll() {
    // Clear IndexedDB store(s)
    try {
      const db = await getDB();
      const stores = ['activities', 'shifts', 'kv', 'users'];
      for (const s of stores) {
        try {
          await db.clear(s as any);
        } catch {}
      }
    } catch {}
    // Clear localStorage/sessionStorage
    try {
      localStorage.clear();
    } catch {}
    try {
      sessionStorage.clear();
    } catch {}
    alert('Local data cleared on this device.');
  }
  return (
    <div>
      <Header />
      <div className="p-6 max-w-xl mx-auto">
        <div className="card">
          <h2 className="text-xl font-semibold mb-2">Maintenance</h2>
          <p className="text-slate-600 mb-4">
            Clear all local user data (IndexedDB & storage) on this device.
          </p>
          <button className="btn btn-danger" onClick={clearAll}>
            Clear local data
          </button>
        </div>
      </div>
    </div>
  );
}
