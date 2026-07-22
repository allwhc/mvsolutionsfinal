import { createContext, useContext, useState, useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase/config";
import { getUserDoc, updateUserDoc, getPlan, getOrg } from "../firebase/db";

// Self-heal path — reads the user's OWN membership record from their
// pending or current org and reconciles the user doc. Called on every
// AuthContext refresh so a member notices approve/reject/remove
// without needing a Cloud Function. Rules only let a user write to
// their own /users/{uid} doc, so orgAdmin's approve action can flip
// the membership record but can't touch the target's user doc — this
// closes that loop from the member's side.
//
// Three cases handled:
//   1. Pending → active   (admin approved) → set orgId, clear pending
//   2. Pending → missing  (admin rejected) → clear pendingOrgId
//   3. Active → missing   (admin revoked) → clear orgId + role
async function promoteSelfIfApproved(uid, doc) {
  if (!doc) return null;
  const pendingOrgId = doc.pendingOrgId || null;
  const activeOrgId  = doc.orgId        || null;
  if (!pendingOrgId && !activeOrgId) return null;

  // Case 1 or 2 — pending self-join. Check membership record status.
  if (pendingOrgId) {
    try {
      const snap = await getDoc(doc_ref(pendingOrgId, uid));
      if (!snap.exists()) {
        // Rejected — orgAdmin dropped the pending record.
        await updateUserDoc(uid, { pendingOrgId: null, pendingOrgName: null });
        return { changed: true, kind: "rejected" };
      }
      const rec = snap.data();
      if (rec.status === "active") {
        // Approved! Read org name so downstream UI has it.
        let orgName = doc.pendingOrgName || "";
        try {
          const oSnap = await getDoc(doc_orgRef(pendingOrgId));
          if (oSnap.exists()) orgName = oSnap.data().name || orgName;
        } catch { /* keep prior name */ }
        await updateUserDoc(uid, {
          orgId: pendingOrgId,
          orgName,
          role: "orgMember",
          pendingOrgId: null,
          pendingOrgName: null,
        });
        return { changed: true, kind: "approved" };
      }
      // Still pending — nothing to do.
      return null;
    } catch (e) {
      console.warn("promoteSelfIfApproved: pending check failed:", e);
      return null;
    }
  }

  // Case 3 — active membership disappeared (orgAdmin removed us).
  if (activeOrgId) {
    try {
      const snap = await getDoc(doc_ref(activeOrgId, uid));
      if (!snap.exists()) {
        await updateUserDoc(uid, {
          orgId: null,
          orgName: null,
          role: "user",
        });
        return { changed: true, kind: "revoked" };
      }
    } catch (e) {
      // Rules would deny a truly-removed user reading /orgMembers/.../<uid>
      // ONLY if the org itself was deleted. Treat any deny here as
      // "not sure" and leave state alone — don't accidentally strip
      // a real membership over a transient rules issue.
      console.warn("promoteSelfIfApproved: active check failed:", e);
    }
  }
  return null;
}

// Helper refs kept tiny + named so the function above reads cleanly.
function doc_ref(orgId, uid)  { return doc(db, "orgMembers", orgId, "members", uid); }
function doc_orgRef(orgId)    { return doc(db, "orgs", orgId); }

const AuthContext = createContext(null);

// Default plan for users without one assigned
const DEFAULT_PLAN = {
  name: "Basic",
  historyDays: 3,
  analyticsEnabled: false,
  valveControl: true,
  motorControl: true,
  refreshCommand: true,
  restartCommand: false,
  maxDevices: 3,
  maxMembers: 10,
  realtimeUpdates: true,
  exportEnabled: false,
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);
  const [plan, setPlan] = useState(DEFAULT_PLAN);
  const [orgData, setOrgData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deactivated, setDeactivated] = useState(false);
  const [deactivationReason, setDeactivationReason] = useState("");
  const [subscriptionExpired, setSubscriptionExpired] = useState(false);
  const [subscriptionEndDate, setSubscriptionEndDate] = useState(null);
  const [expiryWarningDays, setExpiryWarningDays] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        let doc = await getUserDoc(firebaseUser.uid);

        // Self-heal: reconcile pending / removed org membership.
        // If admin approved/rejected/revoked since last load, this
        // updates the user doc from OUR side (rules block admin from
        // touching /users/{uid}). Re-fetch after so downstream code
        // sees the reconciled state.
        const outcome = await promoteSelfIfApproved(firebaseUser.uid, doc);
        if (outcome?.changed) {
          doc = await getUserDoc(firebaseUser.uid);
        }
        setUserData(doc);

        if (!doc) { setLoading(false); return; }

        // Check user deactivation
        if (doc.isActive === false) {
          setDeactivated(true);
          setDeactivationReason(doc.deactivationReason || "");
          setLoading(false);
          return;
        }

        // Load org data and check org deactivation
        if (doc.orgId) {
          const org = await getOrg(doc.orgId);
          setOrgData(org);
          if (org?.isActive === false) {
            setDeactivated(true);
            setDeactivationReason(org.deactivationReason || "Organisation deactivated");
            setLoading(false);
            return;
          }

          // Check org subscription expiry
          if (org?.subscriptionEnd) {
            const endDate = new Date(org.subscriptionEnd);
            const now = new Date();
            const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
            setSubscriptionEndDate(org.subscriptionEnd);

            if (daysLeft <= 0 && org.autoDeactivate) {
              setSubscriptionExpired(true);
              setDeactivated(true);
              setDeactivationReason("Subscription expired on " + org.subscriptionEnd);
              setLoading(false);
              return;
            }
            if (daysLeft <= 30 && daysLeft > 0) {
              setExpiryWarningDays(daysLeft);
            }
          }
        }

        // Check individual subscription expiry
        if (doc.subscriptionEnd && !doc.orgId) {
          const endDate = new Date(doc.subscriptionEnd);
          const now = new Date();
          const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
          setSubscriptionEndDate(doc.subscriptionEnd);

          if (daysLeft <= 0 && doc.autoDeactivate) {
            setSubscriptionExpired(true);
            setDeactivated(true);
            setDeactivationReason("Subscription expired on " + doc.subscriptionEnd);
            setLoading(false);
            return;
          }
          if (daysLeft <= 30 && daysLeft > 0) {
            setExpiryWarningDays(daysLeft);
          }
        }

        // Load plan
        const planId = doc.planId || (doc.orgId ? orgData?.planId : null) || "basic";
        const loadedPlan = await getPlan(planId);
        setPlan(loadedPlan || DEFAULT_PLAN);

        setDeactivated(false);
        await updateUserDoc(firebaseUser.uid, { lastLogin: new Date() });
      } else {
        setUser(null);
        setUserData(null);
        setPlan(DEFAULT_PLAN);
        setOrgData(null);
        setDeactivated(false);
        setDeactivationReason("");
        setSubscriptionExpired(false);
        setExpiryWarningDays(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  async function refreshUserData() {
    if (user) {
      let doc = await getUserDoc(user.uid);
      // Same self-heal as on initial load. This is what makes
      // PendingApproval's "Check status" button actually break the
      // user out of the waiting screen once orgAdmin approves.
      const outcome = await promoteSelfIfApproved(user.uid, doc);
      if (outcome?.changed) {
        doc = await getUserDoc(user.uid);
      }
      setUserData(doc);
      if (doc?.orgId) {
        const org = await getOrg(doc.orgId);
        setOrgData(org);
      }
    }
  }

  const value = {
    user,
    userData,
    plan,
    orgData,
    loading,
    refreshUserData,
    isAuthenticated: !!user,
    isDeactivated: deactivated,
    deactivationReason,
    subscriptionExpired,
    subscriptionEndDate,
    expiryWarningDays,
    isSuperAdmin: userData?.role === "superadmin",
    isOrgAdmin: userData?.role === "orgAdmin",
    isOrgMember: userData?.role === "orgMember",
    isIndividual: userData?.role === "individual",
    role: userData?.role,
    orgId: userData?.orgId,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
