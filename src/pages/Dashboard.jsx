import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useDevices } from "../hooks/useDevices";
import { useDashboardAlertSound } from "../hooks/useDashboardAlertSound";
import { getOrgGroups, updateUserDoc } from "../firebase/db";
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
  const [filter, setFilter] = useState("all"); // "all" | "personal" | "org" | groupId
  const [groups, setGroups] = useState([]);
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

  // Filter devices: search first (global), else apply the org/group filter.
  const filteredDevices = devices.filter((d) => {
    if (searchActive) {
      const t = searchText.trim().toLowerCase();
      const blob = `${d.deviceCode} ${d.deviceName || ""} ${d.location || ""}`.toLowerCase();
      return blob.includes(t);
    }
    if (filter === "all") return true;
    if (filter === "personal") return !d.groupId;
    if (filter === "org") return !!d.groupId;
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
              {onlineCount} online, {filteredDevices.length - onlineCount} offline — {filteredDevices.length} device{filteredDevices.length !== 1 ? "s" : ""}
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
          <button
            onClick={() => setFilter("personal")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === "personal" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            My Devices
          </button>
          <button
            onClick={() => setFilter("org")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === "org" ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Org Devices
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
                return (
                  <SortableTile key={d.deviceCode} id={d.deviceCode} enabled={dragEnabled}>
                    {inner}
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
          onClose={() => setAnalyticsDevice(null)}
        />
      )}
    </div>
  );
}
