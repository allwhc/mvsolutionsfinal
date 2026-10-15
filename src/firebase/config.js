import { initializeApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4",
  authDomain: "senseflow-5a9bb.firebaseapp.com",
  databaseURL: "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "senseflow-5a9bb",
  storageBucket: "senseflow-5a9bb.firebasestorage.app",
  messagingSenderId: "816999395292",
  appId: "1:816999395292:web:62597895d9479ca40ea919",
  measurementId: "G-CM7YZZW2FF"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Explicit local persistence — ensures the user's auth state survives
// tab-switch, backgrounded-tab discard, browser restart, and mobile
// Chrome's aggressive tab reaping. Firebase defaults to local on web
// but some edge cases (Safari ITP, cross-site cookie policy, incognito
// mode) can silently fall back to session or in-memory persistence,
// which looks to the user like "logged me out when I changed tabs".
// Setting explicitly removes the silent fallback. Fires once at app
// init; subsequent sign-ins inherit this persistence setting.
setPersistence(auth, browserLocalPersistence).catch((e) => {
  console.warn("[auth] setPersistence(browserLocal) failed:", e);
  // Non-fatal — Firebase keeps whatever default persistence it had.
});
export const db = getFirestore(app);
export const rtdb = getDatabase(app);
// Cloud Functions are deployed to asia-southeast1 to keep latency low.
// Frontend must match the region or the call will 404.
export const functions = getFunctions(app, "asia-southeast1");
export default app;
