import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { getUserSubscriptions, getOrgDevices } from "../firebase/db";
import { listenToDeviceLive, listenToDeviceInfo } from "../firebase/rtdb";
import { getDevice } from "../firebase/db";

export function useDevices() {
  const { user, userData } = useAuth();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  // Bump this to force a full refetch of subscriptions/orgDevices. Used
  // when the caller performs an action that doesn't flow through the
  // RTDB listeners (e.g. adding/removing a subscription in Firestore).
  // Live device data still updates via the RTDB listeners without
  // touching this counter.
  const [refreshKey, setRefreshKey] = useState(0);
  // Route based on account type: org accounts read from the org's shared
  // device list (all members see the same devices, no per-user subscribe);
  // individual accounts read from their personal subscriptions.
  const orgId = userData?.orgId || null;

  useEffect(() => {
    if (!user) { setDevices([]); setLoading(false); return; }

    // Firebase RTDB listeners keep firing whenever data changes — even
    // when the browser tab is in the background. On a fleet with many
    // devices and frequent /live updates this burns RTDB outgoing
    // bandwidth for nothing (the user isn't looking). Track the list of
    // subscribed device codes so we can attach/detach listeners together
    // when the tab visibility changes.
    let unsubscribers = [];
    let subCodes = [];
    let cancelled = false;

    function attachListeners() {
      // Idempotent — if listeners already attached, this is a no-op.
      if (unsubscribers.length > 0) return;
      for (const code of subCodes) {
        const unLive = listenToDeviceLive(code, (data) => {
          setDevices((prev) =>
            prev.map((d) => (d.deviceCode === code ? { ...d, live: data } : d))
          );
        });
        const unInfo = listenToDeviceInfo(code, (data) => {
          setDevices((prev) =>
            prev.map((d) => (d.deviceCode === code ? { ...d, info: data } : d))
          );
        });
        unsubscribers.push(unLive, unInfo);
      }
    }

    function detachListeners() {
      unsubscribers.forEach((u) => u());
      unsubscribers = [];
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") attachListeners();
      else                                         detachListeners();
    }

    async function load() {
      // Org accounts: read from the shared org list. Individual accounts:
      // keep the existing per-user subscription flow.
      const subs = orgId
        ? await getOrgDevices(orgId)
        : await getUserSubscriptions(user.uid);
      if (cancelled) return;
      const deviceMap = {};

      for (const sub of subs) {
        const catalog = await getDevice(sub.deviceCode);
        if (cancelled) return;
        // Canonical fields (name, capacity, alerts, cleaning) live on
        // the shared deviceCatalog now — one setting per physical tank
        // instead of per subscriber. Read catalog first, fall back to
        // the legacy per-subscription value so pre-migration data
        // still displays correctly. Owner opening DeviceDetail
        // silently promotes any per-user leftovers to catalog.
        deviceMap[sub.deviceCode] = {
          ...sub,
          catalog,
          deviceName:          catalog?.deviceName          ?? sub.deviceName          ?? sub.deviceCode,
          tankCapacityLitres:  catalog?.tankCapacityLitres  ?? sub.tankCapacityLitres  ?? 0,
          alertLowPct:         catalog?.alertLowPct         ?? sub.alertLowPct         ?? null,
          alertHighPct:        catalog?.alertHighPct        ?? sub.alertHighPct        ?? null,
          // Pump-only alert flags — booleans on catalog. Forwarded here
          // so useDebouncedAlerts can evaluate them uniformly with the
          // pct thresholds. Missing = false (opt-in).
          alertSourceDry:      catalog?.alertSourceDry      ?? false,
          alertPumpDryRun:     catalog?.alertPumpDryRun     ?? false,
          alertPumpMaxRuntime: catalog?.alertPumpMaxRuntime ?? false,
          alertPumpSafeMode:   catalog?.alertPumpSafeMode   ?? false,
          lastCleanedAt:       catalog?.lastCleanedAt       ?? sub.lastCleanedAt       ?? null,
          cleanIntervalDays:   catalog?.cleanIntervalDays   ?? sub.cleanIntervalDays   ?? 30,
          live: null,
          info: null,
        };
      }

      setDevices(Object.values(deviceMap));
      setLoading(false);

      subCodes = subs.map((s) => s.deviceCode);
      // Only attach on load if the tab is currently visible; otherwise
      // wait for the visibility handler to re-attach when user comes back.
      if (document.visibilityState === "visible") attachListeners();
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    load();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      detachListeners();
    };
  }, [user, orgId, refreshKey]);

  // Callers use refresh() after any Firestore write that changes the
  // subscription set (unsubscribe, subscribe, org add/remove). The RTDB
  // listeners don't cover those — Firestore has no equivalent onSnapshot
  // wired up in this hook — so we do a manual re-read on demand.
  const refresh = () => setRefreshKey((k) => k + 1);

  return { devices, loading, refresh };
}
