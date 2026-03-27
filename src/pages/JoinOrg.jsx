import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getOrg, getOrgMembers, addOrgMember, updateUserDoc, updateOrg } from "../firebase/db";
import { loginWithGoogle, registerWithEmail } from "../firebase/auth";

const MAX_MEMBERS = 10;

export default function JoinOrg() {
  const { orgId } = useParams();
  const { user, userData, isAuthenticated, refreshUserData } = useAuth();
  const navigate = useNavigate();
  const [org, setOrg] = useState(null);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    async function load() {
      const o = await getOrg(orgId);
      if (!o) { setError("Organisation not found"); setLoading(false); return; }
      const members = await getOrgMembers(orgId);
      setOrg(o);
      setMemberCount(members.length);
      setLoading(false);
    }
    load();
  }, [orgId]);

  async function joinOrg(uid) {
    if (memberCount >= MAX_MEMBERS) {
      setError("Organisation has reached maximum members");
      return;
    }
    setJoining(true);
    try {
      await addOrgMember(orgId, uid, { role: "viewer", addedBy: "invite" });
      await updateUserDoc(uid, { role: "orgMember", orgId, orgName: org.name });
      await updateOrg(orgId, { memberCount: memberCount + 1 });
      await refreshUserData();
      navigate("/dashboard");
    } catch (err) {
      setError(err.message);
      setJoining(false);
    }
  }

  async function handleGoogleJoin() {
    setError("");
    try {
      const u = await loginWithGoogle();
      await joinOrg(u.uid);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegisterJoin(e) {
    e.preventDefault();
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setError("");
    try {
      const u = await registerWithEmail(email, password, name);
      await joinOrg(u.uid);
    } catch (err) {
      setError(err.message);
    }
  }

  // Already logged in — just join
  async function handleDirectJoin() {
    if (userData?.orgId === orgId) {
      navigate("/dashboard");
      return;
    }
    if (userData?.orgId) {
      setError("You are already a member of another organisation");
      return;
    }
    await joinOrg(user.uid);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white p-8 rounded-lg shadow-md text-center max-w-sm">
          <p className="text-red-500 font-medium">Organisation not found</p>
          <p className="text-gray-500 text-sm mt-2">This invite link may be invalid</p>
        </div>
      </div>
    );
  }

  const spotsLeft = MAX_MEMBERS - memberCount;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white p-8 rounded-xl shadow-md w-full max-w-md">
        {/* Org info */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3">
            <span className="text-2xl font-bold text-blue-600">{org.name.charAt(0)}</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Join {org.name}</h1>
          {org.address && <p className="text-sm text-gray-500 mt-1">{org.address}</p>}
          <p className="text-xs text-gray-400 mt-2">{spotsLeft} spot{spotsLeft !== 1 ? "s" : ""} remaining</p>
        </div>

        {spotsLeft <= 0 ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
            <p className="text-red-700 font-medium text-sm">This organisation is full</p>
          </div>
        ) : isAuthenticated ? (
          /* Already logged in — one click join */
          <div>
            <p className="text-sm text-gray-600 text-center mb-4">
              Signed in as <strong>{userData?.displayName || userData?.email}</strong>
            </p>
            {userData?.orgId === orgId ? (
              <button
                onClick={() => navigate("/dashboard")}
                className="w-full bg-green-600 text-white py-2.5 rounded-lg text-sm font-medium"
              >
                Already a member — Go to Dashboard
              </button>
            ) : (
              <button
                onClick={handleDirectJoin}
                disabled={joining}
                className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {joining ? "Joining..." : `Join ${org.name}`}
              </button>
            )}
          </div>
        ) : (
          /* Not logged in — sign up or sign in */
          <div>
            <button
              onClick={handleGoogleJoin}
              className="w-full flex items-center justify-center gap-2 bg-white border border-gray-300 rounded-lg px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 mb-4"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Sign in with Google & Join
            </button>

            <div className="relative mb-4">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-300"></div></div>
              <div className="relative flex justify-center text-sm"><span className="px-2 bg-white text-gray-500">or create account</span></div>
            </div>

            <form onSubmit={handleRegisterJoin} className="space-y-3">
              <input type="text" placeholder="Full Name" value={name} onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
              <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
              <div className="relative">
                <input type={showPassword ? "text" : "password"} placeholder="Password" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10" required />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {showPassword ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    ) : (
                      <><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></>
                    )}
                  </svg>
                </button>
              </div>
              <button type="submit" className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700">
                Create Account & Join
              </button>
            </form>
          </div>
        )}

        {error && <p className="text-red-500 text-sm mt-4 text-center">{error}</p>}
      </div>
    </div>
  );
}
