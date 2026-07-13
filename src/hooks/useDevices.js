import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { getUserSubscriptions } from "../firebase/db";
import { listenToDeviceLive, listenToDeviceInfo } from "../firebase/rtdb";
import { getDevice } from "../firebase/db";

export function useDevices() {
  const { user } = useAuth();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);

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
      const subs = await getUserSubscriptions(user.uid);
      if (cancelled) return;
      const deviceMap = {};

      for (const sub of subs) {
        const catalog = await getDevice(sub.deviceCode);
        if (cancelled) return;
        deviceMap[sub.deviceCode] = {
          ...sub,
          catalog,
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
  }, [user]);

  return { devices, loading };
}
