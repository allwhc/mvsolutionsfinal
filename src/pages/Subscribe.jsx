import { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getDevice, isSubscribed, subscribeToDevice } from "../firebase/db";

export default function Subscribe() {
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(searchParams.get("code") || "");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const scannerRef = useRef(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  const DEVICE_CLASS = { 1: "Valve", 2: "Sensor", 3: "Motor" };
  const SENSOR_TYPE = { 0: "None", 1: "DIP", 2: "Ultrasonic" };

  // Auto-lookup if code came from URL
  useEffect(() => {
    if (searchParams.get("code")) handleLookup();
  }, []);

  async function handleLookup() {
    if (!code.trim()) return;
    setError("");
    setDeviceInfo(null);
    setLoading(true);
    try {
      const device = await getDevice(code.trim());
      if (!device) { setError("Device not found in catalog"); setLoading(false); return; }
      const already = await isSubscribed(user.uid, code.trim());
      if (already) { setError("You are already subscribed to this device"); setLoading(false); return; }
      setDeviceInfo(device);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleSubscribe() {
    setLoading(true);
    setError("");
    try {
      await subscribeToDevice(user.uid, code.trim(), deviceInfo.deviceName || code.trim());
      setSuccess("Subscribed successfully!");
      setTimeout(() => navigate("/dashboard"), 1500);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function startScanner() {
    setScanning(true);
    setError("");
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (text) => {
          // Extract code from URL or raw text
          let deviceCode = text;
          try {
            const url = new URL(text);
            deviceCode = url.searchParams.get("code") || text;
          } catch {}
          setCode(deviceCode);
          stopScanner();
        }
      );
    } catch (err) {
      setError("Camera access denied or not available");
      setScanning(false);
    }
  }

  async function stopScanner() {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); } catch {}
      scannerRef.current = null;
    }
    setScanning(false);
  }

  useEffect(() => {
    return () => { stopScanner(); };
  }, []);

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Subscribe to Device</h1>

      {/* QR Scanner */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">
        <div id="qr-reader" className={scanning ? "mb-4" : "hidden"} />
        {!scanning ? (
          <button
            onClick={startScanner}
            className="w-full bg-gray-900 text-white py-3 rounded-lg text-sm font-medium hover:bg-gray-800"
          >
            Scan QR Code
          </button>
        ) : (
          <button
            onClick={stopScanner}
            className="w-full bg-red-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-red-600"
          >
            Stop Scanner
          </button>
        )}
      </div>

      {/* Manual code entry */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <p className="text-sm text-gray-500 mb-3">Or enter device code manually</p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="SF-XXXXXXXX-SN"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleLookup}
            disabled={loading || !code.trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            Lookup
          </button>
        </div>

        {error && <p className="text-red-500 text-sm mt-3">{error}</p>}
        {success && <p className="text-green-600 text-sm mt-3">{success}</p>}

        {/* Device preview */}
        {deviceInfo && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <h3 className="font-semibold text-sm text-gray-900 mb-2">Device Found</h3>
            <div className="grid grid-cols-2 gap-1 text-sm mb-4">
              <span className="text-gray-500">Code</span>
              <span className="font-mono">{code}</span>
              <span className="text-gray-500">Class</span>
              <span>{DEVICE_CLASS[deviceInfo.deviceClass] || "Unknown"}</span>
              <span className="text-gray-500">Sensor</span>
              <span>{SENSOR_TYPE[deviceInfo.sensorType] || "Unknown"}</span>
              <span className="text-gray-500">Firmware</span>
              <span>{deviceInfo.firmwareVersion || "N/A"}</span>
            </div>
            <button
              onClick={handleSubscribe}
              disabled={loading}
              className="w-full bg-green-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {loading ? "Subscribing..." : "Subscribe to this Device"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
