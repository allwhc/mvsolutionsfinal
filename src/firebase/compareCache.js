// IndexedDB cache for Tank Comparison history pulls. Fetching 30 days
// of /history for N tanks is the one expensive operation in the compare
// feature — caching it per (orgId, YYYYMM, tankSetKey) means re-opening
// the same comparison doesn't re-hit RTDB. Cache entries carry the
// generation timestamp so the UI can display "data as of ...".
//
// Entries are keyed by `${orgId}|${yyyymm}|${deviceCodeSorted}`.
// Device codes sorted alphabetically before joining so {A,B} and
// {B,A} share the same cache row.
//
// Pure IndexedDB — no third-party dep. All methods promise-based.

const DB_NAME = "senseflow_compare";
const STORE   = "history";
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function makeKey(orgId, yyyymm, deviceCodes) {
  const sorted = [...deviceCodes].sort().join(",");
  return `${orgId || "self"}|${yyyymm}|${sorted}`;
}

export async function getCachedCompare(orgId, yyyymm, deviceCodes) {
  try {
    const db  = await openDb();
    const key = makeKey(orgId, yyyymm, deviceCodes);
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
    });
  } catch { return null; }
}

export async function putCachedCompare(orgId, yyyymm, deviceCodes, payload) {
  try {
    const db  = await openDb();
    const key = makeKey(orgId, yyyymm, deviceCodes);
    await new Promise((resolve) => {
      const tx  = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).put({ key, generatedAt: Date.now(), ...payload });
      req.onsuccess = resolve;
      req.onerror   = resolve;
    });
  } catch { /* storage full / private mode — degrade silently */ }
}

export async function clearCompareCache() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx  = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = resolve;
      req.onerror   = resolve;
    });
  } catch { /* ignore */ }
}
