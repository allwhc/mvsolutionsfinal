import { useState, useEffect, useRef } from "react";
import { getAllDevices, approvePendingDevice, registerDevice, updateDevice, deleteDeviceFromCatalog } from "../../firebase/db";
import { sendTestCommand, sendRestartCommand, getPendingDevicesRTDB, listenToDeviceLive, listenToDeviceInfo } from "../../firebase/rtdb";
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

  // WebSerial — uses DOM refs for terminal (no React state in read loop)
  const webSerialSupported = typeof navigator !== "undefined" && "serial" in navigator;
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialDeviceCode, setSerialDeviceCode] = useState("");
  const [serialDeviceInfo, setSerialDeviceInfo] = useState(null);
  const serialRef = useRef({ port: null, reader: null, writer: null, active: false, buffer: "" });
  const terminalRef = useRef(null);

  // QR Scanner
  const [showQrScanner, setShowQrScanner] = useState(false);
  const qrScannerRef = useRef(null);

  // Bulk QR print
  const [selectedForPrint, setSelectedForPrint] = useState(new Set());
  const [showBulkPrint, setShowBulkPrint] = useState(false);

  // Device live viewer
  const [viewDevice, setViewDevice] = useState(null);  // device code being viewed
  const [viewLive, setViewLive] = useState(null);
  const [viewInfo, setViewInfo] = useState(null);
  const viewUnsubRef = useRef([]);

  async function load() {
    const [p, r] = await Promise.all([getPendingDevicesRTDB(), getAllDevices()]);
    // Filter out pending devices that are already registered in catalog
    const registeredCodes = new Set(r.map(d => d.deviceCode));
    setPending(p.filter(d => !registeredCodes.has(d.deviceCode)));
    setRegistered(r);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // ── Pending device approval ──
  async function handleApprove(deviceCode) {
    try {
      const pendingDev = pending.find(d => d.deviceCode === deviceCode);
      const extra = {};
      if (extraFields.deviceName) extra.deviceName = extraFields.deviceName;
      if (extraFields.location) extra.location = extraFields.location;
      if (extraFields.notes) extra.notes = extraFields.notes;
      await approvePendingDevice(deviceCode, pendingDev || {}, extra);
      setRegisterModal(null);
      setExtraFields({ deviceName: "", location: "", notes: "" });
      await load();
      setQrDevice(deviceCode);
      setTab("registered");
    } catch (err) { alert(err.message); }
  }

  // ── Manual registration ──
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
      const code = manualForm.deviceCode.trim();
      setShowManualAdd(false);
      setManualForm({ deviceCode: "", deviceClass: 2, sensorType: 1, sensorCount: 4, firmwareVersion: "1.0.0", deviceName: "", location: "", notes: "" });
      await load();
      setQrDevice(code);
      setTab("registered");
    } catch (err) { alert(err.message); }
  }

  // ── Device activate/deactivate ──
  async function handleToggleDeviceActive(deviceCode, currentActive) {
    const isActive = currentActive !== false;
    await updateDevice(deviceCode, { isActive: !isActive });
    await load();
  }

  async function handleDeleteDevice(deviceCode) {
    if (!confirm("Delete " + deviceCode + " from catalog? This cannot be undone. The device will need to be re-registered.")) return;
    try {
      await deleteDeviceFromCatalog(deviceCode);
      await load();
    } catch (err) { alert(err.message); }
  }

  // ══════════════════════════════════════════════
  // WebSerial — same pattern as working admin.html
  // Terminal uses DOM innerHTML, not React state
  // ══════════════════════════════════════════════

  function logTerminal(msg) {
    const el = terminalRef.current;
    if (!el) return;
    const ts = new Date().toLocaleTimeString();
    el.innerHTML += "[" + ts + "] " + msg + "\n";
    el.scrollTop = el.scrollHeight;
  }

  async function connectSerial() {
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });

      // Prevent ESP32 reset by disabling DTR/RTS
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });

      const reader = port.readable.getReader();

      serialRef.current = { port, reader, writer: null, active: true, buffer: "" };
      setSerialConnected(true);
      setSerialDeviceCode("");
      setSerialDeviceInfo(null);
      if (terminalRef.current) terminalRef.current.innerHTML = "";
      logTerminal("Connected to ESP32");

      // Background read — raw bytes, decode manually
      const textDecoder = new TextDecoder();
      (async function readLoop() {
        const s = serialRef.current;
        try {
          while (s.active && s.reader) {
            const { value, done } = await s.reader.read();
            if (done) break;
            if (!value) continue;
            const text = textDecoder.decode(value, { stream: true });
            s.buffer += text;
            let idx;
            while ((idx = s.buffer.indexOf("\n")) !== -1) {
              const line = s.buffer.substring(0, idx).trim();
              s.buffer = s.buffer.substring(idx + 1);
              if (line.length > 0) {
                logTerminal("ESP32: " + line);
                // Parse — only these few setStates (triggered once per info block)
                const cm = line.match(/SF-[A-Z0-9]{8}-SN/);
                if (cm) setSerialDeviceCode(cm[0]);
                if (line.includes("SENSOR (0x02)")) setSerialDeviceInfo(p => ({ ...p, deviceClass: 2 }));
                if (line.includes("VALVE (0x01)")) setSerialDeviceInfo(p => ({ ...p, deviceClass: 1 }));
                if (line.includes("MOTOR (0x03)")) setSerialDeviceInfo(p => ({ ...p, deviceClass: 3 }));
                if (line.includes("DIP (0x01)")) setSerialDeviceInfo(p => ({ ...p, sensorType: 1 }));
                if (line.includes("ULTRASONIC (0x02)")) setSerialDeviceInfo(p => ({ ...p, sensorType: 2 }));
                const cnt = line.match(/Sensor Count:\s*(\d+)/);
                if (cnt) setSerialDeviceInfo(p => ({ ...p, sensorCount: parseInt(cnt[1]) }));
                const fw = line.match(/Firmware:\s*(\S+)/);
                if (fw) setSerialDeviceInfo(p => ({ ...p, firmwareVersion: fw[1] }));
                const mac = line.match(/MAC:\s*(\S+)/);
                if (mac) setSerialDeviceInfo(p => ({ ...p, macAddress: mac[1] }));
              }
            }
          }
        } catch (err) {
          if (s.active) logTerminal("Read error: " + err.message);
        }
      })();

      // Auto-send ADMIN after boot
      setTimeout(() => sendSerialCmd("ADMIN"), 3000);
    } catch (err) {
      if (err.name !== "NotFoundError") alert("Serial error: " + err.message);
    }
  }

  async function sendSerialCmd(cmd) {
    const s = serialRef.current;
    if (!s.active || !s.port?.writable) return;
    try {
      // Release reader, write raw bytes, re-acquire reader
      if (s.reader) { await s.reader.cancel(); s.reader = null; }
      const writer = s.port.writable.getWriter();
      await writer.write(new TextEncoder().encode(cmd + "\n"));
      writer.releaseLock();
      logTerminal("Sent: " + cmd);
      // Re-start reading
      s.reader = s.port.readable.getReader();
      const td = new TextDecoder();
      (async () => {
        try {
          while (s.active && s.reader) {
            const { value, done } = await s.reader.read();
            if (done) break;
            if (!value) continue;
            const text = td.decode(value, { stream: true });
            s.buffer += text;
            let idx;
            while ((idx = s.buffer.indexOf("\n")) !== -1) {
              const line = s.buffer.substring(0, idx).trim();
              s.buffer = s.buffer.substring(idx + 1);
              if (line.length > 0) {
                logTerminal("ESP32: " + line);
                const cm = line.match(/SF-[A-Z0-9]{8}-SN/);
                if (cm) setSerialDeviceCode(cm[0]);
                if (line.includes("SENSOR (0x02)")) setSerialDeviceInfo(p => ({...p, deviceClass: 2}));
                if (line.includes("VALVE (0x01)")) setSerialDeviceInfo(p => ({...p, deviceClass: 1}));
                if (line.includes("MOTOR (0x03)")) setSerialDeviceInfo(p => ({...p, deviceClass: 3}));
                if (line.includes("DIP (0x01)")) setSerialDeviceInfo(p => ({...p, sensorType: 1}));
                if (line.includes("ULTRASONIC (0x02)")) setSerialDeviceInfo(p => ({...p, sensorType: 2}));
                const cnt = line.match(/Sensor Count:\s*(\d+)/);
                if (cnt) setSerialDeviceInfo(p => ({...p, sensorCount: parseInt(cnt[1])}));
                const fw = line.match(/Firmware:\s*(\S+)/);
                if (fw) setSerialDeviceInfo(p => ({...p, firmwareVersion: fw[1]}));
                const mac = line.match(/MAC:\s*(\S+)/);
                if (mac) setSerialDeviceInfo(p => ({...p, macAddress: mac[1]}));
              }
            }
          }
        } catch (err) {
        }
      })();
    } catch (err) {
      logTerminal("Send error: " + err.message);
    }
  }

  async function disconnectSerial() {
    const s = serialRef.current;
    s.active = false;
    try {
      if (s.reader) { await s.reader.cancel(); s.reader = null; }
      if (s.port) { await s.port.close(); s.port = null; }
    } catch {}
    serialRef.current = { port: null, reader: null, writer: null, active: false, buffer: "" };
    setSerialConnected(false);
    logTerminal("Disconnected");
  }

  async function registerSerialDevice() {
    if (!serialDeviceCode) { alert("No device code detected. Press Get Device Info."); return; }
    try {
      await registerDevice(serialDeviceCode, {
        deviceClass: serialDeviceInfo?.deviceClass || 2,
        sensorType: serialDeviceInfo?.sensorType || 1,
        sensorCount: serialDeviceInfo?.sensorCount || 4,
        firmwareVersion: serialDeviceInfo?.firmwareVersion || "1.0.0",
        macAddress: serialDeviceInfo?.macAddress || "",
      });
      await load();
      setQrDevice(serialDeviceCode);
      setTab("registered");
      logTerminal("Registered: " + serialDeviceCode);
    } catch (err) { alert(err.message); }
  }

  // ── QR Scanner ──
  async function startQrScanner() {
    setShowQrScanner(true);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("admin-qr-reader");
      qrScannerRef.current = scanner;
      await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (text) => {
        let code = text;
        try { const url = new URL(text); code = url.searchParams.get("code") || text; } catch {}
        stopQrScanner();
        setManualForm((prev) => ({ ...prev, deviceCode: code }));
        setShowManualAdd(true);
      });
    } catch (err) { alert("Camera error: " + err.message); setShowQrScanner(false); }
  }

  async function stopQrScanner() {
    if (qrScannerRef.current) { try { await qrScannerRef.current.stop(); } catch {} qrScannerRef.current = null; }
    setShowQrScanner(false);
  }

  // ── Bulk QR ──
  function togglePrintSelect(code) {
    setSelectedForPrint((prev) => { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  }
  function selectAllForPrint() {
    setSelectedForPrint(selectedForPrint.size === registered.length ? new Set() : new Set(registered.map((d) => d.deviceCode)));
  }

  function openDeviceViewer(code) {
    // Clean up previous listeners
    viewUnsubRef.current.forEach(u => u());
    viewUnsubRef.current = [];
    setViewLive(null);
    setViewInfo(null);
    setViewDevice(code);
    // Attach live listeners
    const unLive = listenToDeviceLive(code, (data) => setViewLive(data));
    const unInfo = listenToDeviceInfo(code, (data) => setViewInfo(data));
    viewUnsubRef.current = [unLive, unInfo];
  }

  function closeDeviceViewer() {
    viewUnsubRef.current.forEach(u => u());
    viewUnsubRef.current = [];
    setViewDevice(null);
    setViewLive(null);
    setViewInfo(null);
  }

  const subscribeUrl = (code) => `${window.location.origin}/subscribe?code=${code}`;

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Devices</h1>
        <div className="flex flex-wrap gap-2">
          {webSerialSupported && !serialConnected && (
            <button onClick={connectSerial} className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-800">
              Connect Serial
            </button>
          )}
          {serialConnected && (
            <button onClick={disconnectSerial} className="px-4 py-2 rounded-lg text-sm font-medium bg-red-100 text-red-700">
              Disconnect Serial
            </button>
          )}
          <button onClick={showQrScanner ? stopQrScanner : startQrScanner}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${showQrScanner ? "bg-red-100 text-red-700" : "bg-purple-600 text-white hover:bg-purple-700"}`}>
            {showQrScanner ? "Stop Scanner" : "Scan QR"}
          </button>
          <button onClick={() => setShowManualAdd(!showManualAdd)}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
            + Add Manually
          </button>
        </div>
      </div>

      {/* WebSerial Panel */}
      {serialConnected && (
        <div className="bg-gray-900 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-green-400 text-sm font-mono">Serial Monitor Connected</p>
            <div className="flex gap-2">
              <button onClick={() => sendSerialCmd("ADMIN")} className="px-3 py-1 bg-blue-600 text-white rounded text-xs">Get Device Info</button>
              <button onClick={() => sendSerialCmd("STATUS")} className="px-3 py-1 bg-gray-700 text-white rounded text-xs">Status</button>
            </div>
          </div>
          <pre ref={terminalRef} className="bg-black rounded-lg p-3 h-40 overflow-y-auto font-mono text-xs text-green-300 whitespace-pre-wrap" />
          {serialDeviceCode && (
            <div className="bg-gray-800 rounded-lg p-3 mt-3 flex items-center justify-between">
              <div>
                <p className="text-white font-mono text-sm font-bold">{serialDeviceCode}</p>
                <p className="text-gray-400 text-xs">
                  {DEVICE_CLASS[serialDeviceInfo?.deviceClass] || "Sensor"} | {SENSOR_TYPE[serialDeviceInfo?.sensorType] || "DIP"} | {serialDeviceInfo?.sensorCount || "?"} sensors
                </p>
              </div>
              <button onClick={registerSerialDevice} className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700">
                Add to Catalog
              </button>
            </div>
          )}
          {/* WiFi Config via Serial */}
          <div className="bg-gray-800 rounded-lg p-3 mt-3">
            <p className="text-gray-400 text-xs font-semibold mb-2">WiFi Setup via Serial</p>
            <div className="flex gap-2">
              <input type="text" id="serial-wifi-ssid" placeholder="SSID"
                className="flex-1 px-3 py-1.5 bg-gray-700 text-white border border-gray-600 rounded text-xs font-mono" />
              <input type="password" id="serial-wifi-pass" placeholder="Password"
                className="flex-1 px-3 py-1.5 bg-gray-700 text-white border border-gray-600 rounded text-xs font-mono" />
              <button onClick={() => {
                const ssid = document.getElementById("serial-wifi-ssid").value.trim();
                const pass = document.getElementById("serial-wifi-pass").value;
                if (!ssid) { alert("SSID required"); return; }
                sendSerialCmd("WIFI " + ssid + (pass ? " " + pass : ""));
              }} className="px-4 py-1.5 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 whitespace-nowrap">
                Send WiFi
              </button>
            </div>
            <p className="text-gray-500 text-[10px] mt-1">Device will save credentials and restart automatically</p>
          </div>
        </div>
      )}

      {/* QR Scanner */}
      {showQrScanner && (
        <div className="bg-white rounded-xl border border-purple-200 p-4 mb-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">Scan device QR code to register</p>
          <div id="admin-qr-reader" className="mb-3" />
          <button onClick={stopQrScanner} className="w-full bg-red-500 text-white py-2 rounded-lg text-sm font-medium">Cancel</button>
        </div>
      )}

      {/* Manual add form */}
      {showManualAdd && (
        <form onSubmit={handleManualRegister} className="bg-white rounded-xl border border-blue-200 p-4 mb-4 space-y-3">
          <p className="text-sm font-semibold text-gray-700">Manual Device Registration</p>
          <input type="text" placeholder="Device Code (e.g. SF-XXXXXXXX-SN)" value={manualForm.deviceCode}
            onChange={(e) => setManualForm({ ...manualForm, deviceCode: e.target.value.toUpperCase() })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" required />
          <p className="text-xs text-gray-400">Device config is auto-detected when it connects. Optional overrides below:</p>
          <details className="mt-1">
            <summary className="text-xs text-blue-600 cursor-pointer">Advanced config (optional)</summary>
            <div className="grid grid-cols-3 gap-2 mt-2">
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
          </details>
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
        <button onClick={() => setTab("pending")} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-gray-100 text-gray-600"}`}>
          Pending ({pending.length})
        </button>
        <button onClick={() => setTab("registered")} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === "registered" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-600"}`}>
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
                  <p className="text-xs text-gray-500">{DEVICE_CLASS[d.deviceClass] || "?"} | {SENSOR_TYPE[d.sensorType] || "?"} | {d.sensorCount || 0} sensors</p>
                  {d.macAddress && <p className="text-xs text-gray-400">MAC: {d.macAddress}</p>}
                </div>
                <button onClick={() => setRegisterModal(d)} className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700">Register</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Registered devices */}
      {tab === "registered" && (
        <div>
          {registered.length > 0 && (
            <div className="flex items-center gap-3 mb-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                <input type="checkbox" checked={selectedForPrint.size === registered.length && registered.length > 0} onChange={selectAllForPrint} className="rounded" />
                Select all
              </label>
              {selectedForPrint.size > 0 && (
                <button onClick={() => setShowBulkPrint(true)} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700">
                  Print {selectedForPrint.size} QR Sticker{selectedForPrint.size !== 1 ? "s" : ""}
                </button>
              )}
            </div>
          )}
          <div className="space-y-3">
            {registered.length === 0 ? (
              <p className="text-gray-500 text-sm py-10 text-center">No registered devices</p>
            ) : registered.map((d) => {
              const devActive = d.isActive !== false;
              return (
                <div key={d.deviceCode} className={`bg-white rounded-xl border p-4 ${devActive ? "border-gray-200" : "border-red-200 bg-red-50"}`}>
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={selectedForPrint.has(d.deviceCode)} onChange={() => togglePrintSelect(d.deviceCode)} className="rounded" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm">{d.deviceName || d.deviceCode}</p>
                        {!devActive && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Inactive</span>}
                      </div>
                      <p className="font-mono text-xs text-gray-400">{d.deviceCode}</p>
                      <p className="text-xs text-gray-500">{DEVICE_CLASS[d.deviceClass] || "?"} | {SENSOR_TYPE[d.sensorType] || "?"} | {d.sensorCount || 0} sensors</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => openDeviceViewer(d.deviceCode)} className="px-3 py-1.5 bg-cyan-50 text-cyan-700 rounded-lg text-xs hover:bg-cyan-100">View</button>
                      <button onClick={() => sendTestCommand(d.deviceCode)} className="px-3 py-1.5 bg-green-50 text-green-600 rounded-lg text-xs hover:bg-green-100">Test</button>
                      <button onClick={() => sendRestartCommand(d.deviceCode)} className="px-3 py-1.5 bg-yellow-50 text-yellow-600 rounded-lg text-xs hover:bg-yellow-100">Restart</button>
                      <button onClick={() => setQrDevice(d.deviceCode)} className="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100">QR</button>
                      <button onClick={() => handleToggleDeviceActive(d.deviceCode, d.isActive)}
                        className={`px-3 py-1.5 rounded-lg text-xs ${devActive ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-green-50 text-green-600 hover:bg-green-100"}`}>
                        {devActive ? "Deactivate" : "Activate"}
                      </button>
                      <button onClick={() => handleDeleteDevice(d.deviceCode)}
                        className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs hover:bg-red-100">
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
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
              <input type="text" placeholder="Device Name" value={extraFields.deviceName} onChange={(e) => setExtraFields({ ...extraFields, deviceName: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              <input type="text" placeholder="Location" value={extraFields.location} onChange={(e) => setExtraFields({ ...extraFields, location: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              <textarea placeholder="Notes" value={extraFields.notes} onChange={(e) => setExtraFields({ ...extraFields, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" rows={2} />
            </div>
            <div className="flex gap-2">
              <button onClick={() => handleApprove(registerModal.deviceCode)} className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium">Approve & Register</button>
              <button onClick={() => setRegisterModal(null)} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal */}
      {qrDevice && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setQrDevice(null)}>
          <div className="bg-white rounded-xl p-6 text-center w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">Device QR Code</h3>
            {(() => { const d = registered.find((x) => x.deviceCode === qrDevice); return d?.deviceName ? <p className="text-sm text-gray-600 mb-1">{d.deviceName}</p> : null; })()}
            <p className="font-mono text-sm text-gray-500 mb-4">{qrDevice}</p>
            <div id="qr-print-single" className="inline-block bg-white p-4 border border-gray-200 rounded-lg mb-4">
              <QRCodeSVG value={subscribeUrl(qrDevice)} size={180} />
              <p className="font-mono text-xs mt-2 text-gray-700">{qrDevice}</p>
              {(() => { const d = registered.find((x) => x.deviceCode === qrDevice); return d?.deviceName ? <p className="text-xs text-gray-500">{d.deviceName}</p> : null; })()}
            </div>
            <div className="flex gap-2">
              <button onClick={() => {
                const c = document.getElementById("qr-print-single");
                const w = window.open("", "_blank");
                w.document.write("<html><head><title>QR</title><style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:monospace}div{text-align:center}</style></head><body>" + c.innerHTML + "</body></html>");
                w.document.close(); w.print();
              }} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium">Print Sticker</button>
              <button onClick={() => setQrDevice(null)} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Device Live Viewer Modal */}
      {viewDevice && (() => {
        const cat = registered.find(d => d.deviceCode === viewDevice) || {};
        const isOnline = viewInfo?.online === true;
        const VALVE_STATES = ["Recovery", "Opening", "Open", "Closing", "Closed", "Fault", "LS Error"];
        const valveState = viewLive?.valveState;
        const flags = viewLive?.flags ?? 0;
        const autoMode = !!(flags & 0x10);
        const sensorError = !!(flags & 0x01);
        const faultRetrying = !!(flags & 0x02);
        const ts = viewLive?.timestamp ? new Date(viewLive.timestamp).toLocaleString() : "No data";

        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={closeDeviceViewer}>
            <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-bold text-lg">{cat.deviceName || viewDevice}</h3>
                  <p className="font-mono text-xs text-gray-400">{viewDevice}</p>
                </div>
                <span className={`flex items-center gap-1.5 text-xs ${isOnline ? "text-green-600" : "text-gray-400"}`}>
                  <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-green-500" : "bg-gray-300"}`} />
                  {isOnline ? "Online" : "Offline"}
                </span>
              </div>

              {!viewLive ? (
                <p className="text-gray-400 text-sm text-center py-6">Waiting for live data...</p>
              ) : (
                <div className="space-y-3">
                  {/* Device Info */}
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 font-semibold mb-2">Device Info</p>
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      <span className="text-gray-500">Class</span>
                      <span className="text-gray-900">{DEVICE_CLASS[cat.deviceClass] || "?"}</span>
                      <span className="text-gray-500">Sensor</span>
                      <span className="text-gray-900">{SENSOR_TYPE[cat.sensorType] || "?"} ({cat.sensorCount || 0})</span>
                      <span className="text-gray-500">Firmware</span>
                      <span className="text-gray-900">{viewInfo?.firmwareVersion || cat.firmwareVersion || "?"}</span>
                      <span className="text-gray-500">RSSI</span>
                      <span className="text-gray-900">{viewLive.rssi ? `${viewLive.rssi} dBm` : "N/A"}</span>
                      <span className="text-gray-500">Last Update</span>
                      <span className="text-gray-900">{ts}</span>
                    </div>
                  </div>

                  {/* Tank Level — for sensor/valve with sensors */}
                  {(cat.sensorCount > 0 || cat.sensorType > 0) && (
                    <div className="bg-blue-50 rounded-lg p-3 text-center">
                      <p className="text-xs text-blue-600 font-semibold mb-1">Water Level</p>
                      <p className="text-3xl font-bold text-blue-700">
                        {sensorError ? "ERR" : cat.sensorCount === 1 ? (viewLive.confirmedPct > 0 ? "Present" : "Empty") : `${viewLive.confirmedPct}%`}
                      </p>
                      {sensorError && <p className="text-xs text-purple-600 mt-1">Sensor Error</p>}
                      <div className="flex justify-center gap-1 mt-2">
                        {Array.from({ length: cat.sensorCount || 0 }, (_, i) => (
                          <div key={i} className={`w-3 h-3 rounded-full ${(viewLive.sensorBits >> i) & 1 ? "bg-blue-500" : "bg-gray-200"}`} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Valve State — for valve devices */}
                  {cat.deviceClass === 1 && valveState != null && (
                    <div className={`rounded-lg p-3 text-center ${valveState === 5 || valveState === 6 ? "bg-red-50" : valveState === 2 ? "bg-green-50" : valveState === 4 ? "bg-gray-50" : "bg-blue-50"}`}>
                      <p className="text-xs text-gray-600 font-semibold mb-1">Valve</p>
                      <p className={`text-2xl font-bold ${
                        valveState === 2 ? "text-green-600" :
                        valveState === 4 ? "text-red-600" :
                        valveState === 5 ? "text-red-700" :
                        valveState === 6 ? "text-purple-600" :
                        "text-blue-600"
                      }`}>
                        {VALVE_STATES[valveState] || "Unknown"}
                      </p>
                      {autoMode && <p className="text-xs text-blue-600 mt-1">Auto Mode ON</p>}
                      {valveState === 5 && <p className="text-xs text-red-600 mt-1">{faultRetrying ? "Retrying..." : "Waiting for retry"}</p>}
                    </div>
                  )}

                  {/* Flags */}
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 font-semibold mb-1">Flags: 0x{flags.toString(16).toUpperCase().padStart(2, "0")}</p>
                    <div className="flex flex-wrap gap-1">
                      {sensorError && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">Sensor Error</span>}
                      {faultRetrying && <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">Fault Retrying</span>}
                      {!!(flags & 0x04) && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Relay FWD</span>}
                      {!!(flags & 0x08) && <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded">Relay REV</span>}
                      {autoMode && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">Auto Mode</span>}
                      {flags === 0 && <span className="text-[10px] text-gray-400">None</span>}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-2 mt-4">
                <button onClick={() => { sendTestCommand(viewDevice); }} className="flex-1 bg-green-50 text-green-600 py-2 rounded-lg text-sm hover:bg-green-100">Test LED</button>
                <button onClick={() => { sendRestartCommand(viewDevice); }} className="flex-1 bg-yellow-50 text-yellow-600 py-2 rounded-lg text-sm hover:bg-yellow-100">Restart</button>
                <button onClick={closeDeviceViewer} className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-lg text-sm">Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Bulk QR Print */}
      {showBulkPrint && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowBulkPrint(false)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">Print QR Stickers ({selectedForPrint.size})</h3>
              <div className="flex gap-2">
                <button onClick={() => {
                  const c = document.getElementById("qr-print-bulk");
                  const w = window.open("", "_blank");
                  w.document.write("<html><head><title>QR Stickers</title><style>body{margin:0;padding:10mm;font-family:monospace}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm}.sticker{border:1px solid #ccc;padding:4mm;text-align:center;page-break-inside:avoid;border-radius:2mm}.sticker svg{display:block;margin:0 auto 2mm}.code{font-size:9px;font-weight:bold;margin-top:2mm}.name{font-size:8px;color:#666}</style></head><body>" + c.innerHTML + "</body></html>");
                  w.document.close(); setTimeout(() => w.print(), 300);
                }} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium">Print All</button>
                <button onClick={() => setShowBulkPrint(false)} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">Close</button>
              </div>
            </div>
            <div id="qr-print-bulk" className="grid grid-cols-3 gap-4">
              {registered.filter((d) => selectedForPrint.has(d.deviceCode)).map((d) => (
                <div key={d.deviceCode} className="border border-gray-200 rounded-lg p-3 text-center">
                  <QRCodeSVG value={subscribeUrl(d.deviceCode)} size={120} />
                  <p className="font-mono text-xs font-bold mt-2">{d.deviceCode}</p>
                  {d.deviceName && <p className="text-xs text-gray-500">{d.deviceName}</p>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
