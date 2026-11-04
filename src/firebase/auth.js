import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
  getAuth,
} from "firebase/auth";
import { initializeApp, deleteApp } from "firebase/app";
import { auth } from "./config";
import { createUserDoc, getUserDoc } from "./db";

// Same config as the main app — kept inline here rather than importing
// from config.js so the secondary app isn't tied to any shared state.
const firebaseConfig = {
  apiKey: "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4",
  authDomain: "senseflow-5a9bb.firebaseapp.com",
  databaseURL: "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "senseflow-5a9bb",
  storageBucket: "senseflow-5a9bb.firebasestorage.app",
  messagingSenderId: "816999395292",
  appId: "1:816999395292:web:62597895d9479ca40ea919",
  measurementId: "G-CM7YZZW2FF",
};

const googleProvider = new GoogleAuthProvider();

export async function registerWithEmail(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  await createUserDoc(cred.user.uid, {
    email,
    displayName,
    role: "individual",
    orgId: null,
  });
  return cred.user;
}

// Same as registerWithEmail but seeds the users/<uid> doc with the
// orgAdmin role + orgId BEFORE any org-scoped writes happen. Firestore
// rules check role from that doc — creating the auth account with the
// default "individual" role and then trying to createOrg() gets denied
// because the user isn't orgAdmin yet. This variant is used only by
// the /register/org flow.
export async function registerWithEmailAsOrgAdmin(email, password, displayName, orgId, orgName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  await createUserDoc(cred.user.uid, {
    email,
    displayName,
    role: "orgAdmin",
    orgId,
    orgName,
  });
  return cred.user;
}

export async function loginWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function loginWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  const existing = await getUserDoc(cred.user.uid);
  if (!existing) {
    await createUserDoc(cred.user.uid, {
      email: cred.user.email,
      displayName: cred.user.displayName || cred.user.email,
      role: "individual",
      orgId: null,
    });
  }
  return cred.user;
}

export async function logout() {
  await signOut(auth);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

// Super-admin "Create User" flow. Firebase's createUserWithEmailAndPassword
// auto-signs-in the new user on whatever auth instance you call it on —
// which would log the super-admin out of their own session. The standard
// workaround is to spin up a SECONDARY Firebase app instance just for the
// create call, then tear it down. The new user ends up signed in on the
// secondary instance (which no React code listens to), and the primary
// instance's super-admin session is untouched.
//
// Also writes the users/<uid> doc with the chosen role + orgId (if any),
// mirroring the complete-field pattern so rows render with proper name
// + email right away (no "Unknown / admin" ghosts like the old
// OrgRegisterForm first-admin records).
//
// Returns the new user's uid so the caller can also write an
// orgMembers/<orgId>/members/<uid> record if role is org-scoped.
export async function createUserAsSuperAdmin({ email, password, displayName, role, orgId, orgName }) {
  const secondaryApp  = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await updateProfile(cred.user, { displayName });
    const userDoc = {
      email,
      displayName,
      role,
      orgId:   orgId   || null,
      orgName: orgName || null,
    };
    await createUserDoc(cred.user.uid, userDoc);
    await signOut(secondaryAuth);
    return cred.user.uid;
  } finally {
    // Always tear down the secondary app — even on error — so we don't
    // leak app instances across repeated create attempts.
    try { await deleteApp(secondaryApp); } catch { /* ignore */ }
  }
}
