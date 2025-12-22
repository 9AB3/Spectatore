import { useEffect, useState } from 'react';

export default function useToast() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (msg) {
      const t = setTimeout(() => setMsg(null), 2000);
      return () => clearTimeout(t);
    }
  }, [msg]);

  const Toast = () =>
    msg ? (
      <div className="fixed inset-0 flex items-center justify-center z-[9999] pointer-events-none">
        <div className="bg-black text-white px-4 py-2 rounded-lg shadow-lg pointer-events-auto">
          {msg}
        </div>
      </div>
    ) : null;

  return { setMsg, Toast };
}
