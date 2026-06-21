// Service worker for Firebase Cloud Messaging background notifications.
// Must live at /firebase-messaging-sw.js — browser convention enforced by FCM.
// Uses compat SDKs (only ones available inside a service worker context).
//
// SW_VERSION marker — bump the string when you change behavior and the
// browser will install the new version on next page load. Bytes-level diff
// is what triggers an update, so this comment alone is enough.
// SW_VERSION: 2026-06-21-001

importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

// Part B — take over IMMEDIATELY on install, no manual unregister needed.
// Without these, a new SW sits in "waiting" state until every tab is closed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

firebase.initializeApp({
  apiKey: "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4",
  authDomain: "senseflow-5a9bb.firebaseapp.com",
  projectId: "senseflow-5a9bb",
  storageBucket: "senseflow-5a9bb.firebasestorage.app",
  messagingSenderId: "816999395292",
  appId: "1:816999395292:web:62597895d9479ca40ea919",
});

const messaging = firebase.messaging();

// Background notifications. Cloud Function sends data-only messages so the
// FCM SDK does NOT auto-display — we draw the notification ourselves with
// our branding. (Auto-display + manual display would otherwise produce two
// popups: one generic, one branded.)
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || payload.notification?.title || "SenseFlow";
  const body  = d.body  || payload.notification?.body  || "";
  self.registration.showNotification(title, {
    body,
    icon:  "/android-chrome-192x192.png",
    badge: "/favicon-32x32.png",
    data:  d,
  });
});

// Click handler: focuses the dashboard tab if open, else opens it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if (win.url.includes("/dashboard") && "focus" in win) return win.focus();
      }
      if (clients.openWindow) return clients.openWindow("/dashboard");
    })
  );
});
