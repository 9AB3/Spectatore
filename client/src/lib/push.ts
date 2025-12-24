import { api } from './api';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function isPushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!(await isPushSupported())) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return await reg.pushManager.getSubscription();
}

export async function enablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!(await isPushSupported())) return { ok: false, error: 'Push not supported on this device/browser.' };

    const publicKey = (import.meta.env.VITE_VAPID_PUBLIC_KEY || '').trim();
    if (!publicKey) {
      return { ok: false, error: 'Missing VITE_VAPID_PUBLIC_KEY in the frontend environment.' };
    }

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: 'Notification permission was not granted.' };

    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { ok: false, error: 'Service worker not registered yet.' };

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));

    await api('/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Failed to enable push notifications.' };
  }
}

export async function disablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!(await isPushSupported())) return { ok: false, error: 'Push not supported on this device/browser.' };

    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { ok: true };

    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try {
        await api('/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch {
        // ignore
      }
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Failed to disable push notifications.' };
  }
}
