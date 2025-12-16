import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { getDB } from '../lib/idb';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';

export default function Shift() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [abortOpen, setAbortOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const ls = localStorage.getItem('spectatore-shift');
      if (ls) {
        const data = JSON.parse(ls);
        await db.put('shift', { date: data.date, dn: data.dn }, 'current');
      }
      setLoaded(true);
    })();
  }, []);

  async function cancelShift() {
    // UI modal confirmation (matches the Start Shift modal pattern)
    setAbortOpen(true);
  }

  async function confirmAbort() {
    setAbortOpen(false);

    try {
      const db = await getDB();

      // Clear activities for current local device (since activities aren't tagged by shift yet)
      const tx = db.transaction('activities', 'readwrite');
      const store = tx.objectStore('activities');
      const all = await store.getAll();
      for (const row of all) {
        await store.delete(row.id);
      }
      await tx.done;

      // Clear shift state
      await db.delete('shift', 'current');
      localStorage.removeItem('spectatore-shift');

      setMsg('Shift cancelled');
      // Keep toast visible for at least 2s before route change
      setTimeout(() => nav('/Main'), 2000);
    } catch (e) {
      console.error(e);
      setMsg('Failed to cancel shift');
    }
  }

  if (!loaded) return null;

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 grid gap-4 max-w-xl mx-auto">
        <button className="btn btn-primary" onClick={() => nav('/Activity')}>
          NEW ACTIVITY
        </button>
        <button className="btn btn-primary" onClick={() => nav('/ViewActivities')}>
          VIEW ACTIVITY
        </button>
        <button className="btn btn-primary" onClick={() => nav('/FinalizeShift')}>
          FINALIZE SHIFT
        </button>
        <button className="btn btn-secondary" onClick={cancelShift}>
          CANCEL SHIFT
        </button>
      </div>

      {abortOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center">
          <div className="card w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-3">Abort shift</h3>
            <div className="space-y-4">
              <div>Abort shift - shift data will be lost</div>
              <div className="flex gap-2">
                <button className="btn flex-1" onClick={confirmAbort}>
                  Yes
                </button>
                <button className="btn flex-1" onClick={() => setAbortOpen(false)}>
                  No
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
