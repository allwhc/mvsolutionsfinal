// SenseFlow Cloud Functions — Phase 1: test notification only.
// Future phases will add RTDB-triggered event detection (level_empty, etc.)
// and the per-event dispatcher.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onValueWritten } from "firebase-functions/v2/database";
import { initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";

initializeApp();

const db = getFirestore();
const messaging = getMessaging();
const rtdb = getDatabase();

// ────────────────────────────────────────────────────────────────
// Phase 2 — Real event detection + dispatch.
// All event rules default to OFF. Each subscriber turns events on per
// device, picks their own delay, and gets notified independently. Cooldown
// is fixed at 1 hour per (user, device, event) so spam isn't a concern.
// ────────────────────────────────────────────────────────────────

const COOLDOWN_MS = 60 * 60 * 1000;

const DEFAULT_DELAY_SEC = {
  level_empty: 60 * 60,       // 1 hour
  level_full: 0,              // immediate
  device_offline: 30 * 60,    // 30 min
  sensor_error: 0,            // immediate
};

// Resolve effective rule for a subscriber. Missing rule = OFF (no
// notification). Default delays apply when the user enabled the rule but
// hasn't specified a custom delay.
function resolveRule(rules, event) {
  const r = rules?.[event];
  if (!r || r.enabled !== true) return { enabled: false };
  const delaySec = typeof r.delaySec === "number" ? r.delaySec : DEFAULT_DELAY_SEC[event];
  return { enabled: true, delaySec };
}

// Friendly notification body per event type.
function notificationFor(event, deviceName, deviceCode) {
  const name = deviceName || deviceCode;
  switch (event) {
    case "level_empty":
      return { title: `${name} — Tank empty`, body: `Water level has been low for a while. Check or refill.` };
    case "level_full":
      return { title: `${name} — Tank full`, body: `Tank has reached the high threshold.` };
    case "device_offline":
      return { title: `${name} — Offline`, body: `Device has stopped reporting. Check power or WiFi.` };
    case "sensor_error":
      return { title: `${name} — Sensor fault`, body: `Sensor pattern fault detected. Check wiring.` };
    default:
      return { title: name, body: event };
  }
}

// Send to a single uid's tokens. Returns { sent, failed, cleanedInvalid }.
async function sendToUser(uid, title, body, data) {
  const tokensSnap = await db.collection("users").doc(uid).collection("fcmTokens").get();
  if (tokensSnap.empty) return { sent: 0, failed: 0, cleanedInvalid: 0 };
  const tokens = tokensSnap.docs.map((d) => d.id);
  const message = {
    data: { ...data, title, body, sentAt: String(Date.now()) },
    tokens,
  };
  const res = await messaging.sendEachForMulticast(message);
  const invalid = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        invalid.push(tokens[i]);
      }
    }
  });
  await Promise.all(
    invalid.map((t) =>
      db.collection("users").doc(uid).collection("fcmTokens").doc(t).delete()
    )
  );
  return { sent: res.successCount, failed: res.failureCount, cleanedInvalid: invalid.length };
}

// Resolve the subscriber list for a device: the owner + every uid in
// subscriptions/<uid>/devices/<code>. We collectionGroup the subscriptions
// path because that's how the existing app stores subscriptions.
async function collectSubscribers(deviceCode) {
  const uids = new Set();
  // Owner from Firestore device catalog
  const devDoc = await db.collection("devices").doc(deviceCode).get();
  if (devDoc.exists) {
    const ownerUid = devDoc.data().ownerUid;
    if (ownerUid) uids.add(ownerUid);
  }
  // Subscribers — collectionGroup query on "devices" subcollections.
  const subsSnap = await db
    .collectionGroup("devices")
    .where("deviceCode", "==", deviceCode)
    .get();
  subsSnap.forEach((d) => {
    // path is users/<uid>/devices/<code> OR subscriptions/<uid>/devices/<code>
    // We only care about subscriptions/{uid}/devices.
    const parts = d.ref.path.split("/");
    if (parts[0] === "subscriptions" && parts.length === 4) uids.add(parts[1]);
  });
  return [...uids];
}

// Look up a subscriber's rule for the device.
async function readSubscriberRule(uid, deviceCode, event) {
  const subDoc = await db
    .collection("subscriptions")
    .doc(uid)
    .collection("devices")
    .doc(deviceCode)
    .get();
  const rules = subDoc.exists ? subDoc.data().notificationRules : null;
  return resolveRule(rules, event);
}

// Has the user been notified within the cooldown window?
async function inCooldown(uid, deviceCode, event) {
  const ref = db
    .collection("notificationLog")
    .doc(uid)
    .collection("events")
    .doc(`${deviceCode}_${event}`);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const last = snap.data().lastSentAt?.toMillis?.() || 0;
  return Date.now() - last < COOLDOWN_MS;
}

async function markSent(uid, deviceCode, event) {
  await db
    .collection("notificationLog")
    .doc(uid)
    .collection("events")
    .doc(`${deviceCode}_${event}`)
    .set({ lastSentAt: FieldValue.serverTimestamp() }, { merge: true });
}

// Track event state (when the condition first became true) at
// devices/<code>/eventState in Firestore. We don't write firmware-side; the
// dispatcher computes everything here.
async function readEventState(deviceCode) {
  const ref = db.collection("devices").doc(deviceCode);
  const snap = await ref.get();
  return snap.exists ? snap.data().eventState || {} : {};
}

async function writeEventState(deviceCode, patch) {
  await db
    .collection("devices")
    .doc(deviceCode)
    .set({ eventState: patch }, { merge: true });
}

