import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { registerWithEmail } from "../../firebase/auth";
import { createOrg, addOrgMember, updateUserDoc } from "../../firebase/db";
import { auth } from "../../firebase/config";

function friendlyError(err) {
  const code = err.code || "";
  if (code === "auth/email-already-in-use") return "This email is already registered. Please sign in.";
  if (code === "auth/invalid-email") return "Please enter a valid email address.";
  if (code === "auth/weak-password") return "Password must be at least 6 characters.";
  if (code === "auth/network-request-failed") return "Network error. Check your internet connection.";
  if (err.message?.includes("permission")) return "Registration failed. Please try again or contact SenseFlow team.";
  return err.message;
}

export default function OrgRegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgAddress, setOrgAddress] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setError("");
    setLoading(true);
    try {
      const user = await registerWithEmail(email, password, name);
      const orgId = orgName.toLowerCase().replace(/[^a-z0-9]/g, "_");

      await createOrg(orgId, {
        name: orgName,
        address: orgAddress,
        contactEmail: email,
        contactPhone,
        createdBy: user.uid,
      });

      await addOrgMember(orgId, user.uid, {
        role: "admin",
        addedBy: user.uid,
      });

      await updateUserDoc(user.uid, {
        role: "orgAdmin",
        orgId,
        orgName,
      });

      navigate("/dashboard");
    } catch (err) {
      setError(friendlyError(err));
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <div className="flex items-center justify-center gap-2 mb-2">
          <img src="/favicon-32x32.png" alt="" className="w-8 h-8" />
          <h1 className="text-2xl font-bold" style={{ color: "#1a2e5a" }}>SenseFlow</h1>
        </div>
        <p className="text-center text-sm text-gray-500 mb-6">Register Organisation</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="border-b border-gray-200 pb-4 mb-4">
            <p className="text-sm font-medium text-gray-500 mb-3">Admin Account</p>
            <input
              type="text" placeholder="Your Full Name" value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
              required
            />
            <input
              type="email" placeholder="Email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
              required
            />
            <div className="relative">
              <input type={showPassword ? "text" : "password"} placeholder="Password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
                required
              />
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
          </div>

          <div>
            <p className="text-sm font-medium text-gray-500 mb-3">Organisation Details</p>
            <input
              type="text" placeholder="Organisation Name" value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
              required
            />
            <input
              type="text" placeholder="Address" value={orgAddress}
              onChange={(e) => setOrgAddress(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
              required
            />
            <input
              type="tel" placeholder="Contact Phone" value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <button
            type="submit" disabled={loading}
            className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Registering..." : "Register Organisation"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link to="/login" className="text-blue-600 hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
