import { useState, useEffect } from "react";
import { listenToDeviceLive, listenToDeviceInfo } from "../firebase/rtdb";

export function useDevice(deviceCode) {
  const [live, setLive] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (!deviceCode) return;

    // Attach RTDB listeners only while the tab is visible. Background
    // tabs would otherwise keep receiving /live pushes on every firmware
    // update — wasted outgoing bandwidth on the RTDB free tier.
    let unsubLive = null;
    let unsubInfo = null;

    function attach() {
      if (unsubLive) return;
      unsubLive = listenToDeviceLive(deviceCode, setLive);
      unsubInfo = listenToDeviceInfo(deviceCode, setInfo);
    }
    function detach() {
      if (unsubLive) { unsubLive(); unsubLive = null; }
      if (unsubInfo) { unsubInfo(); unsubInfo = null; }
    }
    function onVis() {
      if (document.visibilityState === "visible") attach();
      else                                         detach();
    }

    if (document.visibilityState === "visible") attach();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      detach();
    };
  }, [deviceCode]);

  const isOnline = info?.online === true;
  const lastSeen = info?.lastSeen;
  const isStale = lastSeen ? (Date.now() - lastSeen) > 900000 : true; // 15 min in ms

  return { live, info, isOnline: isOnline && !isStale, lastSeen };
}