// Dispatch ONE event to all eligible subscribers.
async function dispatchEvent(deviceCode, event) {
  const devDoc = await db.collection("devices").doc(deviceCode).get();
  const deviceName = devDoc.exists ? devDoc.data().deviceName : null;
  const { title, body } = notificationFor(event, deviceName, deviceCode);

  const subscribers = await collectSubscribers(deviceCode);
  const data = { type: "event", event, deviceCode };

  for (const uid of subscribers) {
    const rule = await readSubscriberRule(uid, deviceCode, event);
    if (!rule.enabled) continue;
    if (await inCooldown(uid, deviceCode, event)) continue;
    await sendToUser(uid, title, body, data);
    await markSent(uid, deviceCode, event);
  }
}

// Top-level RTDB trigger for /notify_trigger writes. Detects level_empty /
// level_full / sensor_error and tracks since-when timestamps so each
// subscriber's delay can be honored.
//
// Watches /notify_trigger (NOT /live) so this function only fires for
// devices where the admin set /config/notifyOn=true (the firmware mirror
// path). Free customers' devices never write here → zero invocations.
// See project_notifications_phase2_plan memory for the full architecture.
export const onDeviceLiveWrite = onValueWritten(
  {
    region: "asia-southeast1",
    ref: "/devices/{code}/notify_trigger",
  },
  async (event) => {
    const code = event.params.code;
    const after = event.data.after.val();
    if (!after) return;

    // notify_trigger payload from firmware is the minimal {pct, flags, ts}
    // shape — pct, NOT confirmedPct (which is the field name on /live).
    const pct = after.pct;
    const flags = after.flags || 0;
    if (typeof pct !== "number") return;

    // Resolve thresholds from the device catalog (admin sets defaults; users
    // override in their subscription).
    // For simplicity Phase 2 uses 25%/90% defaults; per-user thresholds are
    // still honored by the existing alert UI and are independent of push.
    const LOW = 25;
    const HIGH = 90;

    const state = await readEventState(code);
    const now = Date.now();
    const patch = {};

    // ── level_empty
    if (pct <= LOW) {
      if (!state.emptySince) {
        patch.emptySince = now;
      }
    } else {
      if (state.emptySince) patch.emptySince = null;
    }

    // ── level_full
    if (pct >= HIGH) {
      if (!state.fullSince) {
        patch.fullSince = now;
      }
    } else {
      if (state.fullSince) patch.fullSince = null;
    }

    // ── sensor_error (flag bit 0)
    const hasError = (flags & 0x01) === 0x01;
    if (hasError) {
      if (!state.errorSince) patch.errorSince = now;
    } else {
      if (state.errorSince) patch.errorSince = null;
    }

    if (Object.keys(patch).length > 0) await writeEventState(code, patch);

    // Merge new + existing state for dispatch checks.
    const s = { ...state, ...patch };

    // Per-subscriber delay logic: we need to know how long each event has
    // been active so the dispatcher can decide whether to send. dispatchEvent
    // looks at the subscriber's delaySec and the eventState start time.

    // Helper: evaluate one event for dispatch.
    async function maybeDispatch(eventKey, since) {
      if (!since) return;
      const elapsed = now - since;
      const subscribers = await collectSubscribers(code);
      const devDoc = await db.collection("devices").doc(code).get();
      const deviceName = devDoc.exists ? devDoc.data().deviceName : null;
      const { title, body } = notificationFor(eventKey, deviceName, code);
      const data = { type: "event", event: eventKey, deviceCode: code };

      for (const uid of subscribers) {
        const rule = await readSubscriberRule(uid, code, eventKey);
        if (!rule.enabled) continue;
        if (elapsed < rule.delaySec * 1000) continue;
        if (await inCooldown(uid, code, eventKey)) continue;
        await sendToUser(uid, title, body, data);
        await markSent(uid, code, eventKey);
      }
    }

    await maybeDispatch("level_empty", s.emptySince);
    await maybeDispatch("level_full", s.fullSince);
    await maybeDispatch("sensor_error", s.errorSince);
  }
);

// Top-level RTDB trigger for /info writes. Detects device_offline by
// watching the `online` flag.
export const onDeviceInfoWrite = onValueWritten(
  {
    region: "asia-southeast1",
    ref: "/devices/{code}/info/online",
  },
  async (event) => {
    const code = event.params.code;
    const online = event.data.after.val();
    const now = Date.now();
    const state = await readEventState(code);
    const patch = {};

    if (online === false) {
      if (!state.offlineSince) patch.offlineSince = now;
    } else if (online === true) {
      if (state.offlineSince) patch.offlineSince = null;
    }

    if (Object.keys(patch).length > 0) await writeEventState(code, patch);

    const since = patch.offlineSince || state.offlineSince;
    if (!since) return;

    const elapsed = now - since;
    const subscribers = await collectSubscribers(code);
    const devDoc = await db.collection("devices").doc(code).get();
    const deviceName = devDoc.exists ? devDoc.data().deviceName : null;
    const { title, body } = notificationFor("device_offline", deviceName, code);
    const data = { type: "event", event: "device_offline", deviceCode: code };

    for (const uid of subscribers) {
      const rule = await readSubscriberRule(uid, code, "device_offline");
      if (!rule.enabled) continue;
      if (elapsed < rule.delaySec * 1000) continue;
      if (await inCooldown(uid, code, "device_offline")) continue;
      await sendToUser(uid, title, body, data);
      await markSent(uid, code, "device_offline");
    }
  }
);

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
