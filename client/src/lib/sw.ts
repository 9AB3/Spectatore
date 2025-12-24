export function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(console.error);

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
