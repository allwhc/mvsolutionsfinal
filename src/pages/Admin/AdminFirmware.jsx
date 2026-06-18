import { useEffect, useMemo, useState } from "react";
import { getAllDevices } from "../../firebase/db";
import { getDevicesInfoMap, sendOtaTrigger, cancelOtaTrigger } from "../../firebase/rtdb";

// Helper: format epoch seconds → readable IST string
function fmtEpoch(epochSec) {
  if (!epochSec) return "—";
  const d = new Date(epochSec * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = String(d.getDate()).padStart(2, "0");
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${day}-${mon}-${year}, ${h}:${m}:${s} ${ampm}`;
}

function isDeviceOnline(info) {
  if (!info) return false;
  if (!info.online) return false;
  if (!info.lastSeen) return false;
  return Date.now() - info.lastSeen < 15 * 60 * 1000; // 15 min
}

function statusBadge(status, online) {
  if (!status) return <span className="text-gray-400">—</span>;
  const base = "text-xs px-2 py-0.5 rounded-full font-medium";
  if (status === "queued") return <span className={`${base} bg-gray-100 text-gray-700`}>Queued{!online && " (offline)"}</span>;
  if (status === "in_progress") return <span className={`${base} bg-yellow-100 text-yellow-700`}>In progress…</span>;
  if (status === "success") return <span className={`${base} bg-green-100 text-green-700`}>Success</span>;
  if (status.startsWith("fail")) return <span className={`${base} bg-red-100 text-red-700`}>{status}</span>;
  return <span className={base}>{status}</span>;
}

export default function AdminFirmware() {
  const [devices, setDevices] = useState([]);
  const [infoMap, setInfoMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [filterClass, setFilterClass] = useState("all");
  const [filterSensorType, setFilterSensorType] = useState("all");
  const [filterProbes, setFilterProbes] = useState("all");
  const [filterFirmware, setFilterFirmware] = useState("");
  const [filterGroup, setFilterGroup] = useState("");
  const [searchText, setSearchText] = useState("");

  // Selection
  const [selected, setSelected] = useState(new Set());

  // OTA form
  const [otaUrl, setOtaUrl] = useState("");
  const [otaVersion, setOtaVersion] = useState("");
  const [otaMd5, setOtaMd5] = useState("");
  const [verifyingUrl, setVerifyingUrl] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState(""); // "", "ok", "fail:<msg>"
  const [scheduleMode, setScheduleMode] = useState("now");
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [batchSize, setBatchSize] = useState(10);
  const [batchIntervalMin, setBatchIntervalMin] = useState(2);
  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);

  async function loadAll() {
    setRefreshing(true);
    const list = await getAllDevices();
    setDevices(list);
    const codes = list.map((d) => d.deviceCode);
    const map = await getDevicesInfoMap(codes);
    setInfoMap(map);
    setLoading(false);
    setRefreshing(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function loadMd5Lib() {
    if (window.md5) return window.md5;
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/js-md5@0.8.3/build/md5.min.js";
      s.onload = () => resolve(window.md5);
      s.onerror = () => reject(new Error("Failed to load MD5 library"));
      document.head.appendChild(s);
    });
  }

  async function handleVerifyUrl() {
    if (!otaUrl) return;
    setVerifyingUrl(true);
    setVerifyStatus("");
    setOtaMd5("");
    try {
      const md5fn = await loadMd5Lib();
      const resp = await fetch(otaUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 1000) throw new Error("File too small (<1 KB)");
      const hash = md5fn(new Uint8Array(buf));
      setOtaMd5(hash);
      setVerifyStatus(`ok:${Math.round(buf.byteLength / 1024)} KB`);
    } catch (e) {
      setVerifyStatus(`fail:${e.message}`);
    } finally {
      setVerifyingUrl(false);
    }
  }

  // Filtered list — also resets selection when filter changes
  const filtered = useMemo(() => {
    const out = devices.filter((d) => {
      const info = infoMap[d.deviceCode] || {};
      if (filterClass !== "all" && String(d.deviceClass) !== filterClass) return false;
      if (filterSensorType !== "all" && String(d.sensorType ?? info.sensorType) !== filterSensorType) return false;
      if (filterProbes !== "all" && String(d.sensorCount ?? info.sensorCount) !== filterProbes) return false;
      if (filterFirmware && !String(info.firmwareVersion || "").toLowerCase().includes(filterFirmware.toLowerCase())) return false;
      if (filterGroup && !String(d.groupId || "").toLowerCase().includes(filterGroup.toLowerCase())) return false;
      if (searchText) {
        const t = searchText.toLowerCase();
        const blob = `${d.deviceCode} ${d.deviceName || ""}`.toLowerCase();
        if (!blob.includes(t)) return false;
      }
      return true;
    });
    return out;
  }, [devices, infoMap, filterClass, filterSensorType, filterProbes, filterFirmware, filterGroup, searchText]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelected(new Set());
  }, [filterClass, filterSensorType, filterProbes, filterFirmware, filterGroup]);

  function toggleSelect(code) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }
  function selectAllFiltered() {
    setSelected(new Set(filtered.map((d) => d.deviceCode)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  function buildScheduledList() {
    const arr = Array.from(selected);
    let base;
    if (scheduleMode === "now") {
      base = Math.floor(Date.now() / 1000);
    } else {
      if (!scheduleDate || !scheduleTime) return null;
      const dt = new Date(`${scheduleDate}T${scheduleTime}:00`);
      base = Math.floor(dt.getTime() / 1000);
    }
    const intervalSec = (batchIntervalMin || 0) * 60;
    return arr.map((code, i) => {
      const batchIdx = Math.floor(i / Math.max(1, batchSize));
      return { deviceCode: code, scheduledAt: base + batchIdx * intervalSec };
    });
  }

  async function handleSend() {
    if (!otaUrl) {
      alert("URL is required");
      return;
    }
    if (selected.size === 0) {
      alert("Select at least one device");
      return;
    }
    setShowConfirm(true);
  }

  async function confirmSend() {
    const list = buildScheduledList();
    if (!list) {
      alert("Please pick a date and time for the schedule.");
      return;
    }
    setSending(true);
    try {
      await sendOtaTrigger({
        devicesWithSchedule: list,
        url: otaUrl,
        version: otaVersion,
        md5: otaMd5,
      });
      alert(`Trigger sent to ${list.length} device(s).`);
      setShowConfirm(false);
      setSelected(new Set());
      await loadAll();
    } catch (e) {
      alert("Failed to send trigger: " + e.message);
    } finally {
      setSending(false);
    }
  }

  async function handleCancel(deviceCode) {
    if (!window.confirm(`Cancel pending OTA for ${deviceCode}?`)) return;
    await cancelOtaTrigger(deviceCode);
    await loadAll();
  }

  // Unique filter options
  const firmwareVersions = useMemo(() => {
    const set = new Set();
    Object.values(infoMap).forEach((info) => {
      if (info?.firmwareVersion) set.add(info.firmwareVersion);
    });
    return Array.from(set).sort();
  }, [infoMap]);

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Firmware Updates (OTA)</h1>
        <button
          onClick={loadAll}
          disabled={refreshing}
          className="bg-gray-100 hover:bg-gray-200 text-sm px-3 py-1.5 rounded-lg font-medium disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Filters</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">Class</span>
            <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)} className="border rounded px-2 py-1">
              <option value="all">All</option>
              <option value="1">Valve</option>
              <option value="2">Sensor</option>
              <option value="3">Motor</option>
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">Sensor type</span>
            <select value={filterSensorType} onChange={(e) => setFilterSensorType(e.target.value)} className="border rounded px-2 py-1">
              <option value="all">All</option>
              <option value="1">DIP</option>
              <option value="2">Ultrasonic</option>
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">Probes</span>
            <select value={filterProbes} onChange={(e) => setFilterProbes(e.target.value)} className="border rounded px-2 py-1">
              <option value="all">All</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">Firmware version</span>
            <input
              list="firmware-versions"
              value={filterFirmware}
              onChange={(e) => setFilterFirmware(e.target.value)}
              placeholder="e.g. 17.0.0"
              className="border rounded px-2 py-1"
            />
            <datalist id="firmware-versions">
              {firmwareVersions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">Group ID</span>
            <input value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)} placeholder="group prefix" className="border rounded px-2 py-1" />
          </label>
          <label className="flex flex-col md:col-span-2">
            <span className="text-xs text-gray-500 mb-1">Search (code or name)</span>
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="SF-J5ZA…" className="border rounded px-2 py-1" />
          </label>
        </div>
      </div>

      {/* Device table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="flex items-center justify-between p-4 border-b">
          <div className="text-sm text-gray-600">
            <strong>{filtered.length}</strong> device(s) match · <strong>{selected.size}</strong> selected
          </div>
          <div className="flex gap-2 text-sm">
            <button onClick={selectAllFiltered} className="text-blue-600 hover:underline">Select all filtered</button>
            <button onClick={clearSelection} className="text-gray-500 hover:underline">Clear</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600">
              <tr>
                <th className="p-2 text-left">☑</th>
                <th className="p-2 text-left">Device</th>
                <th className="p-2 text-left">Online</th>
                <th className="p-2 text-left">Firmware</th>
                <th className="p-2 text-left">Last Updated</th>
                <th className="p-2 text-left">OTA Status</th>
                <th className="p-2 text-left">Retry</th>
                <th className="p-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => {
                const info = infoMap[d.deviceCode] || {};
                const online = isDeviceOnline(info);
                const isSel = selected.has(d.deviceCode);
                return (
                  <tr key={d.deviceCode} className="border-b hover:bg-gray-50">
                    <td className="p-2">
                      <input type="checkbox" checked={isSel} onChange={() => toggleSelect(d.deviceCode)} />
                    </td>
                    <td className="p-2">
                      <div className="font-medium">{d.deviceName || d.deviceCode}</div>
                      <div className="text-xs text-gray-500 font-mono">{d.deviceCode}</div>
                    </td>
                    <td className="p-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${online ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {online ? "Online" : "Offline"}
                      </span>
                    </td>
                    <td className="p-2 font-mono text-xs">{info.firmwareVersion || "—"}</td>
                    <td className="p-2 text-xs">{fmtEpoch(info.lastUpdatedAt)}</td>
                    <td className="p-2">{statusBadge(info.lastOtaStatus, online)}</td>
                    <td className="p-2 text-xs">{info.otaRetryCount ?? 0}/3</td>
                    <td className="p-2">
                      {info.lastOtaStatus && info.lastOtaStatus !== "success" && !info.lastOtaStatus.startsWith("fail:max") && (
                        <button onClick={() => handleCancel(d.deviceCode)} className="text-xs text-red-600 hover:underline">
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-gray-400">No devices match filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* OTA form */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Send OTA Update</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col md:col-span-2">
            <span className="text-xs text-gray-500 mb-1">Firmware URL (HTTP or HTTPS)</span>
            <div className="flex gap-2">
              <input
                value={otaUrl}
                onChange={(e) => { setOtaUrl(e.target.value); setOtaMd5(""); setVerifyStatus(""); }}
                placeholder="https://gitlab.com/.../firmware.bin"
                className="border rounded px-2 py-1.5 flex-1"
              />
              <button
                type="button"
                onClick={handleVerifyUrl}
                disabled={!otaUrl || verifyingUrl}
                className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded font-medium disabled:opacity-50"
              >
                {verifyingUrl ? "Verifying…" : "Verify + MD5"}
              </button>
            </div>
            {verifyStatus.startsWith("ok") && (
              <span className="text-xs text-green-700 mt-1">✓ Reachable ({verifyStatus.slice(3)}) — MD5 auto-filled</span>
            )}
            {verifyStatus.startsWith("fail") && (
              <span className="text-xs text-red-700 mt-1">✗ {verifyStatus.slice(5)} — you can still send without MD5</span>
            )}
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">Version label (optional)</span>
            <input value={otaVersion} onChange={(e) => setOtaVersion(e.target.value)} placeholder="e.g. 18.0.0" className="border rounded px-2 py-1.5" />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">MD5 {otaMd5 ? "(auto-filled — read-only)" : "(optional — click Verify above)"}</span>
            <input value={otaMd5} onChange={(e) => setOtaMd5(e.target.value)} placeholder="32-char hex" className="border rounded px-2 py-1.5 font-mono text-xs" readOnly={!!otaMd5} />
          </label>
          <div className="md:col-span-2 flex items-center gap-4 mt-2">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={scheduleMode === "now"} onChange={() => setScheduleMode("now")} />
              <span>Send now</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={scheduleMode === "scheduled"} onChange={() => setScheduleMode("scheduled")} />
              <span>Schedule for</span>
            </label>
            {scheduleMode === "scheduled" && (
              <>
                <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className="border rounded px-2 py-1" />
                <input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="border rounded px-2 py-1" />
              </>
            )}
          </div>
          {selected.size > 1 && (
            <>
              <label className="flex flex-col">
                <span className="text-xs text-gray-500 mb-1">Batch size</span>
                <input type="number" min="1" value={batchSize} onChange={(e) => setBatchSize(Math.max(1, +e.target.value))} className="border rounded px-2 py-1.5 w-24" />
              </label>
              <label className="flex flex-col">
                <span className="text-xs text-gray-500 mb-1">Batch interval (minutes)</span>
                <input type="number" min="0" value={batchIntervalMin} onChange={(e) => setBatchIntervalMin(Math.max(0, +e.target.value))} className="border rounded px-2 py-1.5 w-24" />
              </label>
            </>
          )}
        </div>
        {selected.size > 1 && (
          <p className="text-xs text-gray-500 mt-3">
            With {batchSize}/batch every {batchIntervalMin} min, {selected.size} device(s) will be staggered across {Math.max(0, Math.ceil(selected.size / Math.max(1, batchSize)) - 1) * batchIntervalMin} min.
          </p>
        )}
        <button
          onClick={handleSend}
          disabled={selected.size === 0 || !otaUrl}
          className="mt-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send to {selected.size} device(s)
        </button>
      </div>

      {/* Confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold mb-3">Confirm OTA broadcast</h3>
            <div className="text-sm text-gray-700 space-y-2">
              <p><strong>{selected.size}</strong> device(s) will be updated.</p>
              <p>URL: <span className="font-mono text-xs break-all">{otaUrl}</span></p>
              {otaVersion && <p>Version: {otaVersion}</p>}
              <p>Schedule: {scheduleMode === "now" ? "starting now" : `starting ${scheduleDate} ${scheduleTime}`}</p>
              {selected.size > 1 && <p>Batch: {batchSize} / every {batchIntervalMin} min</p>}
              <p className="text-xs text-amber-600 mt-3">Offline devices will pick up the trigger when they come back online (within 7 days of the scheduled time).</p>
            </div>
            <div className="flex gap-2 mt-5 justify-end">
              <button onClick={() => setShowConfirm(false)} disabled={sending} className="px-4 py-2 text-sm bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={confirmSend} disabled={sending} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg disabled:opacity-50">
                {sending ? "Sending…" : "Confirm send"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
