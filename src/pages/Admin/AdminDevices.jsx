import { useState, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { getAllDevices, approvePendingDevice, registerDevice, updateDevice, deleteDeviceFromCatalog, getAllUsers, getAllOrgs } from "../../firebase/db";
import { sendTestCommand, sendRestartCommand, getPendingDevicesRTDB, listenToDeviceLive, listenToDeviceInfo, listenToValveConfig, setAnalyticsEnabled, setDiagnosticsEnabled, setNotifyEnabled, bulkSetConfigFlag, getDevicesInfoMap, getDevicesConfigMap, deleteHistoryOlderThan } from "../../firebase/rtdb";
import { QRCodeSVG } from "qrcode.react";

const DEVICE_CLASS = { 1: "Valve", 2: "Sensor", 3: "Motor", "senseflowstandard": "SenseFlow Standard" };
const SENSOR_TYPE = { 0: "None", 1: "DIP", 2: "Ultrasonic" };

export default function AdminDevices() {
  const [searchParams] = useSearchParams();
  const [pending, setPending] = useState([]);
  const [registered, setRegistered] = useState([]);
  const [loading, setLoading] = useState(true);
  // Default tab driven by ?tab= URL param. Lets the AdminDashboard cards
  // open the page already focused on the right list. Falls back to
  // "registered" because that's what 90% of the time the admin wants to see.
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t === "pending" || t === "registered" ? t : "registered";
  });
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

  // QR sticker print settings. Persisted in localStorage per browser so
  // the admin's chosen sticker size + layout stick across sessions and
  // never round-trip through Firebase. Default 50×30 mm thermal (per
  // Vishal's spec). Settings UI lives inside both single + bulk modals.
  const QR_PRINT_PRESETS = [
    { id: "50x30",  label: "50 × 30 mm (thermal)", widthMm: 50, heightMm: 30 },
    { id: "40x25",  label: "40 × 25 mm",           widthMm: 40, heightMm: 25 },
    { id: "70x40",  label: "70 × 40 mm",           widthMm: 70, heightMm: 40 },
    { id: "100x50", label: "100 × 50 mm",          widthMm: 100, heightMm: 50 },
    { id: "custom", label: "Custom…",              widthMm: 0,  heightMm: 0  },
  ];
  const [qrPrintSettings, setQrPrintSettings] = useState(() => {
    try {
      const saved = localStorage.getItem("qrPrintSettings");
      if (saved) return JSON.parse(saved);
    } catch { /* corrupt — fall through */ }
    return {
      preset:    "50x30",
      widthMm:   50,
      heightMm:  30,
      layout:    "thermal",   // "thermal" = one per page, "grid" = many per A4
      gridCols:  3,
    };
  });
  useEffect(() => {
    try { localStorage.setItem("qrPrintSettings", JSON.stringify(qrPrintSettings)); }
    catch { /* quota / private mode — non-fatal */ }
  }, [qrPrintSettings]);

  // Resolve the effective width/height in mm. Preset wins unless "custom".
  function resolveStickerDims(s = qrPrintSettings) {
    if (s.preset === "custom") {
      return { widthMm: Math.max(15, Number(s.widthMm) || 50), heightMm: Math.max(10, Number(s.heightMm) || 30) };
    }
    const p = QR_PRINT_PRESETS.find((x) => x.id === s.preset);
    return p ? { widthMm: p.widthMm, heightMm: p.heightMm } : { widthMm: 50, heightMm: 30 };
  }

  // Decide which text fits at this sticker size. Q3 = Option C:
  //   small  → code only
  //   large  → code + device name
  // Threshold tuned to 50×30 = small (matches the customer's roll), and
  // 70×40+ = large enough for the name.
  function showNameOnSticker(widthMm, heightMm) {
    return widthMm * heightMm >= 70 * 40;
  }

  // Build the printable HTML document. Returns full <html>…</html> string
  // that we drop into a new window. Stickers data is [{ url, code, name }].
  // Layout "thermal" = @page sized to sticker, one per page. Layout "grid"
  // = A4 portrait, N columns from settings, page-break-inside avoided.
  function buildPrintHtml(stickers, settings) {
    const { widthMm, heightMm } = resolveStickerDims(settings);
    const includeName = showNameOnSticker(widthMm, heightMm);
    // QR fills the height minus a small text strip + padding.
    // Reserve ~6 mm for the code line (and another ~4 mm for name if shown).
    const textStripMm = includeName ? 10 : 6;
    const qrSizeMm = Math.max(10, Math.min(widthMm - 4, heightMm - textStripMm - 2));

    const pageRule = settings.layout === "thermal"
      ? `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`
      : `@page { size: A4; margin: 8mm; }`;

    const stickerCss = settings.layout === "thermal"
      ? `.sticker { width: ${widthMm}mm; height: ${heightMm}mm; padding: 1mm; page-break-after: always; }
         .grid { display: block; }`
      : `.sticker { width: ${widthMm}mm; height: ${heightMm}mm; padding: 1mm; page-break-inside: avoid; }
         .grid { display: grid; grid-template-columns: repeat(${Math.max(1, Number(settings.gridCols) || 3)}, ${widthMm}mm); gap: 3mm; }`;

    const stickersHtml = stickers.map((s) => `
      <div class="sticker">
        <div class="qr-wrap">${s.svg}</div>
        <div class="code">${escapeHtml(s.code)}</div>
        ${includeName && s.name ? `<div class="name">${escapeHtml(s.name)}</div>` : ""}
      </div>
    `).join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR Stickers</title>
      <style>
        ${pageRule}
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; }
        ${stickerCss}
        .sticker { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; overflow: hidden; }
        .qr-wrap { display: flex; align-items: center; justify-content: center; }
        .qr-wrap svg { display: block; width: ${qrSizeMm}mm; height: ${qrSizeMm}mm; }
        .code { font-family: 'Courier New', monospace; font-weight: 700; font-size: ${includeName ? "2.2mm" : "2.6mm"}; margin-top: 0.8mm; letter-spacing: 0.1mm; }
        .name { font-size: 2mm; color: #555; margin-top: 0.4mm; max-width: ${widthMm - 4}mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      </style></head>
      <body><div class="grid">${stickersHtml}</div>
      <script>window.addEventListener('load', () => setTimeout(() => window.print(), 150));<\/script>
      </body></html>`;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Pull the QR SVG markup for a given device from the live React DOM
  // (qrcode.react renders SVG, we just grab its outerHTML). Returns ""
  // if not yet rendered.
  function grabQrSvg(containerId, deviceCode) {
    const root = document.getElementById(containerId);
    if (!root) return "";
    // Each sticker block has a data-code attribute we use to find its SVG.
    const block = root.querySelector(`[data-code="${deviceCode}"]`);
    const svg = block ? block.querySelector("svg") : root.querySelector("svg");
    return svg ? svg.outerHTML : "";
  }

  function printStickers(stickers) {
    const html = buildPrintHtml(stickers, qrPrintSettings);
    const w = window.open("", "_blank");
    if (!w) { alert("Pop-up blocked — please allow pop-ups for this site."); return; }
    w.document.write(html);
    w.document.close();
  }

  // Registered-tab filter bar (same UX as /admin/firmware — admin already
  // knows the pattern there). Lets admin slice the list before bulk-
  // toggling flags, e.g. "all sensor devices on 17.0.9 with diagnostics
  // OFF" → enable in one click.
  const [infoMap, setInfoMap]               = useState({});
  const [configMap, setConfigMap]           = useState({});
  const [usersMap, setUsersMap]             = useState({});       // uid -> user doc (name, orgId, role)
  const [orgsMap, setOrgsMap]               = useState({});       // orgId -> org doc (name)
  const [filterClass, setFilterClass]       = useState("all");
  const [filterFirmware, setFilterFirmware] = useState("");
  const [filterStatus, setFilterStatus]     = useState("all");    // all/online/offline
  const [filterDiag, setFilterDiag]         = useState("all");    // all/on/off
  const [filterNotify, setFilterNotify]     = useState("all");    // all/on/off
  const [filterOwnerType, setFilterOwnerType] = useState("all");  // all/individual/group
  const [filterOrg, setFilterOrg]           = useState("all");    // all / specific orgId
  const [filterOwner, setFilterOwner]       = useState("");       // free-text owner name/email
  const [filterSearch, setFilterSearch]     = useState("");
  const [showFilters, setShowFilters]       = useState(false);    // collapsed by default

  // Bulk config flag toggle (diagnostics / premium notifications / analytics).
  // Each feature has explicit ON / OFF buttons so admin can't pick the wrong
  // verb by accident. Clicking any button confirms the device count before
  // firing — single batched RTDB write under the hood.
  const [bulkBusy, setBulkBusy] = useState(null);   // string key of in-flight op

  // Bulk history cleanup. History is a paid feature — admin (only) can
  // trim long-running devices' /history nodes to keep RTDB lean. Dropdown
  // chooses an age threshold; "custom" reveals a free-text day count.
  // Runs sequentially across the selection so a 32-device sweep is
  // observable rather than freezing the page.
  const HISTORY_CUTOFF_OPTIONS = [
    { value: "7",      label: "Older than 7 days" },
    { value: "15",     label: "Older than 15 days" },
    { value: "30",     label: "Older than 30 days" },
    { value: "60",     label: "Older than 60 days" },
    { value: "90",     label: "Older than 90 days" },
    { value: "custom", label: "Custom (specify days)" },
  ];
  const [historyCutoffPick, setHistoryCutoffPick] = useState("30");
  const [historyCustomDays, setHistoryCustomDays] = useState("");
  const [historyProgress, setHistoryProgress]   = useState(null);   // { done, total } or null

  async function handleBulkDeleteHistory() {
    const codes = Array.from(selectedForPrint);
    if (codes.length === 0) return;

    let days;
    if (historyCutoffPick === "custom") {
      const n = parseInt(historyCustomDays, 10);
      if (!Number.isFinite(n) || n < 1) {
        alert("Enter a valid number of days (must be 1 or more).");
        return;
      }
      days = n;
    } else {
      days = parseInt(historyCutoffPick, 10);
    }
    const cutoffTs = Date.now() - days * 24 * 60 * 60 * 1000;
    if (!confirm(
      `Delete history older than ${days} day${days !== 1 ? "s" : ""} on ${codes.length} device${codes.length !== 1 ? "s" : ""}?\n\n` +
      `This permanently removes /history entries with ts < ${new Date(cutoffTs).toLocaleString()}.\n` +
      `Recent history, live state, and config are NOT touched.\n\n` +
      `This cannot be undone.`
    )) return;

    setHistoryProgress({ done: 0, total: codes.length });
    let totalDeleted = 0;
    let failed = 0;
    // Sequential — keep RTDB calls polite, give admin live progress.
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      try {
        const n = await deleteHistoryOlderThan(code, cutoffTs);
        totalDeleted += n;
      } catch (e) {
        failed++;
        console.error(`History cleanup failed for ${code}:`, e);
      }
      setHistoryProgress({ done: i + 1, total: codes.length });
    }
    setHistoryProgress(null);
    alert(
      `History cleanup complete.\n\n` +
      `Devices processed: ${codes.length}\n` +
      `Total entries deleted: ${totalDeleted}\n` +
      (failed > 0 ? `Failed devices: ${failed} (see browser console)` : "")
    );
  }
  async function applyBulkFlag(flag, enable) {
    const codes = Array.from(selectedForPrint);
    if (codes.length === 0) return;
    const label =
      flag === "diagnosticsOn" ? "Diagnostics" :
      flag === "notifyOn"      ? "Premium notifications" :
      flag === "analyticsOn"   ? "Analytics" : flag;
    const verb = enable ? "Enable" : "Disable";
    if (!confirm(`${verb} ${label} on ${codes.length} device${codes.length !== 1 ? "s" : ""}?`)) return;
    const opKey = `${flag}:${enable ? "on" : "off"}`;
    setBulkBusy(opKey);
    try {
      await bulkSetConfigFlag(codes, flag, enable);
      // Optimistically reflect the change in the local configMap so the
      // filter bar updates without waiting for the next page load.
      setConfigMap((prev) => {
        const next = { ...prev };
        codes.forEach((c) => { next[c] = { ...(next[c] || {}), [flag]: enable }; });
        return next;
      });
      alert(`${label} ${enable ? "enabled" : "disabled"} on ${codes.length} device(s).`);
    } catch (e) {
      alert("Bulk update failed: " + e.message);
    } finally {
      setBulkBusy(null);
    }
  }

  // Device live viewer
  const [viewDevice, setViewDevice] = useState(null);  // device code being viewed
  const [viewLive, setViewLive] = useState(null);
  const [viewInfo, setViewInfo] = useState(null);
  const [viewConfig, setViewConfig] = useState(null);
  const viewUnsubRef = useRef([]);

  async function load() {
    const [p, r] = await Promise.all([getPendingDevicesRTDB(), getAllDevices()]);
    // Filter out pending devices that are already registered in catalog
    const registeredCodes = new Set(r.map(d => d.deviceCode));
    setPending(p.filter(d => !registeredCodes.has(d.deviceCode)));
    setRegistered(r);
    setLoading(false);
    // Background-load info + config + users + orgs maps for the filter bar.
    // Don't block initial render on these — filters degrade gracefully if
    // any map is empty (it just won't filter by that dimension until data lands).
    const codes = r.map((d) => d.deviceCode);
    Promise.all([
      getDevicesInfoMap(codes),
      getDevicesConfigMap(codes),
      getAllUsers(),
      getAllOrgs(),
    ]).then(([info, cfg, users, orgs]) => {
      setInfoMap(info);
      setConfigMap(cfg);
      // Index users + orgs by id for O(1) lookup per device when filtering.
      const uMap = {}; users.forEach((u) => { uMap[u.uid] = u; });
      const oMap = {}; orgs.forEach((o)  => { oMap[o.orgId] = o; });
      setUsersMap(uMap);
      setOrgsMap(oMap);
    }).catch(() => { /* non-fatal, filter just lacks live data */ });
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
    setSelectedForPrint(selectedForPrint.size === filteredRegistered.length ? new Set() : new Set(filteredRegistered.map((d) => d.deviceCode)));
  }

  // Helper — pull owner info for a device. Devices store ownerUid; we look
  // up the user, then their org if any. Returns null for unowned/orphan devices.
  function ownerInfoFor(device) {
    const owner = usersMap[device.ownerUid];
    if (!owner) return null;
    const org = owner.orgId ? orgsMap[owner.orgId] : null;
    return {
      uid:      owner.uid,
      name:     owner.displayName || owner.email || owner.uid,
      email:    owner.email || "",
      orgId:    owner.orgId || null,
      orgName:  org ? (org.name || org.orgId) : null,
      // Treat anyone with an orgId as "group", everyone else as "individual".
      // Matches your existing user model: registerWithEmail sets role:individual
      // when there's no org and orgId:null.
      type:     owner.orgId ? "group" : "individual",
    };
  }

  // Same online definition Dashboard uses: device's /info/online flag is
  // true AND its lastSeen heartbeat is fresh (< 15 min old). Without the
  // staleness gate the filter would mark devices online forever based on
  // the last successful boot, even after they fell off the network — so
  // "Online" matched a different set than the dashboard's green dot.
  const STALE_MS = 15 * 60 * 1000;
  function isDeviceOnline(info) {
    if (!info?.online) return false;
    const lastSeen = info.lastSeen;
    if (!lastSeen) return false;
    return Date.now() - lastSeen <= STALE_MS;
  }

  // Apply the filter bar to the registered list. Each filter is independent
  // and skipped when set to "all" / empty.
  const filteredRegistered = useMemo(() => {
    return registered.filter((d) => {
      const info  = infoMap[d.deviceCode] || {};
      const cfg   = configMap[d.deviceCode] || {};
      const owner = ownerInfoFor(d);
      const online = isDeviceOnline(info);

      if (filterClass !== "all" && String(d.deviceClass) !== filterClass) return false;
      if (filterFirmware && !String(info.firmwareVersion || "").toLowerCase().includes(filterFirmware.toLowerCase())) return false;
      if (filterStatus === "online"  && !online) return false;
      if (filterStatus === "offline" &&  online) return false;
      if (filterDiag   === "on"  && !cfg.diagnosticsOn) return false;
      if (filterDiag   === "off" &&  cfg.diagnosticsOn) return false;
      if (filterNotify === "on"  && !cfg.notifyOn) return false;
      if (filterNotify === "off" &&  cfg.notifyOn) return false;

      // Owner-type filter — group customers vs individual buyers.
      if (filterOwnerType === "individual" && (!owner || owner.type !== "individual")) return false;
      if (filterOwnerType === "group"      && (!owner || owner.type !== "group"))      return false;

      // Specific org filter — used to onboard one customer's whole fleet.
      if (filterOrg !== "all" && (!owner || owner.orgId !== filterOrg)) return false;

      // Free-text owner search — matches user name, email, or org name.
      if (filterOwner) {
        const t = filterOwner.toLowerCase();
        const blob = owner
          ? `${owner.name} ${owner.email} ${owner.orgName || ""}`.toLowerCase()
          : "";
        if (!blob.includes(t)) return false;
      }

      if (filterSearch) {
        const t = filterSearch.toLowerCase();
        const blob = `${d.deviceCode} ${d.deviceName || ""} ${d.location || ""}`.toLowerCase();
        if (!blob.includes(t)) return false;
      }
      return true;
    });
  }, [registered, infoMap, configMap, usersMap, orgsMap, filterClass, filterFirmware, filterStatus, filterDiag, filterNotify, filterOwnerType, filterOrg, filterOwner, filterSearch]);

  // Drop selections that no longer match the active filter so the bulk
  // "Apply to N" count stays honest. Without this, admin could narrow the
  // filter and still have stale codes hidden from view but counted.
  useEffect(() => {
    setSelectedForPrint((prev) => {
      const visible = new Set(filteredRegistered.map((d) => d.deviceCode));
      const next = new Set();
      prev.forEach((c) => { if (visible.has(c)) next.add(c); });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredRegistered]);

  // Distinct firmware versions seen across the fleet (for the datalist).
  const firmwareVersionOptions = useMemo(() => {
    const set = new Set();
    Object.values(infoMap).forEach((info) => { if (info?.firmwareVersion) set.add(info.firmwareVersion); });
    return Array.from(set).sort();
  }, [infoMap]);

  const activeFilterCount =
    (filterClass     !== "all" ? 1 : 0) +
    (filterStatus    !== "all" ? 1 : 0) +
    (filterDiag      !== "all" ? 1 : 0) +
    (filterNotify    !== "all" ? 1 : 0) +
    (filterOwnerType !== "all" ? 1 : 0) +
    (filterOrg       !== "all" ? 1 : 0) +
    (filterFirmware ? 1 : 0) +
    (filterOwner    ? 1 : 0) +
    (filterSearch   ? 1 : 0);

  function clearAllFilters() {
    setFilterClass("all");
    setFilterFirmware("");
    setFilterStatus("all");
    setFilterDiag("all");
    setFilterNotify("all");
    setFilterOwnerType("all");
    setFilterOrg("all");
    setFilterOwner("");
    setFilterSearch("");
  }

  function openDeviceViewer(code) {
    // Clean up previous listeners
    viewUnsubRef.current.forEach(u => u());
    viewUnsubRef.current = [];
    setViewLive(null);
    setViewInfo(null);
    setViewConfig(null);
    setViewDevice(code);
    // Attach live listeners
    const unLive = listenToDeviceLive(code, (data) => setViewLive(data));
    const unInfo = listenToDeviceInfo(code, (data) => setViewInfo(data));
    const unConfig = listenToValveConfig(code, (data) => setViewConfig(data));
    viewUnsubRef.current = [unLive, unInfo, unConfig];
  }

  function closeDeviceViewer() {
    viewUnsubRef.current.forEach(u => u());
    viewUnsubRef.current = [];
    setViewDevice(null);
    setViewLive(null);
    setViewInfo(null);
    setViewConfig(null);
  }

  const subscribeUrl = (code) => `${window.location.origin}/subscribe?code=${code}`;

  // Sticker preset + layout chooser shared between the single QR modal
  // and the bulk print modal. Reads/writes the parent qrPrintSettings
  // state — defined inline (not extracted) so the localStorage-persisted
  // settings stay in one place and the panel re-renders with current
  // values whenever either modal opens.
  function StickerSettingsPanel() {
    const dims = resolveStickerDims(qrPrintSettings);
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4 text-left">
        <div className="text-xs font-semibold text-gray-700 mb-2">Sticker settings (saved on this browser)</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col">
            <span className="text-gray-500 mb-0.5">Size</span>
            <select
              value={qrPrintSettings.preset}
              onChange={(e) => setQrPrintSettings({ ...qrPrintSettings, preset: e.target.value })}
              className="border rounded px-2 py-1 bg-white"
            >
              {QR_PRINT_PRESETS.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-gray-500 mb-0.5">Layout</span>
            <select
              value={qrPrintSettings.layout}
              onChange={(e) => setQrPrintSettings({ ...qrPrintSettings, layout: e.target.value })}
              className="border rounded px-2 py-1 bg-white"
            >
              <option value="thermal">Thermal roll (one per page)</option>
              <option value="grid">A4 grid (many per sheet)</option>
            </select>
          </label>
          {qrPrintSettings.preset === "custom" && (
            <>
              <label className="flex flex-col">
                <span className="text-gray-500 mb-0.5">Width (mm)</span>
                <input type="number" min="15" max="200" value={qrPrintSettings.widthMm}
                  onChange={(e) => setQrPrintSettings({ ...qrPrintSettings, widthMm: Number(e.target.value) })}
                  className="border rounded px-2 py-1" />
              </label>
              <label className="flex flex-col">
                <span className="text-gray-500 mb-0.5">Height (mm)</span>
                <input type="number" min="10" max="200" value={qrPrintSettings.heightMm}
                  onChange={(e) => setQrPrintSettings({ ...qrPrintSettings, heightMm: Number(e.target.value) })}
                  className="border rounded px-2 py-1" />
              </label>
            </>
          )}
          {qrPrintSettings.layout === "grid" && (
            <label className="flex flex-col">
              <span className="text-gray-500 mb-0.5">Columns on A4</span>
              <input type="number" min="1" max="8" value={qrPrintSettings.gridCols}
                onChange={(e) => setQrPrintSettings({ ...qrPrintSettings, gridCols: Number(e.target.value) })}
                className="border rounded px-2 py-1" />
            </label>
          )}
        </div>
        <div className="text-[10px] text-gray-500 mt-2">
          Effective sticker: <strong>{dims.widthMm} × {dims.heightMm} mm</strong> ·
          {" "}{showNameOnSticker(dims.widthMm, dims.heightMm) ? "code + name" : "code only (size too small for name)"} ·
          {" "}{qrPrintSettings.layout === "thermal" ? "one sticker per page" : "A4 grid"}
        </div>
      </div>
    );
  }

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
          {/* Filter bar — collapsed by default, same UX as /admin/firmware.
              Lets admin narrow the list before bulk-toggling Diagnostics or
              Premium for a batch (e.g. "all sensor devices on 17.0.9 with
              diagnostics OFF" → 1 click). */}
          {registered.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-3">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-700">Filters</span>
                  {activeFilterCount > 0 && (
                    <span className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                      {activeFilterCount} active
                    </span>
                  )}
                  <span className="text-xs text-gray-500">
                    {filteredRegistered.length} of {registered.length} device{registered.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <span className="text-xs text-gray-400">{showFilters ? "Hide ▲" : "Show ▼"}</span>
              </button>
              {showFilters && (
                <div className="px-4 pb-4 border-t border-gray-100">
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 text-sm mt-3">
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Class</span>
                      <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)} className="border rounded px-2 py-1 text-sm">
                        <option value="all">All</option>
                        <option value="1">Valve</option>
                        <option value="2">Sensor</option>
                        <option value="3">Motor</option>
                      </select>
                    </label>
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Online status</span>
                      <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="border rounded px-2 py-1 text-sm">
                        <option value="all">All</option>
                        <option value="online">Online</option>
                        <option value="offline">Offline</option>
                      </select>
                    </label>
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Diagnostics</span>
                      <select value={filterDiag} onChange={(e) => setFilterDiag(e.target.value)} className="border rounded px-2 py-1 text-sm">
                        <option value="all">All</option>
                        <option value="on">ON</option>
                        <option value="off">OFF</option>
                      </select>
                    </label>
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Premium notifications</span>
                      <select value={filterNotify} onChange={(e) => setFilterNotify(e.target.value)} className="border rounded px-2 py-1 text-sm">
                        <option value="all">All</option>
                        <option value="on">ON</option>
                        <option value="off">OFF</option>
                      </select>
                    </label>
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Firmware version</span>
                      <input
                        list="reg-fw-versions"
                        value={filterFirmware}
                        onChange={(e) => setFilterFirmware(e.target.value)}
                        placeholder="e.g. 17.0.9"
                        className="border rounded px-2 py-1 text-sm"
                      />
                      <datalist id="reg-fw-versions">
                        {firmwareVersionOptions.map((v) => (<option key={v} value={v} />))}
                      </datalist>
                    </label>
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Owner type</span>
                      <select value={filterOwnerType} onChange={(e) => setFilterOwnerType(e.target.value)} className="border rounded px-2 py-1 text-sm">
                        <option value="all">All</option>
                        <option value="individual">Individual</option>
                        <option value="group">Group / Org</option>
                      </select>
                    </label>
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Organisation</span>
                      <select value={filterOrg} onChange={(e) => setFilterOrg(e.target.value)} className="border rounded px-2 py-1 text-sm">
                        <option value="all">All</option>
                        {Object.values(orgsMap).sort((a, b) => (a.name || a.orgId).localeCompare(b.name || b.orgId)).map((o) => (
                          <option key={o.orgId} value={o.orgId}>{o.name || o.orgId}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col">
                      <span className="text-xs text-gray-500 mb-1">Owner name / email</span>
                      <input
                        value={filterOwner}
                        onChange={(e) => setFilterOwner(e.target.value)}
                        placeholder="customer name or email"
                        className="border rounded px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="flex flex-col md:col-span-2 lg:col-span-2">
                      <span className="text-xs text-gray-500 mb-1">Search (code, device name, location)</span>
                      <input
                        value={filterSearch}
                        onChange={(e) => setFilterSearch(e.target.value)}
                        placeholder="SF-… or location"
                        className="border rounded px-2 py-1 text-sm"
                      />
                    </label>
                  </div>
                  {activeFilterCount > 0 && (
                    <button onClick={clearAllFilters} className="mt-3 text-xs text-blue-600 hover:underline">
                      Clear all filters
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {registered.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                  <input type="checkbox" checked={filteredRegistered.length > 0 && selectedForPrint.size === filteredRegistered.length} onChange={selectAllForPrint} className="rounded" />
                  Select all {activeFilterCount > 0 ? "filtered" : ""}
                </label>
                {selectedForPrint.size > 0 && (
                  <button onClick={() => setShowBulkPrint(true)} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700">
                    Print {selectedForPrint.size} QR Sticker{selectedForPrint.size !== 1 ? "s" : ""}
                  </button>
                )}
              </div>

              {/* Bulk actions panel — appears once at least one device is
                  selected. Three feature rows × ON/OFF buttons. Each click
                  confirms the count before firing. Same selection drives
                  any number of actions back-to-back. */}
              {selectedForPrint.size > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                  <div className="text-xs font-semibold text-blue-900 mb-2">
                    Bulk actions on {selectedForPrint.size} selected device{selectedForPrint.size !== 1 ? "s" : ""}
                  </div>
                  <div className="space-y-2">
                    {[
                      { flag: "diagnosticsOn", label: "Diagnostics",            hint: "Boot log + restart reasons. Admin-only." },
                      { flag: "notifyOn",      label: "Premium notifications",  hint: "Fires Cloud Function for paying customers." },
                      { flag: "analyticsOn",   label: "Analytics (history)",    hint: "Records change-driven history rows." },
                    ].map(({ flag, label, hint }) => (
                      <div key={flag} className="flex items-center justify-between bg-white rounded-lg px-3 py-2">
                        <div className="min-w-0 mr-3">
                          <div className="text-sm font-medium text-gray-900">{label}</div>
                          <div className="text-[10px] text-gray-500 truncate">{hint}</div>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <button
                            onClick={() => applyBulkFlag(flag, true)}
                            disabled={bulkBusy !== null}
                            className="px-3 py-1 text-xs font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-40"
                          >
                            {bulkBusy === `${flag}:on` ? "…" : "Enable"}
                          </button>
                          <button
                            onClick={() => applyBulkFlag(flag, false)}
                            disabled={bulkBusy !== null}
                            className="px-3 py-1 text-xs font-semibold rounded-lg bg-gray-500 text-white hover:bg-gray-600 disabled:opacity-40"
                          >
                            {bulkBusy === `${flag}:off` ? "…" : "Disable"}
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* History cleanup — destructive, kept visually distinct
                        from the on/off rows. Sequential delete with live
                        progress so admin sees activity rather than a frozen
                        screen during a large sweep. */}
                    <div className="bg-white rounded-lg px-3 py-2 border-t border-red-100">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900">History cleanup</div>
                          <div className="text-[10px] text-gray-500">
                            Permanently delete old /history entries. Keeps recent data, live state, and config.
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <select
                            value={historyCutoffPick}
                            onChange={(e) => setHistoryCutoffPick(e.target.value)}
                            disabled={historyProgress !== null}
                            className="text-xs border rounded px-2 py-1 bg-white"
                          >
                            {HISTORY_CUTOFF_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          {historyCutoffPick === "custom" && (
                            <input
                              type="number"
                              min="1"
                              value={historyCustomDays}
                              onChange={(e) => setHistoryCustomDays(e.target.value)}
                              placeholder="days"
                              disabled={historyProgress !== null}
                              className="text-xs border rounded px-2 py-1 w-20"
                            />
                          )}
                          <button
                            onClick={handleBulkDeleteHistory}
                            disabled={historyProgress !== null}
                            className="px-3 py-1 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
                          >
                            {historyProgress
                              ? `Cleaning ${historyProgress.done}/${historyProgress.total}…`
                              : "Delete"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="space-y-3">
            {registered.length === 0 ? (
              <p className="text-gray-500 text-sm py-10 text-center">No registered devices</p>
            ) : filteredRegistered.length === 0 ? (
              <p className="text-gray-500 text-sm py-10 text-center">
                No devices match the current filters. <button onClick={clearAllFilters} className="text-blue-600 hover:underline">Clear filters</button>
              </p>
            ) : filteredRegistered.map((d) => {
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
      {qrDevice && (() => {
        const d = registered.find((x) => x.deviceCode === qrDevice);
        return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setQrDevice(null)}>
          <div className="bg-white rounded-xl p-6 text-center w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">Device QR Code</h3>
            {d?.deviceName ? <p className="text-sm text-gray-600 mb-1">{d.deviceName}</p> : null}
            <p className="font-mono text-sm text-gray-500 mb-4">{qrDevice}</p>
            <div id="qr-print-single" className="inline-block bg-white p-4 border border-gray-200 rounded-lg mb-4">
              <div data-code={qrDevice}>
                <QRCodeSVG value={subscribeUrl(qrDevice)} size={180} />
              </div>
              <p className="font-mono text-xs mt-2 text-gray-700">{qrDevice}</p>
              {d?.deviceName ? <p className="text-xs text-gray-500">{d.deviceName}</p> : null}
            </div>
            <StickerSettingsPanel />
            <div className="flex gap-2">
              <button onClick={() => {
                const svg = grabQrSvg("qr-print-single", qrDevice);
                if (!svg) { alert("QR not rendered yet — try again."); return; }
                printStickers([{ svg, code: qrDevice, name: d?.deviceName }]);
              }} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium">Print Sticker</button>
              <button onClick={() => setQrDevice(null)} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">Close</button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Device Live Viewer Modal */}
      {viewDevice && (() => {
        const cat = registered.find(d => d.deviceCode === viewDevice) || {};
        const lastSeen = viewInfo?.lastSeen;
        const isStale = lastSeen ? (Date.now() - lastSeen) > 900000 : true;
        const isOnline = viewInfo?.online === true && !isStale;
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

              {/* Device config toggles */}
              <div className="space-y-2 mt-3">
                {/* Analytics — history tracking */}
                <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                  <div>
                    <div className="text-sm text-gray-700">Analytics</div>
                    <div className="text-[10px] text-gray-500">History/chart data writes to RTDB.</div>
                  </div>
                  <button
                    onClick={async () => {
                      await setAnalyticsEnabled(viewDevice, !viewConfig?.analyticsOn);
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      viewConfig?.analyticsOn
                        ? "bg-green-500 text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {viewConfig?.analyticsOn ? "ON" : "OFF"}
                  </button>
                </div>

                {/* Diagnostics — boot log (admin remote-debug, 17.0.9+) */}
                <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                  <div>
                    <div className="text-sm text-gray-700">Diagnostics</div>
                    <div className="text-[10px] text-gray-500">Boot log + restart reasons. Admin-only.</div>
                  </div>
                  <button
                    onClick={async () => {
                      await setDiagnosticsEnabled(viewDevice, !viewConfig?.diagnosticsOn);
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      viewConfig?.diagnosticsOn
                        ? "bg-blue-500 text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {viewConfig?.diagnosticsOn ? "ON" : "OFF"}
                  </button>
                </div>

                {/* Premium / Notifications gate (17.0.9+) */}
                <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                  <div>
                    <div className="text-sm text-gray-700">Premium notifications</div>
                    <div className="text-[10px] text-gray-500">Fires Cloud Function on changes. Paid feature.</div>
                  </div>
                  <button
                    onClick={async () => {
                      await setNotifyEnabled(viewDevice, !viewConfig?.notifyOn);
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      viewConfig?.notifyOn
                        ? "bg-purple-500 text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {viewConfig?.notifyOn ? "ON" : "OFF"}
                  </button>
                </div>
              </div>

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
                  const list = registered.filter((d) => selectedForPrint.has(d.deviceCode));
                  const stickers = list.map((d) => ({
                    svg: grabQrSvg("qr-print-bulk", d.deviceCode),
                    code: d.deviceCode,
                    name: d.deviceName,
                  })).filter((s) => s.svg);
                  if (stickers.length === 0) { alert("QRs not rendered yet — try again."); return; }
                  printStickers(stickers);
                }} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium">Print All</button>
                <button onClick={() => setShowBulkPrint(false)} className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">Close</button>
              </div>
            </div>
            <StickerSettingsPanel />
            <div id="qr-print-bulk" className="grid grid-cols-3 gap-4">
              {registered.filter((d) => selectedForPrint.has(d.deviceCode)).map((d) => (
                <div key={d.deviceCode} data-code={d.deviceCode} className="border border-gray-200 rounded-lg p-3 text-center">
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
