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
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-black text-white px-4 py-2 rounded-lg">
        {msg}
      </div>
    ) : null;
  return { setMsg, Toast };
}
