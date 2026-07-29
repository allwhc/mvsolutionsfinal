import {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, serverTimestamp, writeBatch,
} from "firebase/firestore";
import { db } from "./config";

// ── Users ──
export async function createUserDoc(uid, data) {
  await setDoc(doc(db, "users", uid), {
    ...data,
    createdAt: serverTimestamp(),
    lastLogin: serverTimestamp(),
  });
}

export async function getUserDoc(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

export async function updateUserDoc(uid, data) {
  await updateDoc(doc(db, "users", uid), data);
}

export async function getAllUsers() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

// ── Orgs ──
export async function createOrg(orgId, data) {
  await setDoc(doc(db, "orgs", orgId), {
    ...data,
    memberCount: 1,
    status: "active",
    createdAt: serverTimestamp(),
  });
}

export async function getOrg(orgId) {
  const snap = await getDoc(doc(db, "orgs", orgId));
  return snap.exists() ? { orgId, ...snap.data() } : null;
}

export async function getAllOrgs() {
  const snap = await getDocs(collection(db, "orgs"));
  return snap.docs.map((d) => ({ orgId: d.id, ...d.data() }));
}

export async function updateOrg(orgId, data) {
  await updateDoc(doc(db, "orgs", orgId), data);
}

// Superadmin: delete an org container in full. Wipes:
//   - orgs/<orgId> itself
//   - orgMembers/<orgId>/members/*   (all member entries)
//   - orgGroups/<orgId>/groups/*     (all groups)
//   - Each member's users/<uid> doc: role→individual, orgId/orgName→null
//     (users stay, they just become individual accounts again)
//
// Member auth accounts + device subscriptions are NOT touched. Admin can
// separately delete individual users if needed. This is atomic-ish: if
// something fails partway, admin can retry safely because each step is
// idempotent.
export async function deleteOrg(orgId) {
  // 1. Snapshot member uids so we can update their user docs after wipe.
  const membersSnap = await getDocs(collection(db, "orgMembers", orgId, "members"));
  const memberUids = membersSnap.docs.map((d) => d.id);

  // 2. Delete every member entry
  for (const m of membersSnap.docs) {
    await deleteDoc(m.ref);
  }

  // 3. Delete every group
  const groupsSnap = await getDocs(collection(db, "orgGroups", orgId, "groups"));
  for (const g of groupsSnap.docs) {
    await deleteDoc(g.ref);
  }

  // 3b. Delete every device attachment
  const orgDevSnap = await getDocs(collection(db, "orgDevices", orgId, "devices"));
  for (const d of orgDevSnap.docs) {
    await deleteDoc(d.ref);
  }

  // 4. Downgrade each member's user doc to individual
  for (const uid of memberUids) {
    try {
      await updateDoc(doc(db, "users", uid), {
        role: "individual",
        orgId: null,
        orgName: null,
      });
    } catch { /* user doc may already be gone — non-fatal */ }
  }

  // 5. Finally the org doc itself
  await deleteDoc(doc(db, "orgs", orgId));
}

// ── Org Members ──
// Two-status model:
//   "pending" → self-joined via invite, waiting for orgAdmin approval.
//               user doc gets pendingOrgId (NOT orgId) so isOrgMember()
//               rule fails — they can't see any org data yet.
//   "active"  → orgAdmin approved (or admin created them directly).
//               user doc gets orgId + role "orgMember" — dashboard works.
// displayName + email are denormalised onto the membership record so
// orgAdmin doesn't need to read each member's /users/<uid> doc (which
// the users rule blocks — only the user themselves or superadmin can).
export async function addOrgMember(orgId, uid, data) {
  await setDoc(doc(db, "orgMembers", orgId, "members", uid), {
    ...data,
    addedAt: serverTimestamp(),
  });
}

export async function getOrgMembers(orgId) {
  const snap = await getDocs(collection(db, "orgMembers", orgId, "members"));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

// Approve a pending self-join. OrgAdmin can only flip the membership
// record itself — Firestore rules block writes to another user's
// /users/{uid} doc, so we can't touch orgId/role from here. Instead
// the approved user self-promotes on next AuthContext refresh (see
// promoteSelfIfApproved in AuthContext.jsx): they read their own
// membership record, notice status=active, then write their own
// user doc with orgId + role=orgMember. Self-writes are permitted.
export async function approveOrgMember(orgId, uid, adminUid) {
  await updateDoc(doc(db, "orgMembers", orgId, "members", uid), {
    status: "active",
    approvedBy: adminUid,
    approvedAt: serverTimestamp(),
  });
  // Bump the seat count now that this member is actually taking a
  // seat. Pending members don't count toward the 10-cap (per Vishal's
  // choice — otherwise admin could get stuck at 10 with unapproved
  // joiners hogging seats).
  try {
    const orgSnap = await getDoc(doc(db, "orgs", orgId));
    if (orgSnap.exists()) {
      const cur = orgSnap.data().memberCount || 0;
      await updateDoc(doc(db, "orgs", orgId), { memberCount: cur + 1 });
    }
  } catch (e) {
    console.warn("approveOrgMember: memberCount bump failed:", e);
  }
}

// Reject a pending self-join. OrgAdmin can only delete the membership
// record — they can't write to the target user's /users/{uid} doc
// (rules block cross-user writes). The rejected user self-heals on
// next AuthContext refresh: promoteSelfIfApproved reads their own
// membership record, sees it's missing, and clears pendingOrgId
// from their own user doc.
export async function rejectOrgMember(orgId, uid) {
  await deleteDoc(doc(db, "orgMembers", orgId, "members", uid));
}

// Revoke an approved member. Drops the membership record and
// decrements memberCount if the member was actually active. The
// removed user's dashboard breaks the moment they lose their
// membership — but rules block us from touching their user doc.
// They self-heal on next AuthContext load: promoteSelfIfApproved
// notices they have orgId set but no membership record for that org
// and clears the stale orgId, dropping them back to individual mode.
export async function removeOrgMember(orgId, uid) {
  let wasActive = false;
  try {
    const m = await getDoc(doc(db, "orgMembers", orgId, "members", uid));
    if (m.exists()) wasActive = (m.data().status || "active") === "active";
  } catch { /* fall through — default to not decrementing */ }

  await deleteDoc(doc(db, "orgMembers", orgId, "members", uid));
  if (wasActive) {
    try {
      const orgSnap = await getDoc(doc(db, "orgs", orgId));
      if (orgSnap.exists()) {
        const cur = orgSnap.data().memberCount || 0;
        if (cur > 0) await updateDoc(doc(db, "orgs", orgId), { memberCount: cur - 1 });
      }
    } catch (e) {
      console.warn("removeOrgMember: memberCount decrement failed:", e);
    }
  }
}

// ── Org Groups ──
export async function createOrgGroup(orgId, groupId, data) {
  await setDoc(doc(db, "orgGroups", orgId, "groups", groupId), {
    ...data,
    createdAt: serverTimestamp(),
  });
}

export async function getOrgGroups(orgId) {
  const snap = await getDocs(collection(db, "orgGroups", orgId, "groups"));
  return snap.docs.map((d) => ({ groupId: d.id, ...d.data() }));
}

export async function updateOrgGroup(orgId, groupId, data) {
  await updateDoc(doc(db, "orgGroups", orgId, "groups", groupId), data);
}

export async function deleteOrgGroup(orgId, groupId) {
  await deleteDoc(doc(db, "orgGroups", orgId, "groups", groupId));
}

// ── Org Devices — the shared device list for an org ─────────────────
// Simplistic model: org owns devices, every member sees every device
// automatically, only orgAdmin can add/remove. Replaces per-user
// subscriptions for accounts that belong to an org.
export async function getOrgDevices(orgId) {
  const snap = await getDocs(collection(db, "orgDevices", orgId, "devices"));
  return snap.docs.map((d) => ({ deviceCode: d.id, ...d.data() }));
}

export async function addDeviceToOrg(orgId, deviceCode, deviceName, addedByUid) {
  await setDoc(doc(db, "orgDevices", orgId, "devices", deviceCode), {
    deviceName: deviceName || deviceCode,
    addedAt: serverTimestamp(),
    addedBy: addedByUid,
  });
}

export async function removeDeviceFromOrg(orgId, deviceCode) {
  await deleteDoc(doc(db, "orgDevices", orgId, "devices", deviceCode));
}

export async function isDeviceInOrg(orgId, deviceCode) {
  const snap = await getDoc(doc(db, "orgDevices", orgId, "devices", deviceCode));
  return snap.exists();
}

// ── Device Catalog ──
export async function registerDevice(deviceCode, data) {
  await setDoc(doc(db, "deviceCatalog", deviceCode), {
    ...data,
    subscriberCount: 0,
    createdAt: serverTimestamp(),
  });
}

export async function getDevice(deviceCode) {
  const snap = await getDoc(doc(db, "deviceCatalog", deviceCode));
  return snap.exists() ? { deviceCode, ...snap.data() } : null;
}

export async function getAllDevices() {
  const snap = await getDocs(collection(db, "deviceCatalog"));
  return snap.docs.map((d) => ({ deviceCode: d.id, ...d.data() }));
}

export async function updateDevice(deviceCode, data) {
  await updateDoc(doc(db, "deviceCatalog", deviceCode), data);
}

export async function deleteDeviceFromCatalog(deviceCode) {
  await deleteDoc(doc(db, "deviceCatalog", deviceCode));
}

// ── Pending Devices ──
export async function getPendingDevices() {
  const snap = await getDocs(collection(db, "pendingDevices"));
  return snap.docs.map((d) => ({ deviceCode: d.id, ...d.data() }));
}

export async function approvePendingDevice(deviceCode, pendingData, extraData = {}) {
  // pendingData comes from RTDB (passed by caller), not Firestore
  const deviceData = { ...pendingData, ...extraData };
  await registerDevice(deviceCode, deviceData);
  // Delete from RTDB pendingDevices
  const { ref, remove } = await import("firebase/database");
  const { rtdb } = await import("./config");
  await remove(ref(rtdb, "pendingDevices/" + deviceCode));
  return deviceData;
}

// ── Plans ──
export async function getPlan(planId) {
  const snap = await getDoc(doc(db, "plans", planId));
  return snap.exists() ? { planId, ...snap.data() } : null;
}

export async function getAllPlans() {
  const snap = await getDocs(collection(db, "plans"));
  return snap.docs.map((d) => ({ planId: d.id, ...d.data() }));
}

export async function createPlan(planId, data) {
  await setDoc(doc(db, "plans", planId), data);
}

export async function updatePlan(planId, data) {
  await updateDoc(doc(db, "plans", planId), data);
}

// ── Subscriptions ──
// Subscribe a user to a device.
//
// isSuperAdmin: pass true from the caller when the subscribing user is
// a SenseFlow superadmin. In that case we FORCE isOwner=false regardless
// of subscriber order — superadmin is treated as a permanent observer
// on every device (MV Solutions doesn't own the tanks customers bought).
// Their subscription record is written for dashboard visibility only,
// and deviceCatalog.ownerUid is never set to a superadmin's uid.
export async function subscribeToDevice(uid, deviceCode, deviceName, isOwner = false, isSuperAdmin = false) {
  // Superadmin can never own — enforced here so no caller can slip
  // isOwner=true through by accident (e.g. "first subscriber" logic
  // in Subscribe.jsx that doesn't know about the role).
  if (isSuperAdmin) isOwner = false;

  const batch = writeBatch(db);

  batch.set(doc(db, "subscriptions", uid, "devices", deviceCode), {
    subscribedAt: serverTimestamp(),
    deviceName: deviceName || deviceCode,
    isOwner,
  });

  batch.set(doc(db, "deviceSubscribers", deviceCode, "subscribers", uid), {
    subscribedAt: serverTimestamp(),
    uid,
    isOwner,
  });

  // If owner, update catalog with ownership info
  if (isOwner) {
    batch.update(doc(db, "deviceCatalog", deviceCode), {
      ownerUid: uid,
      subscriberCount: 1,
    });
  } else {
    // Increment subscriber count
    const device = await getDevice(deviceCode);
    if (device) {
      batch.update(doc(db, "deviceCatalog", deviceCode), {
        subscriberCount: (device.subscriberCount || 0) + 1,
      });
    }
  }

  await batch.commit();
}

// One-shot housekeeping: strip accidental superadmin ownership. Runs
// on superadmin login (see AuthContext). Cheap when nothing needs
// fixing — a single indexed query on deviceCatalog.ownerUid.
//
// Cleans up two artefacts:
//   1. deviceCatalog docs where ownerUid == this superadmin's uid
//      → set ownerUid = null (device becomes ownerless; next real
//        customer to subscribe becomes owner naturally, or admin
//        assigns via the Assign Owner tool)
//   2. subscriptions/<superadminUid>/devices/* with isOwner=true
//      → flip isOwner=false so future unsubscribe paths don't try
//        to run the ownership-transfer logic
//   3. deviceSubscribers/<code>/subscribers/<superadminUid>.isOwner
//      → same, keep the mirror consistent
//
// Silent — logs to console on any per-doc failure but never throws
// out of the function. Best-effort so a partial cleanup still improves
// state.
export async function cleanupSuperadminOwnership(superadminUid) {
  let cleaned = 0;
  try {
    // 1. Catalog docs the superadmin owns.
    const q = query(
      collection(db, "deviceCatalog"),
      where("ownerUid", "==", superadminUid),
    );
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      try {
        await updateDoc(doc(db, "deviceCatalog", d.id), { ownerUid: null });
        cleaned++;
      } catch (e) {
        console.warn(`cleanupSuperadminOwnership: catalog ${d.id} failed:`, e);
      }
    }
  } catch (e) {
    console.warn("cleanupSuperadminOwnership: catalog query failed:", e);
  }

  // 2. Superadmin's own subscription records — clear isOwner flags.
  try {
    const subSnap = await getDocs(collection(db, "subscriptions", superadminUid, "devices"));
    for (const s of subSnap.docs) {
      if (s.data().isOwner) {
        try {
          await updateDoc(doc(db, "subscriptions", superadminUid, "devices", s.id), { isOwner: false });
          // Also fix the mirror if it exists.
          await updateDoc(doc(db, "deviceSubscribers", s.id, "subscribers", superadminUid), { isOwner: false })
            .catch(() => { /* mirror may not exist for legacy rows */ });
        } catch (e) {
          console.warn(`cleanupSuperadminOwnership: sub ${s.id} failed:`, e);
        }
      }
    }
  } catch (e) {
    console.warn("cleanupSuperadminOwnership: subs scan failed:", e);
  }
  return cleaned;
}

// Admin tool: reassign a device's ownerUid. Used when a device is
// stuck ownerless (e.g. after superadmin cleanup, or the original
// owner deleted their account). Superadmin-only from the UI side;
// Firestore rules already allow any authed update to deviceCatalog.
//
// Pass newOwnerUid=null to explicitly clear ownership.
// Also flips isOwner on the target user's subscription record + mirror
// so the "Owner" badge appears on their side without needing them to
// re-subscribe. If they don't have a subscription record yet, we skip
// those writes silently — the catalog.ownerUid alone is enough for
// isEffectiveOwner in the UI to grant them owner rights.
export async function assignDeviceOwner(deviceCode, newOwnerUid) {
  // Read the previous owner so we can strip their isOwner flag too.
  let prevOwnerUid = null;
  try {
    const snap = await getDoc(doc(db, "deviceCatalog", deviceCode));
    if (snap.exists()) prevOwnerUid = snap.data().ownerUid || null;
  } catch { /* ignore */ }

  await updateDoc(doc(db, "deviceCatalog", deviceCode), { ownerUid: newOwnerUid || null });

  // Strip isOwner from previous owner's subscription records.
  if (prevOwnerUid && prevOwnerUid !== newOwnerUid) {
    try { await updateDoc(doc(db, "subscriptions", prevOwnerUid, "devices", deviceCode), { isOwner: false }); }
    catch { /* record may not exist */ }
    try { await updateDoc(doc(db, "deviceSubscribers", deviceCode, "subscribers", prevOwnerUid), { isOwner: false }); }
    catch { /* mirror may not exist */ }
  }

  // Flip isOwner on the new owner's subscription records.
  if (newOwnerUid) {
    try { await updateDoc(doc(db, "subscriptions", newOwnerUid, "devices", deviceCode), { isOwner: true }); }
    catch { /* they might not be subscribed yet — that's OK */ }
    try { await updateDoc(doc(db, "deviceSubscribers", deviceCode, "subscribers", newOwnerUid), { isOwner: true }); }
    catch { /* mirror may not exist */ }
  }
}

export async function unsubscribeFromDevice(uid, deviceCode) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "subscriptions", uid, "devices", deviceCode));
  batch.delete(doc(db, "deviceSubscribers", deviceCode, "subscribers", uid));

  // Check if this user was the owner
  const subSnap = await getDoc(doc(db, "subscriptions", uid, "devices", deviceCode));
  const wasOwner = subSnap.exists() && subSnap.data().isOwner;

  await batch.commit();

  // Transfer ownership if owner left
  if (wasOwner) {
    const remaining = await getDeviceSubscribers(deviceCode);
    if (remaining.length > 0) {
      // Oldest subscriber becomes new owner
      const sorted = remaining.sort((a, b) => (a.subscribedAt?.seconds || 0) - (b.subscribedAt?.seconds || 0));
      const newOwner = sorted[0];
      await updateDoc(doc(db, "subscriptions", newOwner.uid, "devices", deviceCode), { isOwner: true });
      await updateDoc(doc(db, "deviceSubscribers", deviceCode, "subscribers", newOwner.uid), { isOwner: true });
      await updateDevice(deviceCode, { ownerUid: newOwner.uid });
    } else {
      // No subscribers left — clear owner
      await updateDevice(deviceCode, { ownerUid: null, accessMode: "open", accessPin: null });
    }
  }

  // Decrement subscriber count
  const device = await getDevice(deviceCode);
  if (device && device.subscriberCount > 0) {
    await updateDevice(deviceCode, { subscriberCount: device.subscriberCount - 1 });
  }
}

