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

  // Online derivation is device-class aware:
  //   • Sensor / valve / motor / SFS write /info/online + /info/lastSeen on
  //     their own periodic heartbeat — trust those, 15-min staleness cap.
  //   • Pump firmware (deviceClass=4) does NOT write /info/online; it only
  //     pushes /live on state change with a 20-sec min-gap rate limit.
  //     A pump can legitimately sit idle for hours with no state change,
  //     so we derive online from /live/ts freshness with a much longer
  //     60-min window — anything newer than that = device is talking.
  //     This avoids false-offline flags on idle-but-healthy pumps while
  //     still catching real WiFi loss within an hour.
  const deviceClass = info?.deviceClass;
  const isPump = deviceClass === 4;
  let isOnline;
  let lastSeen;
  if (isPump) {
    // /live.ts is server timestamp (ms since epoch) written by firmware.
    // 10-min window catches one missed heartbeat cycle (firmware pushes
    // /live on state change + a periodic 4-min heartbeat).
    lastSeen = live?.ts;
    const stale = lastSeen ? (Date.now() - lastSeen) > 600000 : true; // 10 min
    isOnline = !stale;
  } else {
    lastSeen = info?.lastSeen;
    const stale = lastSeen ? (Date.now() - lastSeen) > 900000 : true;   // 15 min
    isOnline = info?.online === true && !stale;
  }

  return { live, info, isOnline, lastSeen };
}
