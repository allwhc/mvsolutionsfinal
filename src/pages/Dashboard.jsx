import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useDebugMode } from "../context/DebugModeContext";
import { useDevices } from "../hooks/useDevices";
import { useDashboardAlertSound } from "../hooks/useDashboardAlertSound";
import { getOrgGroups, updateUserDoc, updateOrgGroup } from "../firebase/db";
import DeviceCard from "../components/DeviceCard/DeviceCard";
import DeviceAnalyticsModal from "../components/Analytics/DeviceAnalyticsModal";
import NotificationPermissionBanner from "../components/NotificationPermissionBanner";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, rectSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// One sortable cell — wraps each dashboard tile. Picks up dnd-kit's listeners
// only when the parent decides drag is allowed (locked=false, desktop, no
// search). When `enabled` is false this is a plain pass-through wrapper so
// the existing <Link> click behavior on locked-mode tiles isn't intercepted
// by drag listeners.
function SortableTile({ id, enabled, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !enabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: enabled ? "grab" : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} {...(enabled ? attributes : {})} {...(enabled ? listeners : {})}>
      {children}
    </div>
  );
}

// Sort the device list by the user's saved order. Codes not in the saved
// order get appended in their original (subscription) order so new devices
// always show up — at the end — rather than disappearing.
function applySavedOrder(devices, savedOrder) {
  if (!savedOrder || savedOrder.length === 0) return devices;
  const byCode = new Map(devices.map((d) => [d.deviceCode, d]));
  const out = [];
  for (const code of savedOrder) {
    const d = byCode.get(code);
    if (d) { out.push(d); byCode.delete(code); }
  }
  // Append anything new (subscription added since the order was saved).
  for (const d of byCode.values()) out.push(d);
  return out;
}

