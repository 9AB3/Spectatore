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


  function handleFinalize() {
    if (!navigator.onLine) {
      setMsg('Offline - please connect to network and try again');
      return;
    }
    nav('/FinalizeShift');
  }

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
      <div className="p-4 max-w-2xl mx-auto space-y-4">
        <div className="card">
          <div className="text-xs opacity-70">Shift</div>
          <div className="text-2xl font-bold">Log activities</div>
          <div className="text-sm opacity-70 mt-1">Create, review, and finalize your shift data.</div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <button className="btn btn-primary" onClick={() => nav('/Activity')} style={{ paddingTop: 18, paddingBottom: 18 }}>
            NEW ACTIVITY
            <div className="text-xs opacity-70 mt-1">Add a task for this shift</div>
          </button>
          <button className="btn btn-primary" onClick={() => nav('/ViewActivities')} style={{ paddingTop: 18, paddingBottom: 18 }}>
            VIEW ACTIVITY
            <div className="text-xs opacity-70 mt-1">Review and edit entries</div>
          </button>
          <button className="btn btn-primary" onClick={handleFinalize} style={{ paddingTop: 18, paddingBottom: 18 }}>
            FINALIZE SHIFT
            <div className="text-xs opacity-70 mt-1">Save to backend &amp; lock in totals</div>
          </button>
          <button className="btn btn-secondary" onClick={cancelShift} style={{ paddingTop: 18, paddingBottom: 18 }}>
            CANCEL SHIFT
            <div className="text-xs opacity-70 mt-1">Discard local data</div>
          </button>
        </div>
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
