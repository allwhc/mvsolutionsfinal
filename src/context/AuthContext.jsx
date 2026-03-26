import { createContext, useContext, useState, useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase/config";
import { getUserDoc, updateUserDoc, getPlan, getOrg } from "../firebase/db";

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
        const doc = await getUserDoc(firebaseUser.uid);
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
      const doc = await getUserDoc(user.uid);
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
