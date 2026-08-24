import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";
import { getFunctions } from "firebase/functions";

// RTDB bandwidth diagnostic — activates ONLY when the page URL contains
// ?rtdbdebug=1 (e.g. app.senseflow.in/dashboard?rtdbdebug=1). Patches
// the native WebSocket constructor BEFORE Firebase loads so every RTDB
// frame gets byte-counted per path. Console: __rtdb.report() to see the
// current totals + top paths. Zero cost when the URL param is absent.
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("rtdbdebug") === "1") {
  const orig = window.WebSocket;
  const totals = { total: 0 };
  const perPath = {};
  let msgCount = 0;
  let start = Date.now();
  window.WebSocket = function (url, ...rest) {
    console.log("%c[rtdbdebug] WS opened:", "color: lime; font-weight: bold", url);
    const ws = new orig(url, ...rest);
    ws.addEventListener("message", (e) => {
      msgCount++;
      const bytes = typeof e.data === "string" ? e.data.length : e.data.byteLength || 0;
      totals.total += bytes;
      try {
        const msg = JSON.parse(e.data);
        const path = msg?.d?.b?.p || msg?.d?.b?.d?.p || (msg?.t === "c" ? "(control)" : "(other)");
        perPath[path] = (perPath[path] || 0) + bytes;
      } catch {
        perPath["(non-json)"] = (perPath["(non-json)"] || 0) + bytes;
      }
    });
    return ws;
  };
  window.__rtdb = {
    totals, perPath,
    msgCount: () => msgCount,
    reset: () => { totals.total = 0; Object.keys(perPath).forEach((k) => delete perPath[k]); msgCount = 0; start = Date.now(); console.log("[rtdbdebug] reset"); },
    report: () => {
      const secs = (Date.now() - start) / 1000;
      const perSec = totals.total / secs;
      console.log("=== RTDB WebSocket Report ===");
      console.log("Elapsed: " + secs.toFixed(1) + " sec");
      console.log("Messages: " + msgCount);
      console.log("Total: " + totals.total.toLocaleString() + " B (" + (totals.total / 1024).toFixed(1) + " KB)");
      console.log("Rate: " + (perSec / 1024).toFixed(2) + " KB/sec");
      console.log("Extrapolated: " + ((perSec * 86400) / 1024 / 1024).toFixed(1) + " MB/day per tab");
      const sorted = Object.entries(perPath).sort((a, b) => b[1] - a[1]);
      console.table(sorted.slice(0, 20).map(([path, bytes]) => ({
        path, bytes: bytes.toLocaleString(),
        pct: ((100 * bytes) / totals.total).toFixed(1) + "%",
      })));
    },
  };
  console.log("%c[rtdbdebug] ✅ ARMED — will count every RTDB WebSocket frame. Type __rtdb.report() any time.", "color: lime; font-size: 13px");
}

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
