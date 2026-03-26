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

// ── Org Members ──
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

export async function removeOrgMember(orgId, uid) {
  await deleteDoc(doc(db, "orgMembers", orgId, "members", uid));
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

// ── Pending Devices ──
export async function getPendingDevices() {
  const snap = await getDocs(collection(db, "pendingDevices"));
  return snap.docs.map((d) => ({ deviceCode: d.id, ...d.data() }));
}

export async function approvePendingDevice(deviceCode, extraData = {}) {
  const pendingSnap = await getDoc(doc(db, "pendingDevices", deviceCode));
  if (!pendingSnap.exists()) throw new Error("Pending device not found");

  const deviceData = { ...pendingSnap.data(), ...extraData };
  await registerDevice(deviceCode, deviceData);
  await deleteDoc(doc(db, "pendingDevices", deviceCode));
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
export async function subscribeToDevice(uid, deviceCode, deviceName) {
  const batch = writeBatch(db);

  batch.set(doc(db, "subscriptions", uid, "devices", deviceCode), {
    subscribedAt: serverTimestamp(),
    deviceName: deviceName || deviceCode,
  });

  batch.set(doc(db, "deviceSubscribers", deviceCode, "subscribers", uid), {
    subscribedAt: serverTimestamp(),
    uid,
  });

  await batch.commit();
}

export async function unsubscribeFromDevice(uid, deviceCode) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "subscriptions", uid, "devices", deviceCode));
  batch.delete(doc(db, "deviceSubscribers", deviceCode, "subscribers", uid));
  await batch.commit();
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