export async function removeSubscriber(deviceCode, targetUid) {
  await deleteDoc(doc(db, "subscriptions", targetUid, "devices", deviceCode));
  await deleteDoc(doc(db, "deviceSubscribers", deviceCode, "subscribers", targetUid));
  const device = await getDevice(deviceCode);
  if (device && device.subscriberCount > 0) {
    await updateDevice(deviceCode, { subscriberCount: device.subscriberCount - 1 });
  }
}

export async function getUserSubscriptions(uid) {
  const snap = await getDocs(collection(db, "subscriptions", uid, "devices"));
  return snap.docs.map((d) => ({ deviceCode: d.id, ...d.data() }));
}

export async function getDeviceSubscribers(deviceCode) {
  const snap = await getDocs(collection(db, "deviceSubscribers", deviceCode, "subscribers"));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

export async function isSubscribed(uid, deviceCode) {
  const snap = await getDoc(doc(db, "subscriptions", uid, "devices", deviceCode));
  return snap.exists();
}

export async function isDeviceOwner(uid, deviceCode) {
  const snap = await getDoc(doc(db, "subscriptions", uid, "devices", deviceCode));
  return snap.exists() && snap.data().isOwner === true;
}

// ── Device Access Control ──
export async function setDeviceAccess(deviceCode, accessMode, accessPin = null) {
  const update = { accessMode };
  if (accessPin !== null) update.accessPin = accessPin;
  else if (accessMode !== "pin") update.accessPin = null;
  await updateDevice(deviceCode, update);
}

export async function createDeviceInvite(deviceCode, createdBy, maxUses = 5, expiryHours = 48) {
  const inviteId = Math.random().toString(36).substring(2, 10);
  await setDoc(doc(db, "deviceInvites", deviceCode, "invites", inviteId), {
    createdBy,
    createdAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
    maxUses,
    usedCount: 0,
  });
  return inviteId;
}

export async function validateDeviceInvite(deviceCode, inviteId) {
  const snap = await getDoc(doc(db, "deviceInvites", deviceCode, "invites", inviteId));
  if (!snap.exists()) return false;
  const data = snap.data();
  if (data.usedCount >= data.maxUses) return false;
  if (data.expiresAt && data.expiresAt.toDate() < new Date()) return false;
  // Increment used count
  await updateDoc(doc(db, "deviceInvites", deviceCode, "invites", inviteId), {
    usedCount: data.usedCount + 1,
  });
  return true;
}

export async function getDeviceInvites(deviceCode) {
  const snap = await getDocs(collection(db, "deviceInvites", deviceCode, "invites"));
  return snap.docs.map((d) => ({ inviteId: d.id, ...d.data() }));
}
