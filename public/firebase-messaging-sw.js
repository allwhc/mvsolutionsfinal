// Service worker for Firebase Cloud Messaging background notifications.
// Must live at /firebase-messaging-sw.js — browser convention enforced by FCM.
// Uses compat SDKs (only ones available inside a service worker context).

importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4",
  authDomain: "senseflow-5a9bb.firebaseapp.com",
  projectId: "senseflow-5a9bb",
  storageBucket: "senseflow-5a9bb.firebasestorage.app",
  messagingSenderId: "816999395292",
  appId: "1:816999395292:web:62597895d9479ca40ea919",
});

const messaging = firebase.messaging();

// Background notifications: override the SDK's auto-display so we can use
// our own icon + badge. Without this override the SDK uses Chrome's default
// generic icon when the `notification.image` field is absent.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "SenseFlow";
  const opts  = {
    body:  payload.notification?.body || "",
    icon:  "/android-chrome-192x192.png",
    badge: "/favicon-32x32.png",
    data:  payload.data || {},
  };
  self.registration.showNotification(title, opts);
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
