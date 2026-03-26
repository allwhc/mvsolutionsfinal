import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { useDevice } from "../hooks/useDevice";
import { getDevice, unsubscribeFromDevice } from "../firebase/db";
import { sendRefreshCommand, sendRestartCommand, sendTestCommand } from "../firebase/rtdb";
import DeviceCard from "../components/DeviceCard/DeviceCard";

export default function DeviceDetail() {
  const { code } = useParams();
  const { user } = useAuth();
  const { live, info, isOnline } = useDevice(code);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    getDevice(code).then((d) => { setCatalog(d); setLoading(false); });
  }, [code]);

  async function handleUnsubscribe() {
    if (!confirm("Unsubscribe from this device?")) return;
    await unsubscribeFromDevice(user.uid, code);
    navigate("/dashboard");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!catalog) {
    return <div className="text-center py-20 text-gray-500">Device not found in catalog</div>;
  }

  const DEVICE_CLASS = { 1: "Valve", 2: "Sensor", 3: "Motor" };
  const SENSOR_TYPE = { 0: "None", 1: "DIP", 2: "Ultrasonic" };

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={() => navigate("/dashboard")} className="text-sm text-blue-600 hover:underline mb-4 inline-block">
        &larr; Back to Dashboard
      </button>

      {/* Device card */}
      <DeviceCard
        deviceCode={code}
        deviceName={catalog.deviceName || code}
        live={live}
        catalog={catalog}
        isOnline={isOnline}
      />

      {/* Device info table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Device Info</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <span className="text-gray-500">Device Code</span>
          <span className="text-gray-900 font-mono">{code}</span>
          <span className="text-gray-500">Class</span>
          <span className="text-gray-900">{DEVICE_CLASS[catalog.deviceClass] || "Unknown"}</span>
          <span className="text-gray-500">Sensor Type</span>
          <span className="text-gray-900">{SENSOR_TYPE[catalog.sensorType] || "Unknown"}</span>
          <span className="text-gray-500">Sensor Count</span>
          <span className="text-gray-900">{catalog.sensorCount || "N/A"}</span>
          <span className="text-gray-500">Firmware</span>
          <span className="text-gray-900">{catalog.firmwareVersion || "Unknown"}</span>
          <span className="text-gray-500">RSSI</span>
          <span className="text-gray-900">{live?.rssi ? `${live.rssi} dBm` : "N/A"}</span>
          <span className="text-gray-500">Status</span>
          <span className={isOnline ? "text-green-600" : "text-gray-400"}>
            {isOnline ? "Online" : "Offline"}
          </span>
          <span className="text-gray-500">Last Seen</span>
          <span className="text-gray-900">
            {info?.lastSeen ? new Date(info.lastSeen * 1000).toLocaleString() : "Never"}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => sendRefreshCommand(code)}
            className="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-sm hover:bg-blue-100"
          >
            Force Refresh
          </button>
          <button
            onClick={() => sendTestCommand(code)}
            className="px-4 py-2 bg-green-50 text-green-600 rounded-lg text-sm hover:bg-green-100"
          >
            Test LED
          </button>
          <button
            onClick={() => sendRestartCommand(code)}
            className="px-4 py-2 bg-yellow-50 text-yellow-600 rounded-lg text-sm hover:bg-yellow-100"
          >
            Restart Device
          </button>
          <button
            onClick={handleUnsubscribe}
            className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100"
          >
            Unsubscribe
          </button>
        </div>
      </div>
    </div>
  );
}