export default function Dashboard() {
  const { user, userData, isOrgAdmin, isOrgMember } = useAuth();
  const { devices, loading } = useDevices();
  const navigate = useNavigate();

  // Kiosk entry — confirmation prompt then hand off to /kiosk (which
  // handles browser-native fullscreen on mount).
  const handleKioskLaunch = () => {
    if (window.confirm("Enter kiosk mode?\n\nThe browser will go fullscreen. Press Esc or the Exit button to leave.")) {
      navigate("/kiosk");
    }
  };
  // Edge-triggered audible alert when any device crosses a user-configured
  // alertLowPct / alertHighPct threshold. Silent for devices where the
  // user never set thresholds — only fires for alerts they activated.
  const { muted: soundMuted, toggleMuted: toggleSoundMuted } = useDashboardAlertSound(devices);

  // Per-device analytics popup. Holds the deviceCode of whichever tile's
  // chart icon was clicked, or null when no modal is open. Firebase reads
  // happen lazily inside the modal — opening it is the trigger.
  const [analyticsDevice, setAnalyticsDevice] = useState(null);

  // Search box state — collapsed by default, expands on click. Matches
  // device name + code + location, case-insensitive. While search has
  // text it OVERRIDES the org/group filter and disables drag (per the
  // confirmed UX — search is a global "find my device" tool, not a
  // narrowing tool that interacts with reorder).
  const [searchOpen, setSearchOpen] = useState(false);
  // Hidden diagnostic toggle — flips SensorCard/TankViz from "resolved
  // level" (customer-friendly) to "raw firmware bits" (shows probe
  // faults). Off by default, session-only, not per-device. Discoverable
  // by admins/installers only via word-of-mouth.
  const { debugMode, setDebugMode } = useDebugMode();
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef(null);
  useEffect(() => {
    if (searchOpen && searchInputRef.current) searchInputRef.current.focus();
  }, [searchOpen]);

  // Drag-to-reorder state. Saved per user at users/<uid>.dashboardOrder.
  // Hydrated from userData when AuthContext finishes loading.
  const [dashboardOrder, setDashboardOrder] = useState([]);
  useEffect(() => {
    setDashboardOrder(userData?.dashboardOrder || []);
  }, [userData?.dashboardOrder]);

  // Mobile detection (drag disabled on phones, per design). 768 = Tailwind md.
  // Listen for resize so a user rotating their tablet picks up the change.
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    function onResize() { setIsNarrow(window.innerWidth < 768); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // dnd-kit pointer sensor — small activation distance prevents accidental
  // drags when the user is just trying to tap (especially on the chart icon).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [filter, setFilter] = useState("all"); // "all" | "org" | groupId
  const [groups, setGroups] = useState([]);
  // Add-to-wing modal state. Non-null while the modal is open. Only
  // renders when the current filter is a specific wing/group AND the
  // user is orgAdmin. Contains the group object being edited.
  const [addToWingModal, setAddToWingModal] = useState(null);
  const [selectedToAdd, setSelectedToAdd] = useState(new Set());
  const [locked, setLocked] = useState(() => {
    // Persist lock state across navigations — only user toggles it
    const saved = localStorage.getItem("dashboardLocked");
    return saved === null ? true : saved === "true";
  });

  const toggleLock = () => {
    setLocked((prev) => {
      const next = !prev;
      localStorage.setItem("dashboardLocked", String(next));
      return next;
    });
  };

  const isOrg = isOrgAdmin || isOrgMember;
  const orgId = userData?.orgId;

  // Load org groups for filtering
  useEffect(() => {
    if (isOrg && orgId) {
      getOrgGroups(orgId).then(setGroups);
    }
  }, [isOrg, orgId]);

  // Greeting based on time of day
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good Morning" : hour < 17 ? "Good Afternoon" : "Good Evening";

  // Memoised: devices NOT already in the wing the add-modal is
  // targeting. Empty when the modal is closed. Must live above any
  // early returns to keep hook count stable across renders
  // (React rule-of-hooks / error #310).
  const addableDevices = useMemo(() => {
    if (!addToWingModal) return [];
    const inWing = new Set(addToWingModal.deviceCodes || []);
    return devices.filter((d) => !inWing.has(d.deviceCode));
  }, [addToWingModal, devices]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {greeting}, {userData?.displayName?.split(" ")[0] || "there"}
        </h2>
        {isOrg && (
          <p className="text-blue-600 font-medium mb-4">{userData?.orgName || orgId}</p>
        )}
        <p className="text-gray-500 mb-6">Add a device to start monitoring</p>
        <Link
          to="/subscribe"
          className="inline-block bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          Add Device
        </Link>
        <p className="text-gray-400 text-xs mt-8 max-w-sm mx-auto leading-relaxed">
          Discover SenseFlow's complete water management solutions — smart monitoring for tanks and control for automated valve & pump.{" "}
          <a href="https://senseflow.in" target="_blank" className="text-blue-500 hover:underline">Visit senseflow.in</a>
        </p>
      </div>
    );
  }

  // Active search overrides the org filter entirely — "find any of my devices"
  // is global to the user's subscription set, not narrowed by the current tab.
  const searchActive = searchOpen && searchText.trim().length > 0;

  // Filter devices: search first (global), else apply the wing filter.
  //   all       → every device the user can see (unassigned live here too)
  //   <groupId> → devices in that specific wing/group
  const filteredDevices = devices.filter((d) => {
    if (searchActive) {
      const t = searchText.trim().toLowerCase();
      const blob = `${d.deviceCode} ${d.deviceName || ""} ${d.location || ""}`.toLowerCase();
      return blob.includes(t);
    }
    if (filter === "all") return true;
    const group = groups.find((g) => g.groupId === filter);
    if (group) return group.deviceCodes?.includes(d.deviceCode);
    return true;
  });

  // Apply the user's saved drag order. Anything not in the saved order
  // (newly subscribed) appears at the end automatically.
  const orderedDevices = applySavedOrder(filteredDevices, dashboardOrder);

  // Count online/offline
  const isDeviceOnline = (d) => {
    const lastSeen = d.info?.lastSeen;
    const isStale = lastSeen ? (Date.now() - lastSeen) > 900000 : true;
    return d.info?.online && !isStale;
  };
  const onlineCount = orderedDevices.filter(isDeviceOnline).length;

  // Drag is allowed only when:
  //   1. Dashboard is UNLOCKED (lock icon signals "edit mode")
  //   2. Screen is wide enough (mobile has no drag)
  //   3. Search has no text (search disables drag — confusing otherwise)
  const dragEnabled = !locked && !isNarrow && !searchActive;

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedDevices.findIndex((d) => d.deviceCode === active.id);
    const newIndex = orderedDevices.findIndex((d) => d.deviceCode === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    // Reorder the visible list, then build the new global order. We rebuild
    // from the ALL-devices set so devices outside the current filter (if any)
    // keep their relative position.
    const newVisibleOrder = arrayMove(orderedDevices, oldIndex, newIndex).map((d) => d.deviceCode);
    const visibleSet = new Set(newVisibleOrder);
    const fullOrder = [];
    let visibleIdx = 0;
    // Walk current saved order + any uncovered devices, replacing visible
    // slots with the freshly reordered sequence.
    const fallback = [...newVisibleOrder, ...devices.filter((d) => !visibleSet.has(d.deviceCode)).map((d) => d.deviceCode)];
    const current = dashboardOrder.length ? dashboardOrder : devices.map((d) => d.deviceCode);
    for (const code of current) {
      if (visibleSet.has(code)) {
        fullOrder.push(newVisibleOrder[visibleIdx++]);
      } else {
        fullOrder.push(code);
      }
    }
    // Append any device the saved order didn't know about.
    for (const code of fallback) {
      if (!fullOrder.includes(code)) fullOrder.push(code);
    }

    setDashboardOrder(fullOrder);   // optimistic
    if (user?.uid) {
      try { await updateUserDoc(user.uid, { dashboardOrder: fullOrder }); }
      catch (e) { console.error("Failed to save dashboard order:", e); }
    }
  }

  // Wing/group membership editing. Only orgAdmin can call these; the UI
  // that triggers them is hidden for members. Optimistic — local groups
  // state updates immediately so the tile appears/disappears from the
  // wing tab without waiting for Firestore.
  async function removeDeviceFromWing(groupId, deviceCode) {
    if (!orgId) return;
    if (!confirm("Remove this device from the wing?")) return;
    const g = groups.find((x) => x.groupId === groupId);
    if (!g) return;
    const nextCodes = (g.deviceCodes || []).filter((c) => c !== deviceCode);
    setGroups((prev) => prev.map((x) => x.groupId === groupId ? { ...x, deviceCodes: nextCodes } : x));
    try { await updateOrgGroup(orgId, groupId, { deviceCodes: nextCodes }); }
    catch (e) { console.error("Failed to remove from wing:", e); alert("Failed to remove — try again"); }
  }

  async function commitAddToWing() {
    if (!orgId || !addToWingModal) return;
    const g = addToWingModal;
    const current = new Set(g.deviceCodes || []);
    for (const c of selectedToAdd) current.add(c);
    const nextCodes = Array.from(current);
    setGroups((prev) => prev.map((x) => x.groupId === g.groupId ? { ...x, deviceCodes: nextCodes } : x));
    try { await updateOrgGroup(orgId, g.groupId, { deviceCodes: nextCodes }); }
    catch (e) { console.error("Failed to add to wing:", e); alert("Failed to add — try again"); }
    setAddToWingModal(null);
    setSelectedToAdd(new Set());
  }

  return (
    <div>
      <NotificationPermissionBanner />

      {/* Welcome header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {greeting}, {userData?.displayName?.split(" ")[0] || "there"}
            </h1>
            {isOrg && (
              <p className="text-blue-600 font-medium text-sm mt-0.5">
                {userData?.orgName || orgId}
              </p>
            )}
            <p className="text-sm text-gray-500 mt-1">
              {/* Dashboard header shows just total — "1 online, 1
                  offline" wording caused customer panic even when
                  the offline was a brief router hiccup. Fleet
                  connectivity oversight lives on the Organisation
                  page, where an admin managing multiple devices
                  legitimately wants to see connected count. */}
              {filteredDevices.length} device{filteredDevices.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Search — expands inline when icon clicked. Matches device
                name, code, location. Active search overrides org filter
                and disables drag-to-reorder. */}
            {searchOpen ? (
              <div className="flex items-center bg-white border border-blue-300 rounded-lg overflow-hidden">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Search any device…"
                  className="px-3 py-1.5 text-sm focus:outline-none w-44 sm:w-56"
                />
                <button
                  onClick={() => { setSearchText(""); setSearchOpen(false); }}
                  className="px-2 text-gray-400 hover:text-gray-600"
                  aria-label="Close search"
                  title="Close search"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => setSearchOpen(true)}
                className="p-2 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200"
                title="Search devices"
                aria-label="Search devices"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
            )}
            {/* Kiosk / fullscreen wall-display mode. Confirms first,
                then navigates to /kiosk (which triggers native
                fullscreen on mount). */}
            <button
              onClick={handleKioskLaunch}
              className="p-2 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200"
              title="Kiosk view (fullscreen)"
              aria-label="Enter kiosk view"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V6a2 2 0 012-2h2M4 16v2a2 2 0 002 2h2m8-16h2a2 2 0 012 2v2m-4 12h2a2 2 0 002-2v-2" />
              </svg>
            </button>

            {/* Hidden probe-diagnostic toggle. Session-only (no localStorage)
                so accidentally-turned-on state clears on refresh. Deliberately
                unobtrusive: no icon change, no colour indication when off.
                Intended for admins / installers who know it exists. */}
            <button
              onClick={() => {
                if (debugMode) {
                  // Turning OFF is instant — no confirm needed.
                  setDebugMode(false);
                  return;
                }
                // Turning ON exposes raw sensor faults that customers
                // are not meant to see. Gate with a confirm so a stray
                // click doesn't accidentally flip a customer's dashboard
                // into diagnostic view.
                if (window.confirm("Turn ON probe diagnostic view? This will show raw sensor error states across all your tanks.")) {
                  setDebugMode(true);
                }
              }}
              className={`p-2 rounded-lg transition-colors ${
                debugMode ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
              title={debugMode ? "Probe diagnostic ON — showing raw sensor state" : "Probe diagnostic"}
              aria-label="Toggle probe diagnostic view"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
              </svg>
            </button>
            {/* Alert sound toggle. Only beeps for user-configured thresholds. */}
            <button
              onClick={toggleSoundMuted}
              className={`p-2 rounded-lg transition-colors ${
                soundMuted ? "bg-gray-100 text-gray-500" : "bg-blue-100 text-blue-700"
              }`}
              title={soundMuted ? "Alert sounds muted — tap to enable" : "Alert sounds on — tap to mute"}
              aria-label={soundMuted ? "Enable alert sounds" : "Mute alert sounds"}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {soundMuted ? (
                  // Bell with slash — muted
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.73 21a2 2 0 01-3.46 0M18.63 13A17.888 17.888 0 0118 8M6.26 6.26A5.986 5.986 0 006 8c0 7-3 9-3 9h14M18 8a6 6 0 00-9.33-5M3 3l18 18" />
                ) : (
                  // Bell
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                )}
              </svg>
            </button>
            <button
              onClick={toggleLock}
              className={`p-2 rounded-lg transition-colors ${locked ? "bg-gray-100 text-gray-500" : "bg-yellow-100 text-yellow-700"}`}
              title={locked ? "Dashboard locked — tap to unlock" : "Dashboard unlocked — tap to lock"}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {locked ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                )}
              </svg>
            </button>
            <Link
              to="/subscribe"
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              + Add Device
            </Link>
          </div>
        </div>
      </div>

      {/* Lock status bar */}
      {!locked && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-1.5 mb-4 flex items-center gap-2">
          <svg className="w-4 h-4 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
          </svg>
          <span className="text-xs text-yellow-700 font-medium">Dashboard unlocked — tap devices to view details</span>
        </div>
      )}

      {/* Filter tabs */}
      {isOrg && (
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === "all" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All ({devices.length})
          </button>
          {groups.map((g) => (
            <button
              key={g.groupId}
              onClick={() => setFilter(g.groupId)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === g.groupId ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {/* Wing management bar — appears only when viewing a specific
          wing/group tab AND the current user is orgAdmin. Members see
          nothing extra. */}
      {(() => {
        const activeGroup = groups.find((g) => g.groupId === filter);
        if (!activeGroup || !isOrgAdmin) return null;
        return (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
            <div className="text-xs text-indigo-800">
              <span className="font-semibold">{activeGroup.name}</span>
              <span className="ml-2 text-indigo-600">{(activeGroup.deviceCodes || []).length} device{(activeGroup.deviceCodes || []).length !== 1 ? "s" : ""}</span>
            </div>
            <button
              onClick={() => { setAddToWingModal(activeGroup); setSelectedToAdd(new Set()); }}
              className="text-xs font-semibold bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700"
            >
              + Add device to {activeGroup.name}
            </button>
          </div>
        );
      })()}

      {/* Device grid. When drag is enabled the grid is wrapped with
          dnd-kit. When disabled we render the same grid with no drag
          listeners attached so taps, locks, and Link clicks behave
          exactly as before. */}
      {orderedDevices.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-10">
          {searchActive ? "No devices match that search" : "No devices in this filter"}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={orderedDevices.map((d) => d.deviceCode)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {orderedDevices.map((d) => {
                const card = (
                  <DeviceCard
                    deviceCode={d.deviceCode}
                    deviceName={d.deviceName}
                    live={d.live}
                    info={d.info}
                    catalog={d.catalog}
                    isOnline={isDeviceOnline(d)}
                    lastCleanedAt={d.lastCleanedAt}
                    cleanIntervalDays={d.cleanIntervalDays}
                    tankCapacityLitres={d.tankCapacityLitres}
                    alertLowPct={d.alertLowPct}
                    alertHighPct={d.alertHighPct}
                    valveAlertOpenHours={d.valveAlertOpenHours}
                    valveAlertClosedHours={d.valveAlertClosedHours}
                    onOpenAnalytics={() => setAnalyticsDevice(d)}
                  />
                );
                const inner = locked ? (
                  <div className="cursor-default">{card}</div>
                ) : (
                  // When unlocked AND drag is on, the Link can't be the
                  // drag target — clicks would race with drag listeners.
                  // We keep the navigation as a separate explicit click
                  // (drag activates only after 6 px movement, so a plain
                  // tap still navigates).
                  dragEnabled ? (
                    <Link to={`/device/${d.deviceCode}`} draggable={false}>{card}</Link>
                  ) : (
                    <Link to={`/device/${d.deviceCode}`}>{card}</Link>
                  )
                );
                // Wing X button — only rendered when viewing a specific
                // wing tab AND the user is orgAdmin AND the dashboard is
                // unlocked (matches the lock semantics used for drag).
                // Positioned over the tile's top-right corner;
                // stopPropagation on click so it doesn't also trigger
                // the tile's <Link> navigation.
                const activeGroup = groups.find((g) => g.groupId === filter);
                const showRemoveX = activeGroup && isOrgAdmin && !locked;
                return (
                  <SortableTile key={d.deviceCode} id={d.deviceCode} enabled={dragEnabled}>
                    <div className="relative group">
                      {inner}
                      {/* Wing-detach button — small minus icon, quiet
                          at rest (grey, low opacity) so the tile stays
                          calm. Reveals red confirm styling on hover so
                          the affordance is unmistakable when the admin
                          actually reaches for it. Minus (−) icon reads
                          as "remove from list," not "delete forever"
                          (× was too alarming). */}
                      {showRemoveX && (
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeDeviceFromWing(activeGroup.groupId, d.deviceCode); }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="absolute top-1.5 right-1.5 z-10 w-[22px] h-[22px] rounded-full flex items-center justify-center shadow-sm transition-all
                                     bg-white/80 text-gray-400 ring-1 ring-gray-300 opacity-40
                                     group-hover:opacity-100
                                     hover:bg-red-500 hover:text-white hover:ring-red-500"
                          title={`Remove from ${activeGroup.name}`}
                          aria-label={`Remove device from ${activeGroup.name}`}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </SortableTile>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Drag-mode hint — only when drag is genuinely active. */}
      {dragEnabled && orderedDevices.length > 1 && (
        <p className="text-center text-xs text-gray-400 mt-3">
          Drag tiles to reorder. Your layout is saved automatically.
        </p>
      )}

      {/* Quick-analytics modal — lazily renders, only Firebase-loads when open. */}
      {analyticsDevice && (
        <DeviceAnalyticsModal
          deviceCode={analyticsDevice.deviceCode}
          deviceName={analyticsDevice.deviceName}
          tankCapacityLitres={analyticsDevice.tankCapacityLitres}
          currentPct={analyticsDevice.live?.confirmedPct}
          currentBits={analyticsDevice.live?.sensorBits}
          sensorType={analyticsDevice.info?.sensorType ?? analyticsDevice.sensorType ?? 1}
          sensorCount={analyticsDevice.info?.sensorCount ?? analyticsDevice.sensorCount ?? 4}
          onClose={() => setAnalyticsDevice(null)}
        />
      )}

      {/* Add-to-wing modal — orgAdmin picks devices to attach to the
          currently viewed wing. Shows only devices NOT already in this
          wing. Multi-select via checkboxes, one commit on Save. */}
      {addToWingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
             onClick={() => { setAddToWingModal(null); setSelectedToAdd(new Set()); }}>
          <div className="bg-white rounded-xl p-5 w-full max-w-md max-h-[80vh] flex flex-col"
               onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">Add devices to {addToWingModal.name}</h3>
            <p className="text-xs text-gray-500 mb-3">Pick one or more devices to attach to this wing.</p>
            {addableDevices.length === 0 ? (
              <p className="text-gray-400 text-sm py-8 text-center">Every device is already in this wing.</p>
            ) : (
              <div className="flex-1 overflow-y-auto border border-gray-200 rounded-lg divide-y">
                {addableDevices.map((d) => {
                  const checked = selectedToAdd.has(d.deviceCode);
                  return (
                    <label key={d.deviceCode}
                           className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox" checked={checked} onChange={(e) => {
                        const next = new Set(selectedToAdd);
                        if (e.target.checked) next.add(d.deviceCode); else next.delete(d.deviceCode);
                        setSelectedToAdd(next);
                      }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {d.info?.userAssignedName || d.deviceName || d.deviceCode}
                        </div>
                        <div className="text-[11px] text-gray-500 font-mono truncate">{d.deviceCode}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2 mt-3">
              <button onClick={commitAddToWing}
                      disabled={selectedToAdd.size === 0}
                      className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-indigo-700">
                Add {selectedToAdd.size > 0 ? `(${selectedToAdd.size})` : ""}
              </button>
              <button onClick={() => { setAddToWingModal(null); setSelectedToAdd(new Set()); }}
                      className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
