import { useState, useEffect } from "react";
import { listenToDeviceLive, listenToDeviceInfo } from "../firebase/rtdb";

export function useDevice(deviceCode) {
  const [live, setLive] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (!deviceCode) return;
    const unsubLive = listenToDeviceLive(deviceCode, setLive);
    const unsubInfo = listenToDeviceInfo(deviceCode, setInfo);
    return () => { unsubLive(); unsubInfo(); };
  }, [deviceCode]);

  const isOnline = info?.online === true;
  const lastSeen = info?.lastSeen;
  const isStale = lastSeen ? (Date.now() - lastSeen) > 900000 : true; // 15 min in ms

  return { live, info, isOnline: isOnline && !isStale, lastSeen };
}
