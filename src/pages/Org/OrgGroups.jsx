import { useState, useEffect } from "react";
import { useAuth } from "../../context/AuthContext";
import { getOrgGroups, createOrgGroup, deleteOrgGroup, updateOrgGroup, getUserSubscriptions } from "../../firebase/db";

export default function OrgGroups() {
  const { user, userData } = useAuth();
  const orgId = userData?.orgId;
  const [groups, setGroups] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [editGroup, setEditGroup] = useState(null);
  const [selectedDevices, setSelectedDevices] = useState([]);
  const [renameGroup, setRenameGroup] = useState(null);
  const [renameName, setRenameName] = useState("");

  async function load() {
    if (!orgId) return;
    const [g, d] = await Promise.all([getOrgGroups(orgId), getUserSubscriptions(user.uid)]);
    setGroups(g);
    setDevices(d);
    setLoading(false);
  }

  useEffect(() => { load(); }, [orgId]);

  async function handleCreate(e) {
    e.preventDefault();
    const groupId = newName.toLowerCase().replace(/[^a-z0-9]/g, "_");
    await createOrgGroup(orgId, groupId, { name: newName, deviceCodes: [] });
    setNewName("");
    setShowAdd(false);
    await load();
  }

  async function handleDelete(groupId) {
    if (!confirm("Delete this group?")) return;
    await deleteOrgGroup(orgId, groupId);
    await load();
  }

  async function handleRename() {
    const trimmed = renameName.trim();
    if (!trimmed || !renameGroup) return;
    await updateOrgGroup(orgId, renameGroup.groupId, { name: trimmed });
    setRenameGroup(null);
    setRenameName("");
    await load();
  }

  function openDeviceAssign(group) {
    setEditGroup(group);
    setSelectedDevices(group.deviceCodes || []);
  }

  async function handleAssignDevices() {
    await updateOrgGroup(orgId, editGroup.groupId, { deviceCodes: selectedDevices });
    setEditGroup(null);
    await load();
  }

  function toggleDevice(code) {
    setSelectedDevices((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Groups</h1>
        <button onClick={() => setShowAdd(!showAdd)} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          + New Group
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleCreate} className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex gap-2">
          <input type="text" placeholder="Group Name" value={newName} onChange={(e) => setNewName(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm">Create</button>
        </form>
      )}

      <div className="space-y-3">
        {groups.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-10">No groups</p>
        ) : groups.map((g) => (
          <div key={g.groupId} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-gray-900">{g.name}</p>
                  <button onClick={() => { setRenameGroup(g); setRenameName(g.name); }}
                    className="text-[10px] text-blue-600 hover:underline">Edit</button>
                </div>
                <p className="text-xs text-gray-500">{(g.deviceCodes || []).length} devices</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => openDeviceAssign(g)} className="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs">
                  Assign Devices
                </button>
                <button onClick={() => handleDelete(g.groupId)} className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs">
                  Delete
                </button>
              </div>
            </div>
            {(g.deviceCodes || []).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {g.deviceCodes.map((c) => (
                  <span key={c} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono">{c}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Assign devices modal */}
      {editGroup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[80vh] overflow-y-auto">
            <h3 className="font-bold text-lg mb-4">Assign Devices to {editGroup.name}</h3>
            <div className="space-y-2 mb-4">
              {devices.length === 0 ? (
                <div className="text-center py-6">
                  <p className="text-gray-400 text-sm mb-3">No devices subscribed yet</p>
                  <a href="/subscribe" className="inline-block bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
                    + Add Device
                  </a>
                </div>
              ) : devices.map((d) => (
                <label key={d.deviceCode} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedDevices.includes(d.deviceCode)}
                    onChange={() => toggleDevice(d.deviceCode)}
                    className="rounded"
                  />
                  <span className="font-mono text-xs">{d.deviceCode}</span>
                  {d.deviceName && <span className="text-gray-500">— {d.deviceName}</span>}
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              {devices.length > 0 && (
                <button onClick={handleAssignDevices} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium">Save</button>
              )}
              <button onClick={() => setEditGroup(null)} className={`py-2 rounded-lg text-sm ${devices.length > 0 ? "px-4 bg-gray-100 text-gray-600" : "flex-1 bg-gray-100 text-gray-600"}`}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Rename group modal */}
      {renameGroup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setRenameGroup(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-4">Rename Group</h3>
            <input type="text" value={renameName} onChange={(e) => setRenameName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setRenameGroup(null); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4" />
            <div className="flex gap-2">
              <button onClick={handleRename} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium">Save</button>
              <button onClick={() => setRenameGroup(null)} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
