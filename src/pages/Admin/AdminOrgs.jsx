import { useState, useEffect } from "react";
import { getAllOrgs, updateOrg, getAllPlans } from "../../firebase/db";

export default function AdminOrgs() {
  const [orgs, setOrgs] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [o, p] = await Promise.all([getAllOrgs(), getAllPlans()]);
    setOrgs(o);
    setPlans(p);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleToggleActive(orgId, currentActive) {
    const isActive = currentActive !== false;
    await updateOrg(orgId, {
      isActive: !isActive,
      ...(isActive ? { deactivatedAt: new Date() } : { deactivatedAt: null }),
    });
    await load();
  }

  async function handlePlanChange(orgId, planId) {
    await updateOrg(orgId, { planId });
    await load();
  }

  async function handleSetSubscriptionEnd(orgId, date) {
    await updateOrg(orgId, {
      subscriptionEnd: date || null,
      autoDeactivate: !!date,
    });
    await load();
  }

  // Subscription status color
  function getSubStatus(org) {
    if (!org.subscriptionEnd) return { label: "No expiry", color: "bg-gray-100 text-gray-500" };
    const end = new Date(org.subscriptionEnd);
    const days = Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
    if (days <= 0) return { label: "Expired", color: "bg-red-100 text-red-700" };
    if (days <= 7) return { label: `${days}d left`, color: "bg-red-100 text-red-600" };
    if (days <= 30) return { label: `${days}d left`, color: "bg-yellow-100 text-yellow-700" };
    return { label: `${days}d left`, color: "bg-green-100 text-green-700" };
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Organisations ({orgs.length})</h1>

      {orgs.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-10">No organisations registered</p>
      ) : (
        <div className="space-y-3">
          {orgs.map((o) => {
            const isActive = o.isActive !== false;
            const subStatus = getSubStatus(o);
            return (
              <div key={o.orgId} className={`bg-white rounded-xl border p-4 ${isActive ? "border-gray-200" : "border-red-200 bg-red-50"}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-gray-900">{o.name}</p>
                      {!isActive && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Deactivated</span>}
                    </div>
                    <p className="text-xs text-gray-500">{o.address}</p>
                    <p className="text-xs text-gray-400">{o.contactEmail} | {o.contactPhone}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-700">{o.memberCount || 0} members</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${subStatus.color}`}>{subStatus.label}</span>
                  </div>
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                  {/* Plan */}
                  <select
                    value={o.planId || "basic"}
                    onChange={(e) => handlePlanChange(o.orgId, e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none"
                  >
                    <option value="basic">Basic</option>
                    {plans.map((p) => <option key={p.planId} value={p.planId}>{p.name}</option>)}
                  </select>

                  {/* Subscription end */}
                  <input
                    type="date"
                    value={o.subscriptionEnd || ""}
                    onChange={(e) => handleSetSubscriptionEnd(o.orgId, e.target.value)}
                    className="px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none"
                    title="Subscription end date"
                  />

                  {/* Deactivate */}
                  <button
                    onClick={() => handleToggleActive(o.orgId, o.isActive)}
                    className={`px-3 py-1 rounded text-xs ${
                      isActive
                        ? "bg-red-50 text-red-600 hover:bg-red-100"
                        : "bg-green-50 text-green-600 hover:bg-green-100"
                    }`}
                  >
                    {isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
