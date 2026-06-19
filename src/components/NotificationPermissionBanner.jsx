import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { requestAndSaveFcmToken, currentPermission } from "../firebase/messaging";

// Small banner shown on Dashboard the first time a user lands without having
// granted (or explicitly denied) notification permission. We persist a
// dismissed flag in localStorage so users who skip it aren't nagged.
export default function NotificationPermissionBanner() {
  const { user } = useAuth();
  const [perm, setPerm] = useState(currentPermission());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("notifBannerDismissed") === "true"
  );

  useEffect(() => {
    // Recheck on mount in case permission was granted in another tab.
    setPerm(currentPermission());
  }, []);

  if (!user) return null;
  if (perm === "granted" || perm === "denied" || perm === "unsupported") return null;
  if (dismissed) return null;

  async function handleEnable() {
    setBusy(true);
    setMsg("");
    const res = await requestAndSaveFcmToken(user.uid);
    setBusy(false);
    if (res.status === "granted") {
      setPerm("granted");
      setMsg("Notifications enabled.");
    } else if (res.status === "denied") {
      setMsg("Permission not granted. You can enable it later from settings.");
      setPerm("denied");
    } else if (res.status === "unsupported") {
      setMsg("This browser does not support web push notifications.");
      setPerm("unsupported");
    } else {
      setMsg(`Could not enable: ${res.error}`);
    }
  }

  function handleDismiss() {
    localStorage.setItem("notifBannerDismissed", "true");
    setDismissed(true);
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 flex items-center justify-between gap-3">
      <div className="text-sm">
        <span className="font-medium text-blue-900">🔔 Enable notifications</span>
        <span className="text-blue-700 ml-2">
          Get alerts when tanks fill, drain, or devices go offline.
        </span>
        {msg && <div className="text-xs text-blue-800 mt-1">{msg}</div>}
      </div>
      <div className="flex gap-2 flex-shrink-0">
        <button
          onClick={handleEnable}
          disabled={busy}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50"
        >
          {busy ? "…" : "Enable"}
        </button>
        <button
          onClick={handleDismiss}
          className="px-3 py-1.5 text-xs bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 rounded-lg"
        >
          Later
        </button>
      </div>
    </div>
  );
}
