import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { getOrg, getOrgMembers, getOrgGroups } from "../../firebase/db";

export default function OrgDashboard() {
  const { userData } = useAuth();
  const orgId = userData?.orgId;
  const [org, setOrg] = useState(null);
  const [memberCount, setMemberCount] = useState(0);
  const [groupCount, setGroupCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) return;
    Promise.all([
      getOrg(orgId),
      getOrgMembers(orgId),
      getOrgGroups(orgId),
    ]).then(([o, m, g]) => {
      setOrg(o);
      setMemberCount(m.length);
      setGroupCount(g.length);
      setLoading(false);
    });
  }, [orgId]);

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      {/* Org header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 mb-6 text-white">
        <h1 className="text-2xl font-bold">{org?.name || orgId}</h1>
        {org?.address && <p className="text-blue-100 text-sm mt-1">{org.address}</p>}
        <div className="flex gap-4 mt-4">
          <div className="bg-white/15 rounded-lg px-4 py-2">
            <p className="text-2xl font-bold">{memberCount}</p>
            <p className="text-xs text-blue-100">Members</p>
          </div>
          <div className="bg-white/15 rounded-lg px-4 py-2">
            <p className="text-2xl font-bold">{groupCount}</p>
            <p className="text-xs text-blue-100">Groups</p>
          </div>
        </div>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link to="/org/members">
          <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-gray-900">Members</p>
                <p className="text-xs text-gray-500">Manage roles</p>
              </div>
            </div>
          </div>
        </Link>

        <Link to="/org/groups">
          <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-50 rounded-lg flex items-center justify-center text-purple-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-gray-900">Groups</p>
                <p className="text-xs text-gray-500">Assign devices</p>
              </div>
            </div>
          </div>
        </Link>

        <Link to="/org/invite">
          <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center text-green-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-gray-900">Invite</p>
                <p className="text-xs text-gray-500">Max 10 members</p>
              </div>
            </div>
          </div>
        </Link>
      </div>

      {/* Org info */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mt-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Organisation Details</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <span className="text-gray-500">Name</span>
          <span className="text-gray-900">{org?.name}</span>
          <span className="text-gray-500">Address</span>
          <span className="text-gray-900">{org?.address || "—"}</span>
          <span className="text-gray-500">Contact</span>
          <span className="text-gray-900">{org?.contactEmail}</span>
          <span className="text-gray-500">Phone</span>
          <span className="text-gray-900">{org?.contactPhone || "—"}</span>
          <span className="text-gray-500">Status</span>
          <span className="text-green-600 font-medium">{org?.status || "Active"}</span>
        </div>
      </div>
    </div>
  );
}
