export function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');

      // If an updated SW is found, force-activate it so fixes (e.g., /api bypass)
      // take effect without needing the user to manually unregister.
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            try {
              nw.postMessage({ type: 'SKIP_WAITING' });
            } catch {}
          }
        });
      });

      // Allow the service worker to request in-app navigation on notification click
      navigator.serviceWorker.addEventListener('message', (event: any) => {
        try {
          if (event?.data?.type === 'navigate' && event?.data?.url) {
            window.location.href = String(event.data.url);
          }
        } catch {}
      });
    } catch (e) {
      console.error(e);
    }
  });
}
