import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { getDB } from '../lib/idb';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';

export default function Shift() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [loaded, setLoaded] = useState(false);

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
    if (!confirm('Are you sure you want to cancel your shift?')) return;

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
      setTimeout(() => nav('/Main'), 500);
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
    </div>
  );
}
