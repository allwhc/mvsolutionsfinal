import { useEffect } from "react";
import { onForegroundMessage } from "../firebase/messaging";

// Mount once near the app root. When the tab is foreground/visible, FCM
// does NOT auto-display the notification (Firebase deliberately leaves
// foreground UX to the app). We bridge it back to the OS notification
// system via the service worker so users see the popup regardless of
// whether the tab is focused.
export default function NotificationListener() {
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      unsub = await onForegroundMessage(async (payload) => {
        const data  = payload.data || {};
        const title = data.title || payload.notification?.title || "SenseFlow";
        const body  = data.body  || payload.notification?.body  || "";
        try {
          const reg = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
          if (reg) {
            await reg.showNotification(title, {
              body,
              data,
              icon: "/android-chrome-192x192.png",   // crisp on hi-DPI displays
              badge: "/favicon-32x32.png",           // small icon shown by Chrome on Android
            });
          } else if (Notification.permission === "granted") {
            // Fallback if SW registration is missing — direct Notification API.
            new Notification(title, { body });
          }
        } catch (e) {
          console.warn("[NotificationListener] show failed:", e);
        }
      });
    })();
    return () => unsub();
  }, []);
  return null;
}
