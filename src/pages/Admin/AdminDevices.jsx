import { useState, useEffect } from "react";
import { getAllDevices, getPendingDevices, approvePendingDevice, registerDevice, updateDevice } from "../../firebase/db";
import { sendTestCommand, sendRestartCommand } from "../../firebase/rtdb";
import { QRCodeSVG } from "qrcode.react";

const DEVICE_CLASS = { 1: "Valve", 2: "Sensor", 3: "Motor" };
const SENSOR_TYPE = { 0: "None", 1: "DIP", 2: "Ultrasonic" };

export default function AdminDevices() {
  const [pending, setPending] = useState([]);
  const [registered, setRegistered] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("pending");
  const [registerModal, setRegisterModal] = useState(null);
  const [extraFields, setExtraFields] = useState({ deviceName: "", location: "", notes: "" });
  const [qrDevice, setQrDevice] = useState(null);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualForm, setManualForm] = useState({
    deviceCode: "", deviceClass: 2, sensorType: 1, sensorCount: 4,
    firmwareVersion: "1.0.0", deviceName: "", location: "", notes: "",
  });

  async function load() {
    const [p, r] = await Promise.all([getPendingDevices(), getAllDevices()]);
    setPending(p);
    setRegistered(r);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleApprove(deviceCode) {
    try {
      const extra = {};
      if (extraFields.deviceName) extra.deviceName = extraFields.deviceName;
      if (extraFields.location) extra.location = extraFields.location;
      if (extraFields.notes) extra.notes = extraFields.notes;
      await approvePendingDevice(deviceCode, extra);
      setRegisterModal(null);
      setExtraFields({ deviceName: "", location: "", notes: "" });
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleManualRegister(e) {
    e.preventDefault();
    if (!manualForm.deviceCode.trim()) { alert("Device code required"); return; }
    try {
      const data = {
        deviceClass: parseInt(manualForm.deviceClass),
        sensorType: parseInt(manualForm.sensorType),
        sensorCount: parseInt(manualForm.sensorCount),
        firmwareVersion: manualForm.firmwareVersion,
      };
      if (manualForm.deviceName) data.deviceName = manualForm.deviceName;
      if (manualForm.location) data.location = manualForm.location;
      if (manualForm.notes) data.notes = manualForm.notes;
      await registerDevice(manualForm.deviceCode.trim(), data);
      setShowManualAdd(false);
      setManualForm({ deviceCode: "", deviceClass: 2, sensorType: 1, sensorCount: 4, firmwareVersion: "1.0.0", deviceName: "", location: "", notes: "" });
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleToggleDeviceActive(deviceCode, currentActive) {
    const isActive = currentActive !== false;
    await updateDevice(deviceCode, { isActive: !isActive });
    await load();
  }

  const subscribeUrl = (code) => `${window.location.origin}/subscribe?code=${code}`;

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Devices</h1>
        <button
          onClick={() => setShowManualAdd(!showManualAdd)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          + Add Manually
        </button>
      </div>

      {/* Manual add form */}
      {showManualAdd && (
        <form onSubmit={handleManualRegister} className="bg-white rounded-xl border border-blue-200 p-4 mb-4 space-y-3">
          <p className="text-sm font-semibold text-gray-700">Manual Device Registration</p>
          <input type="text" placeholder="Device Code (e.g. SF-XXXXXXXX-SN)" value={manualForm.deviceCode}
            onChange={(e) => setManualForm({ ...manualForm, deviceCode: e.target.value.toUpperCase() })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" required />
          <div className="grid grid-cols-3 gap-2">
            <select value={manualForm.deviceClass} onChange={(e) => setManualForm({ ...manualForm, deviceClass: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value={1}>Valve</option><option value={2}>Sensor</option><option value={3}>Motor</option>
            </select>
            <select value={manualForm.sensorType} onChange={(e) => setManualForm({ ...manualForm, sensorType: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value={0}>No Sensor</option><option value={1}>DIP</option><option value={2}>Ultrasonic</option>
            </select>
            <input type="number" min="0" max="6" placeholder="Count" value={manualForm.sensorCount}
              onChange={(e) => setManualForm({ ...manualForm, sensorCount: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          </div>
          <input type="text" placeholder="Device Name (optional)" value={manualForm.deviceName}
            onChange={(e) => setManualForm({ ...manualForm, deviceName: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <input type="text" placeholder="Location (optional)" value={manualForm.location}
            onChange={(e) => setManualForm({ ...manualForm, location: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <div className="flex gap-2">
            <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium">Register</button>
            <button type="button" onClick={() => setShowManualAdd(false)} className="bg-gray-100 text-gray-600 px-4 py-2 rounded-lg text-sm">Cancel</button>
          </div>
        </form>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab("pending")}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-gray-100 text-gray-600"}`}
        >
          Pending ({pending.length})
        </button>
        <button
          onClick={() => setTab("registered")}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === "registered" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-600"}`}
        >
          Registered ({registered.length})
        </button>
      </div>

      {/* Pending devices */}
      {tab === "pending" && (
        <div className="space-y-3">
          {pending.length === 0 ? (
            <p className="text-gray-500 text-sm py-10 text-center">No pending devices</p>
          ) : pending.map((d) => (
            <div key={d.deviceCode} className="bg-white rounded-xl border border-yellow-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono font-semibold text-sm">{d.deviceCode}</p>
                  <p className="text-xs text-gray-500">
                    {DEVICE_CLASS[d.deviceClass] || "?"} | {SENSOR_TYPE[d.sensorType] || "?"} | {d.sensorCount || 0} sensors | FW: {d.firmwareVersion || "?"}
                  </p>
                  {d.macAddress && <p className="text-xs text-gray-400">MAC: {d.macAddress}</p>}
                </div>
                <button
                  onClick={() => setRegisterModal(d)}
                  className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700"
                >
                  Register
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Registered devices */}
      {tab === "registered" && (
        <div className="space-y-3">
          {registered.length === 0 ? (
            <p className="text-gray-500 text-sm py-10 text-center">No registered devices</p>
          ) : registered.map((d) => {
            const devActive = d.isActive !== false;
            return (
            <div key={d.deviceCode} className={`bg-white rounded-xl border p-4 ${devActive ? "border-gray-200" : "border-red-200 bg-red-50"}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm">{d.deviceName || d.deviceCode}</p>
                    {!devActive && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Inactive</span>}
                  </div>
                  <p className="font-mono text-xs text-gray-400">{d.deviceCode}</p>
                  <p className="text-xs text-gray-500">
                    {DEVICE_CLASS[d.deviceClass] || "?"} | {SENSOR_TYPE[d.sensorType] || "?"} | {d.sensorCount || 0} sensors
                  </p>
                  {d.location && <p className="text-xs text-gray-400">{d.location}</p>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => sendTestCommand(d.deviceCode)}
                    className="px-3 py-1.5 bg-green-50 text-green-600 rounded-lg text-xs hover:bg-green-100"
                  >
                    Test
                  </button>
                  <button
                    onClick={() => sendRestartCommand(d.deviceCode)}
                    className="px-3 py-1.5 bg-yellow-50 text-yellow-600 rounded-lg text-xs hover:bg-yellow-100"
                  >
                    Restart
                  </button>
                  <button
                    onClick={() => setQrDevice(d.deviceCode)}
                    className="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100"
                  >
                    QR
                  </button>
                  <button
                    onClick={() => handleToggleDeviceActive(d.deviceCode, d.isActive)}
                    className={`px-3 py-1.5 rounded-lg text-xs ${devActive ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-green-50 text-green-600 hover:bg-green-100"}`}
                  >
                    {devActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            </div>
          );
          })}
        </div>
      )}

      {/* Register Modal */}
      {registerModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="font-bold text-lg mb-4">Register Device</h3>
            <div className="text-sm text-gray-600 mb-4">
              <p className="font-mono font-semibold">{registerModal.deviceCode}</p>
              <p>{DEVICE_CLASS[registerModal.deviceClass]} | {SENSOR_TYPE[registerModal.sensorType]} | {registerModal.sensorCount} sensors</p>
            </div>

            <div className="space-y-3 mb-4">
              <p className="text-xs text-gray-500 font-medium">Optional details</p>
              <input
                type="text" placeholder="Device Name (e.g. Terrace Tank B3)"
                value={extraFields.deviceName}
                onChange={(e) => setExtraFields({ ...extraFields, deviceName: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text" placeholder="Location (e.g. Wing A, Floor 7)"
                value={extraFields.location}
                onChange={(e) => setExtraFields({ ...extraFields, location: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <textarea
                placeholder="Notes"
                value={extraFields.notes}
                onChange={(e) => setExtraFields({ ...extraFields, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={2}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => handleApprove(registerModal.deviceCode)}
                className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700"
              >
                Approve & Register
              </button>
              <button
                onClick={() => setRegisterModal(null)}
                className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal */}
      {qrDevice && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setQrDevice(null)}>
          <div className="bg-white rounded-xl p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-2">Device QR Code</h3>
            <p className="font-mono text-sm text-gray-600 mb-4">{qrDevice}</p>
            <QRCodeSVG value={subscribeUrl(qrDevice)} size={200} className="mx-auto mb-4" />
            <p className="text-xs text-gray-400 break-all mb-4">{subscribeUrl(qrDevice)}</p>
            <button onClick={() => setQrDevice(null)} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
