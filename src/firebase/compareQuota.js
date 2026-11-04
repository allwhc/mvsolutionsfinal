// Tank-compare monthly quota. Stored on orgs/<orgId> doc as:
//   tankCompareEnabled: bool        (super-admin feature toggle)
//   tankCompareMonthlyLimit: int    (super-admin — default 2)
//   tankCompareUsedThisMonth: int   (incremented on each generate click)
//   tankCompareLastResetMonth: str  (YYYY-MM, auto-reset on month flip)
//
// Natural month boundary: on every quota read we compare current YYYY-MM
// to the stored lastResetMonth. If different, we zero the counter + bump
// lastResetMonth before answering. No scheduled function needed.
//
// A cached-generation does NOT consume quota — only a fresh fetch does.
// IndexedDB cache check happens FIRST in the UI; this file is only
// touched when we're about to actually hit RTDB.

import { doc, getDoc, updateDoc, increment } from "firebase/firestore";
import { db } from "./config";

// Default quota: 5 analyses per org per calendar month, shared across
// all admins of that org. Counter lives on orgs/<orgId>.tankCompareUsed*
// so multiple admins share one pool rather than each getting their own.
// Super-admin can override the limit per-org by setting
// orgs/<orgId>.tankCompareMonthlyLimit directly in Firestore (or via a
// future AdminOrgs UI). Resets naturally at calendar-month boundary.
const DEFAULT_MONTHLY_LIMIT = 5;

function currentYyyyMm(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Read quota, auto-reset on month flip. Returns:
//   { enabled, limit, used, remaining, resetMonth, nextReset }
// enabled defaults TRUE while developing — super-admin gate will flip
// default to false once the AdminOrgs toggle UI ships.
export async function readCompareQuota(orgId) {
  if (!orgId) {
    return { enabled: true, limit: DEFAULT_MONTHLY_LIMIT, used: 0, remaining: DEFAULT_MONTHLY_LIMIT, resetMonth: currentYyyyMm(), nextReset: nextResetDate() };
  }
  const ref  = doc(db, "orgs", orgId);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};

  const enabled = data.tankCompareEnabled !== false;
  const limit   = Number.isFinite(data.tankCompareMonthlyLimit) ? data.tankCompareMonthlyLimit : DEFAULT_MONTHLY_LIMIT;
  const now     = currentYyyyMm();
  let used      = Number.isFinite(data.tankCompareUsedThisMonth) ? data.tankCompareUsedThisMonth : 0;
  const stored  = data.tankCompareLastResetMonth || null;

  if (stored !== now) {
    try {
      await updateDoc(ref, {
        tankCompareUsedThisMonth: 0,
        tankCompareLastResetMonth: now,
      });
    } catch { /* rules may deny if not org admin — treat as fresh month */ }
    used = 0;
  }

  const remaining = Math.max(0, limit - used);
  return { enabled, limit, used, remaining, resetMonth: now, nextReset: nextResetDate() };
}

// Called AFTER a successful RTDB pull. Rolls one unit against the
// monthly limit. Firestore `increment()` is atomic so two tabs can't
// double-spend.
export async function consumeCompareQuota(orgId) {
  if (!orgId) return;
  await updateDoc(doc(db, "orgs", orgId), {
    tankCompareUsedThisMonth: increment(1),
    tankCompareLastResetMonth: currentYyyyMm(),
  });
}

function nextResetDate(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth();
  return new Date(y, m + 1, 1).toISOString().slice(0, 10);
}
