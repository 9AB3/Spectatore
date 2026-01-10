import { useEffect, useState } from "react";

/**
 * Startup splash: Industrial Premium "SPECTATORE" glow sweep.
 * Shows once per browser session (sessionStorage).
 */
export default function StartupSplash() {
  const [show, setShow] = useState<boolean>(() => {
    try {
      return !sessionStorage.getItem("spectatore_splash_shown");
    } catch {
      return true;
    }
  });

  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!show) return;

    try {
      sessionStorage.setItem("spectatore_splash_shown", "1");
    } catch {
      // ignore
    }

    // Longer, letter-by-letter animation + linger.
    // (Letters start after ~500ms via CSS delay.)
    const t1 = window.setTimeout(() => setLeaving(true), 4600);
    const t2 = window.setTimeout(() => setShow(false), 5200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [show]);

  if (!show) return null;

  return (
    <div className={"startup-splash" + (leaving ? " startup-splash--leave" : "")}>
      <div className="startup-splash__inner">
        <div className="startup-splash__logo">
          <img src="/logo.png" alt="Spectatore" />
        </div>
        <div className="startup-splash__wordmark" aria-label="Spectatore">
          {"SPECTATORE".split("").map((ch, i) => (
            <span key={i} className="startup-splash__letter" style={{ ["--i" as any]: i }}>
              {ch}
            </span>
          ))}
        </div>
        <div className="startup-splash__tag">Your metres. Your metrics.</div>
      </div>
    </div>
  );
}
