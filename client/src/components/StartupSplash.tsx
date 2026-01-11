import { useEffect, useRef, useState } from "react";

/**
 * Startup splash using animated logo video.
 * - Waits until the video finishes (ended event).
 * - Auto fades out at the end.
 * - Shows once per browser session (sessionStorage).
 */
export default function StartupSplash() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [show, setShow] = useState<boolean>(() => {
    try {
      return !sessionStorage.getItem("spectatore_splash_shown");
    } catch {
      return true;
    }
  });

  const [leaving, setLeaving] = useState(false);

  const finish = () => {
    // Prevent double-firing.
    setLeaving(true);

    // Fade duration must match CSS transition duration below.
    window.setTimeout(() => {
      try {
        sessionStorage.setItem("spectatore_splash_shown", "1");
      } catch {}
      setShow(false);
    }, 450);
  };

  // If the video can't autoplay or never fires "ended" (rare), fall back to duration-based timer.
  useEffect(() => {
    if (!show) return;

    const v = videoRef.current;
    if (!v) return;

    let fallbackTimer: number | undefined;

    const armFallback = () => {
      // Prefer real duration if available; otherwise use a sane default.
      const ms = Number.isFinite(v.duration) && v.duration > 0 ? Math.ceil(v.duration * 1000) : 3500;
      fallbackTimer = window.setTimeout(() => {
        finish();
      }, ms + 50);
    };

    const onEnded = () => finish();
    const onLoaded = () => armFallback();

    v.addEventListener("ended", onEnded);
    v.addEventListener("loadedmetadata", onLoaded);

    // In case metadata is already available
    if (v.readyState >= 1) armFallback();

    return () => {
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("loadedmetadata", onLoaded);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  if (!show) return null;

  return (
    <div
      className={"startup-video-splash" + (leaving ? " leaving" : "")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "black",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <style>
        {`
          .startup-video-splash {
            opacity: 1;
            transition: opacity 450ms ease-out;
          }
          .startup-video-splash.leaving {
            opacity: 0;
          }
        `}
      </style>

      <video
        ref={videoRef}
        src="/splash.mp4"
        autoPlay
        muted
        playsInline
        onEnded={() => finish()}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}
