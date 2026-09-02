/**
 * Web push subscription.
 *
 * Deliberately secondary to the calendar feed. On iOS, push only works when the
 * app has been added to the Home Screen (iOS 16.4+), and Apple throttles
 * background delivery — so this is for catching disruptions, not for waking you
 * up. The UI says so rather than implying a guarantee.
 */

// Set these after deploying the worker (see worker/README).
export const PUSH_ENDPOINT = 'https://stuyshuttle-push.rm6886.workers.dev';
export const VAPID_PUBLIC_KEY = 'BCtYjs7cZpvO-1ChP0jvpbBbiFQZXAsGIAJPLdHvH0P9icUT9QiYeY3tKJWJV_BkE88PpBm0WoNzC1xGkaqDXsQ';  // public half of the worker's VAPID keypair (safe to publish)

export function pushConfigured() {
  return Boolean(PUSH_ENDPOINT && VAPID_PUBLIC_KEY);
}

/** True only where a subscription can actually succeed. */
export function pushSupported() {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** iOS requires Home Screen installation before push will work at all. */
export function isIosNeedingInstall() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  return ios && !standalone;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function subscribe(prefs) {
  if (!pushConfigured()) throw new Error('Push is not configured yet.');
  if (!pushSupported()) throw new Error('This browser cannot receive push.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission denied.');

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));

  const res = await fetch(`${PUSH_ENDPOINT}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), prefs }),
  });
  if (!res.ok) throw new Error('Could not register with the push service.');
  return sub;
}

export async function unsubscribe() {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  if (pushConfigured()) {
    await fetch(`${PUSH_ENDPOINT}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  }
}
