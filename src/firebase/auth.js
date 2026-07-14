import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
} from "firebase/auth";
import { auth } from "./config";
import { createUserDoc, getUserDoc } from "./db";

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
