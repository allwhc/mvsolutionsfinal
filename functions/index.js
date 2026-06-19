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
  const message = {
    notification: {
      title: "SenseFlow Test",
      body: "Notifications are working — you'll get tank/valve/pump alerts here.",
    },
    data: {
      type: "test",
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
