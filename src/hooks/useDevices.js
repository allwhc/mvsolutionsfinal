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

    let unsubscribers = [];

    async function load() {
      const subs = await getUserSubscriptions(user.uid);
      const deviceMap = {};

      for (const sub of subs) {
        const catalog = await getDevice(sub.deviceCode);
        deviceMap[sub.deviceCode] = {
          ...sub,
          catalog,
          live: null,
          info: null,
        };
      }

      setDevices(Object.values(deviceMap));
      setLoading(false);

      // attach live listeners
      for (const sub of subs) {
        const unLive = listenToDeviceLive(sub.deviceCode, (data) => {
          setDevices((prev) =>
            prev.map((d) =>
              d.deviceCode === sub.deviceCode ? { ...d, live: data } : d
            )
          );
        });
        const unInfo = listenToDeviceInfo(sub.deviceCode, (data) => {
          setDevices((prev) =>
            prev.map((d) =>
              d.deviceCode === sub.deviceCode ? { ...d, info: data } : d
            )
          );
        });
        unsubscribers.push(unLive, unInfo);
      }
    }

    load();
    return () => unsubscribers.forEach((u) => u());
  }, [user]);

  return { devices, loading };
}
