import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { registerWithEmail } from "../../firebase/auth";
import { createOrg, addOrgMember, updateUserDoc } from "../../firebase/db";
import { auth } from "../../firebase/config";

export default function OrgRegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgAddress, setOrgAddress] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
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
      setError(err.message);
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">Register Organisation</h1>

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
            <input
              type="password" placeholder="Password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
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
