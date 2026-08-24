import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
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
export const db = getFirestore(app);
export const rtdb = getDatabase(app);
// Cloud Functions are deployed to asia-southeast1 to keep latency low.
// Frontend must match the region or the call will 404.
export const functions = getFunctions(app, "asia-southeast1");
export default app;
