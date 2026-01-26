export function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          // If there's already an updated SW waiting, activate it immediately.
          if (reg.waiting) {
            try {
              reg.waiting.postMessage('SKIP_WAITING');
            } catch {}
          }

          // When a new SW is found, ask it to activate as soon as it's installed.
          reg.addEventListener('updatefound', () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', () => {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                try {
                  sw.postMessage('SKIP_WAITING');
                } catch {}
              }
            });
          });
        })
        .catch(console.error);

      // Allow the service worker to request in-app navigation on notification click
      navigator.serviceWorker.addEventListener('message', (event: any) => {
        try {
          if (event?.data?.type === 'navigate' && event?.data?.url) {
            window.location.href = String(event.data.url);
          }
        } catch {}
      });
    });
  }
}
