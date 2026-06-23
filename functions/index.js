// SenseFlow Cloud Functions — Phase 1: test notification only.
// Future phases will add RTDB-triggered event detection (level_empty, etc.)
// and the per-event dispatcher.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getFirestore } from "firebase-admin/firestore";

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

// Callable: send a test FCM notification to the caller's own tokens.
// Used during Phase 1 to verify the entire pipeline works end-to-end
// (token registration → save in Firestore → Cloud Function send → browser receives).
export const sendTestNotification = onCall(
  {
    region: "asia-southeast1",
    // Allow all origins. Safe for callables because auth is enforced inside
    // the handler (req.auth must be present). Tighten later if needed.
    cors: true,
  },
  async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const tokensSnap = await db.collection("users").doc(uid).collection("fcmTokens").get();
  if (tokensSnap.empty) {
    throw new HttpsError("failed-precondition", "No FCM tokens registered for this user");
  }

  const tokens = tokensSnap.docs.map((d) => d.id);
  // Send DATA-ONLY message (no `notification` field). The browser SDK only
  // auto-displays when `notification` is present, which would duplicate the
  // popup our service worker / foreground listener already shows with the
  // correct branding. Keeping the title/body inside `data` lets our handlers
  // render the notification themselves with our logo.
  const message = {
    data: {
      type: "test",
      title: "SenseFlow Test",
      body: "Notifications are working — you'll get tank/valve/pump alerts here.",
      sentAt: String(Date.now()),
    },
    tokens,
  };

  const res = await messaging.sendEachForMulticast(message);

  // Clean up tokens that the FCM service has marked as invalid/unregistered
  // — happens when the user clears site data, uninstalls, or browser blacklists.
  const invalidTokens = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        invalidTokens.push(tokens[i]);
      }
    }
  });
  await Promise.all(
    invalidTokens.map((t) =>
      db.collection("users").doc(uid).collection("fcmTokens").doc(t).delete()
    )
  );

  return {
    sent: res.successCount,
    failed: res.failureCount,
    cleanedInvalidTokens: invalidTokens.length,
  };
});

// Admin-only: send a test FCM notification to a SPECIFIC user's tokens.
// Used by the /admin/notifications page so a superadmin can verify a
// customer's setup without asking them to click a button themselves.
export const adminSendTestToUser = onCall(
  {
    region: "asia-southeast1",
    cors: true,
  },
  async (req) => {
    const callerUid = req.auth?.uid;
    if (!callerUid) throw new HttpsError("unauthenticated", "Login required");

    // Caller must be superadmin
    const callerDoc = await db.collection("users").doc(callerUid).get();
    if (!callerDoc.exists || callerDoc.data().role !== "superadmin") {
      throw new HttpsError("permission-denied", "Superadmin only");
    }

    const targetUid = req.data?.uid;
    if (!targetUid) throw new HttpsError("invalid-argument", "uid required");

    const tokensSnap = await db.collection("users").doc(targetUid).collection("fcmTokens").get();
    if (tokensSnap.empty) {
      throw new HttpsError("failed-precondition", "Target user has no FCM tokens registered");
    }

    const tokens = tokensSnap.docs.map((d) => d.id);
    const message = {
      data: {
        type: "admin-test",
        title: "SenseFlow — Admin Test",
        body: "An administrator sent you a test notification. If you can see this, notifications are working on this device.",
        sentAt: String(Date.now()),
      },
      tokens,
    };

    const res = await messaging.sendEachForMulticast(message);

    // Same auto-clean as sendTestNotification
    const invalidTokens = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || "";
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          invalidTokens.push(tokens[i]);
        }
      }
    });
    await Promise.all(
      invalidTokens.map((t) =>
        db.collection("users").doc(targetUid).collection("fcmTokens").doc(t).delete()
      )
    );

    return {
      sent: res.successCount,
      failed: res.failureCount,
      cleanedInvalidTokens: invalidTokens.length,
    };
  }
);
