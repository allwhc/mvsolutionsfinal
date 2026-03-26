import { useState, useEffect } from "react";
import { getAllPlans, createPlan, updatePlan } from "../../firebase/db";

const DEFAULT_PLAN_TEMPLATE = {
  name: "", historyDays: 3, analyticsEnabled: false, valveControl: true,
  motorControl: true, refreshCommand: true, restartCommand: false,
  maxDevices: 5, maxMembers: 10, realtimeUpdates: true, exportEnabled: false,
};

export default function AdminPlans() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editPlan, setEditPlan] = useState(null);
  const [form, setForm] = useState({ ...DEFAULT_PLAN_TEMPLATE });

  async function load() {
    const p = await getAllPlans();
    setPlans(p);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function updateForm(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    const planId = editPlan?.planId || form.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    if (!planId) return;

    const data = { ...form };
    data.historyDays = parseInt(data.historyDays);
    data.maxDevices = parseInt(data.maxDevices);
    data.maxMembers = parseInt(data.maxMembers);

    if (editPlan) {
      await updatePlan(planId, data);
    } else {
      await createPlan(planId, data);
    }
    setShowAdd(false);
    setEditPlan(null);
    setForm({ ...DEFAULT_PLAN_TEMPLATE });
    await load();
  }

  function startEdit(plan) {
    setEditPlan(plan);
    setForm(plan);
    setShowAdd(true);
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Plans</h1>
        <button onClick={() => { setShowAdd(!showAdd); setEditPlan(null); setForm({ ...DEFAULT_PLAN_TEMPLATE }); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          + Create Plan
        </button>
      </div>

      {/* Add/Edit form */}
      {showAdd && (
        <form onSubmit={handleSave} className="bg-white rounded-xl border border-blue-200 p-4 mb-4 space-y-3">
          <p className="text-sm font-semibold text-gray-700">{editPlan ? "Edit Plan" : "New Plan"}</p>
          <input type="text" placeholder="Plan Name (e.g. Standard)" value={form.name}
            onChange={(e) => updateForm("name", e.target.value)} disabled={!!editPlan}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50" required />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500">History Days</label>
              <input type="number" min="1" max="90" value={form.historyDays}
                onChange={(e) => updateForm("historyDays", e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">Max Devices</label>
              <input type="number" min="1" max="200" value={form.maxDevices}
                onChange={(e) => updateForm("maxDevices", e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">Max Members</label>
              <input type="number" min="1" max="100" value={form.maxMembers}
                onChange={(e) => updateForm("maxMembers", e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
          </div>

          {/* Toggles */}
          <div className="grid grid-cols-2 gap-2">
            {[
              ["analyticsEnabled", "Analytics"],
              ["valveControl", "Valve Control"],
              ["motorControl", "Motor Control"],
              ["refreshCommand", "Refresh Command"],
              ["restartCommand", "Restart Command"],
              ["realtimeUpdates", "Realtime Updates"],
              ["exportEnabled", "Data Export"],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={!!form[key]}
                  onChange={(e) => updateForm(key, e.target.checked)} className="rounded" />
                {label}
              </label>
            ))}
          </div>

          <div className="flex gap-2">
            <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium">Save</button>
            <button type="button" onClick={() => { setShowAdd(false); setEditPlan(null); }}
              className="bg-gray-100 text-gray-600 px-4 py-2 rounded-lg text-sm">Cancel</button>
          </div>
        </form>
      )}

      {/* Plans list */}
      {plans.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-10">No plans created. Create your first plan.</p>
      ) : (
        <div className="space-y-3">
          {plans.map((p) => (
            <div key={p.planId} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="font-semibold text-gray-900">{p.name}</p>
                <button onClick={() => startEdit(p)} className="text-xs text-blue-600 hover:underline">Edit</button>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <span className="text-gray-500">History: <strong>{p.historyDays}d</strong></span>
                <span className="text-gray-500">Devices: <strong>{p.maxDevices}</strong></span>
                <span className="text-gray-500">Members: <strong>{p.maxMembers}</strong></span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {p.analyticsEnabled && <span className="text-xs bg-green-50 text-green-600 px-2 py-0.5 rounded">Analytics</span>}
                {p.valveControl && <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded">Valve</span>}
                {p.motorControl && <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded">Motor</span>}
                {p.restartCommand && <span className="text-xs bg-yellow-50 text-yellow-600 px-2 py-0.5 rounded">Restart</span>}
                {p.exportEnabled && <span className="text-xs bg-purple-50 text-purple-600 px-2 py-0.5 rounded">Export</span>}
                {!p.realtimeUpdates && <span className="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded">No Realtime</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
