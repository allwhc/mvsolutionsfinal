import { useState, useEffect } from "react";
import { getAllOrgs } from "../../firebase/db";

export default function AdminOrgs() {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAllOrgs().then((o) => { setOrgs(o); setLoading(false); });
  }, []);

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
          {orgs.map((o) => (
            <div key={o.orgId} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-900">{o.name}</p>
                  <p className="text-xs text-gray-500">{o.address}</p>
                  <p className="text-xs text-gray-400">{o.contactEmail} | {o.contactPhone}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-gray-700">{o.memberCount || 0} members</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    o.status === "active" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                  }`}>
                    {o.status || "active"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
