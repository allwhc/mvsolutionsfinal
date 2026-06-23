// Foreground FCM helpers — token registration + in-app message handling.
// The browser's own Notification API handles the UI when the tab is in
// background (service worker takes over). When the tab is foreground, we
// surface incoming messages via onMessage so the React app can react.

import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";
import {
  doc, setDoc, deleteDoc, serverTimestamp,
  collection, getDocs, writeBatch,
} from "firebase/firestore";
import app, { db } from "./config";

// VAPID public key. This is the PUBLIC half of the keypair and is meant to
// be embedded in frontend code — it's how the browser identifies our app
// to the push service. The matching PRIVATE key stays inside Firebase.
// (Allow VITE_FCM_VAPID_KEY env var to override for dev/testing.)
const VAPID_KEY =
  import.meta.env.VITE_FCM_VAPID_KEY ||
  "BPeOoplxsVFdIVuqu7dcfM2MaT35aZeqIDZsM_Xj12H_QeGh-69-yu-qqpbY4fbOGWKFMxuA0lOlmBEgM2bOxlw";

let messagingInstance = null;
async function getMessagingIfSupported() {
  if (messagingInstance) return messagingInstance;
  if (!(await isSupported())) return null;
  messagingInstance = getMessaging(app);
  return messagingInstance;
}

// Returns:
//   { status: "granted", token } — token saved to Firestore
//   { status: "denied" }         — user said no
//   { status: "unsupported" }    — browser can't do web push
//   { status: "error", error }   — something else went wrong
export async function requestAndSaveFcmToken(uid) {
  if (!VAPID_KEY) {
    return { status: "error", error: "VAPID key missing (set VITE_FCM_VAPID_KEY)" };
  }
  const messaging = await getMessagingIfSupported();
  if (!messaging) return { status: "unsupported" };

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { status: "denied" };

  // Register the service worker FCM expects at /firebase-messaging-sw.js.
  // updateViaCache:"none" tells the browser to ALWAYS fetch the SW file
  // fresh from the server (not from HTTP cache) so changes are detected
  // immediately. Combined with skipWaiting/clients.claim in the SW itself,
  // a new SW activates without users having to close/reopen tabs.
  const swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
    updateViaCache: "none",
  });
  await swReg.update();   // explicitly check for new version on every call
  await navigator.serviceWorker.ready;   // resolves once any SW is active for this scope
  if (!swReg.active) {
    // Belt-and-braces: poll until this specific registration has an active worker.
    for (let i = 0; i < 50 && !swReg.active; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const token = await getToken(messaging, {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: swReg,
  });

  if (!token) return { status: "denied" };

  // Dedupe: remove any older tokens registered from the same browser/device.
  // We identify "same device" by an exact userAgent match (truncated to 200
  // chars, same as what we store). Different physical devices have different
  // userAgents, so this keeps multi-device users intact while killing the
  // duplicate-on-same-browser case (different tab sessions / token rotation
  // create new tokens without expiring the old).
  const userAgent = navigator.userAgent.slice(0, 200);
  try {
    const snap = await getDocs(collection(db, "users", uid, "fcmTokens"));
    const batch = writeBatch(db);
    let deletedAny = false;
    snap.forEach((d) => {
      if (d.id !== token && d.data().userAgent === userAgent) {
        batch.delete(d.ref);
        deletedAny = true;
      }
    });
    if (deletedAny) await batch.commit();
  } catch (_) {
    // Non-fatal — proceed even if dedupe read fails (offline, rules etc.).
  }

  await setDoc(
    doc(db, "users", uid, "fcmTokens", token),
    {
      platform: "web",
      userAgent,
      addedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return { status: "granted", token };
}

// Remove the current device's token from Firestore (e.g. user clicked "Disable").
export async function removeFcmToken(uid) {
  const messaging = await getMessagingIfSupported();
  if (!messaging) return;
  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (token) {
      await deleteDoc(doc(db, "users", uid, "fcmTokens", token));
    }
  } catch (_) {
    /* ignore */
  }
}

// Subscribe to foreground messages (tab is open + visible).
// Returns an unsubscribe function.
export async function onForegroundMessage(cb) {
  const messaging = await getMessagingIfSupported();
  if (!messaging) return () => {};
  return onMessage(messaging, cb);
}

// Quick helper to check the current permission state without prompting.
export function currentPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;   // "default" | "granted" | "denied"
}
