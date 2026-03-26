import { createContext, useContext, useState, useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase/config";
import { getUserDoc, updateUserDoc } from "../firebase/db";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        const doc = await getUserDoc(firebaseUser.uid);
        setUserData(doc);
        await updateUserDoc(firebaseUser.uid, { lastLogin: new Date() });
      } else {
        setUser(null);
        setUserData(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  async function refreshUserData() {
    if (user) {
      const doc = await getUserDoc(user.uid);
      setUserData(doc);
    }
  }

  const value = {
    user,
    userData,
    loading,
    refreshUserData,
    isAuthenticated: !!user,
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
