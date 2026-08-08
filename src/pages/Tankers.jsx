import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useDevices } from "../hooks/useDevices";
import {
  listTankerOrders, addTankerOrder, updateTankerOrder, deleteTankerOrder,
} from "../firebase/db";

// LocalStorage keys — remembered per browser, per user habit.
const LS_LAST_TANK = "tanker.lastTank";

const WATER_TYPES = [
  { value: "borewell",  label: "Borewell"  },
  { value: "municipal", label: "Municipal" },
  { value: "packaged",  label: "Packaged"  },
  { value: "other",     label: "Other"     },
];

const PAYMENT_MODES = [
  { value: "cash",     label: "Cash"          },
  { value: "upi",      label: "UPI"           },
  { value: "cheque",   label: "Cheque"        },
  { value: "bank",     label: "Bank Transfer" },
  { value: "credit",   label: "Credit"        },
  { value: "other",    label: "Other"         },
];

// "6 Aug, 10:15 AM"
function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const dstr = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const tstr = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  return `${dstr}, ${tstr}`;
}

// Firestore timestamp → HTML datetime-local input value ("YYYY-MM-DDTHH:MM").
function tsToLocalInput(ts) {
  const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : new Date());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToDate(s) {
  return s ? new Date(s) : new Date();
}

function fmtVolume(l) {
  if (l == null || l === "") return "—";
  const n = Number(l);
  if (!isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)} KL`;
  return `${n} L`;
}

function fmtCurrency(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return `₹${v.toLocaleString("en-IN")}`;
}

function waterTypeLabel(v) {
  return WATER_TYPES.find((x) => x.value === v)?.label || v;
}

function paymentModeLabel(v) {
  return PAYMENT_MODES.find((x) => x.value === v)?.label || v;
}

export default function Tankers() {
  const { user, userData, isSuperAdmin, isOrgAdmin, isOrgMember } = useAuth();
  const { devices } = useDevices();
  const [searchParams] = useSearchParams();

  const isOrg = isOrgAdmin || isOrgMember;
  const orgId = userData?.orgId || null;
  const ownerScope = isOrg && orgId ? "org" : "user";
  const scopeId    = isOrg && orgId ? orgId : user?.uid;
  const canEditAll = isSuperAdmin || (!isOrg) || isOrgAdmin;

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [modal, setModal] = useState(null);

  async function load() {
    if (!user) return;
    setLoadError("");
    try {
      const rows = await listTankerOrders(ownerScope, scopeId);
      setOrders(rows);
    } catch (e) {
      console.error("Load tanker orders failed:", e);
      setLoadError("Couldn't load tanker log — try refreshing.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [user, ownerScope, scopeId]);

  useEffect(() => {
    const wantNew    = searchParams.get("new");
    const forTank    = searchParams.get("tank");
    if (wantNew && !modal) {
      setModal({ mode: "new", seed: forTank ? { deliveries: [{ tankCode: forTank }] } : {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [monthFilter, setMonthFilter] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const [tankFilter, setTankFilter] = useState("");

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      const d = o.deliveredAt?.toDate?.() || (o.createdAt?.toDate?.());
      if (!d) return true;
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (monthFilter && ym !== monthFilter) return false;
      if (tankFilter) {
        const codes = (o.deliveries || []).map((x) => x.tankCode);
        if (!codes.includes(tankFilter)) return false;
      }
      return true;
    });
  }, [orders, monthFilter, tankFilter]);

  const monthTotals = useMemo(() => {
    let cost = 0, vol = 0, paid = 0, pending = 0;
    for (const o of filtered) {
      if (typeof o.cost === "number")     cost += o.cost;
      if (typeof o.volumeL === "number")  vol  += o.volumeL;
      if (o.paymentStatus === "pending")  pending += (o.cost || 0);
      else if (o.paymentStatus === "paid" && typeof o.cost === "number") paid += o.cost;
    }
    return { count: filtered.length, cost, vol, paid, pending };
  }, [filtered]);

  // Autocomplete indexes — supplier→phone, driver→phone. Vehicles just
  // a distinct list (vehicle can carry different suppliers/drivers so
  // no cross-field autofill).
  const supplierIndex = useMemo(() => {
    const names = new Set();
    const phoneByName = {};
    for (const o of orders) {
      if (!o.supplier) continue;
      names.add(o.supplier);
      if (o.supplierPhone && !(o.supplier in phoneByName)) {
        phoneByName[o.supplier] = o.supplierPhone;
      }
    }
    return { names: Array.from(names).sort(), phoneByName };
  }, [orders]);

  const driverIndex = useMemo(() => {
    const names = new Set();
    const phoneByName = {};
    for (const o of orders) {
      if (!o.driverName) continue;
      names.add(o.driverName);
      if (o.driverPhone && !(o.driverName in phoneByName)) {
        phoneByName[o.driverName] = o.driverPhone;
      }
    }
    return { names: Array.from(names).sort(), phoneByName };
  }, [orders]);

  const vehicleSuggestions = useMemo(() => {
    const s = new Set();
    for (const o of orders) if (o.vehicleNo) s.add(o.vehicleNo);
    return Array.from(s).sort();
  }, [orders]);

  async function handleSave(data) {
    // No per-tank volume — property manager doesn't know the split.
    // Just tank code + name snapshot for readability if renamed later.
    const enriched = {
      ...data,
      deliveries: (data.deliveries || []).map((d) => {
        const dev = devices.find((x) => x.deviceCode === d.tankCode);
        return {
          tankCode: d.tankCode,
          tankName: dev?.deviceName || dev?.info?.userAssignedName || d.tankCode,
        };
      }),
      ownerScope,
      scopeId,
      createdBy: user.uid,
    };

    try {
      if (modal.mode === "edit" && modal.seed?.orderId) {
        delete enriched.createdBy;
        await updateTankerOrder(modal.seed.orderId, enriched);
      } else {
        await addTankerOrder(enriched);
      }
      // Remember for next time — "usually same tank" per Vishal.
      if (enriched.deliveries[0]?.tankCode) {
        localStorage.setItem(LS_LAST_TANK, enriched.deliveries[0].tankCode);
      }
      setModal(null);
      await load();
    } catch (e) {
      console.error("Save tanker order failed:", e);
      alert("Save failed — try again");
    }
  }

  async function handleDelete(order) {
    if (!confirm(`Delete this tanker entry?\n\n${fmtDateTime(order.deliveredAt || order.createdAt)}${order.supplier ? " · " + order.supplier : ""}`)) return;
    try {
      await deleteTankerOrder(order.orderId);
      await load();
    } catch (e) {
      console.error("Delete failed:", e);
      alert("Delete failed — try again");
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Water Tankers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Log tanker deliveries and track monthly spend.
          </p>
        </div>
        <button
          onClick={() => setModal({ mode: "new", seed: {} })}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 17h8m-8 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m12 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m1-9V6a1 1 0 00-1-1H4a1 1 0 00-1 1v11a1 1 0 001 1h1m10-1a1 1 0 001-1v-5l-3-4H9" />
          </svg>
          <span>Log Delivery</span>
        </button>
      </div>

      {/* Month header stats — added Paid/Pending split so property
          manager sees outstanding at a glance. */}
      <div className="bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-100 rounded-xl p-4 mb-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <input
              type="month"
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
              className="text-sm bg-white border border-gray-300 rounded px-2 py-1"
            />
            <span className="ml-2 text-xs text-gray-500">
              {monthTotals.count} order{monthTotals.count !== 1 ? "s" : ""} this month
            </span>
          </div>
          <div className="flex gap-6 flex-wrap">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Volume</p>
              <p className="text-xl font-bold text-cyan-700">{fmtVolume(monthTotals.vol)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Spend</p>
              <p className="text-xl font-bold text-blue-700">{fmtCurrency(monthTotals.cost)}</p>
            </div>
            {monthTotals.pending > 0 && (
              <div>
                <p className="text-xs text-amber-600 uppercase tracking-wider">Pending</p>
                <p className="text-xl font-bold text-amber-700">{fmtCurrency(monthTotals.pending)}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {devices.length > 1 && (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <label className="text-gray-500">Filter by tank:</label>
          <select
            value={tankFilter}
            onChange={(e) => setTankFilter(e.target.value)}
            className="bg-white border border-gray-300 rounded px-2 py-1 text-sm"
          >
            <option value="">All tanks</option>
            {devices.map((d) => (
              <option key={d.deviceCode} value={d.deviceCode}>
                {d.deviceName || d.info?.userAssignedName || d.deviceCode}
              </option>
            ))}
          </select>
        </div>
      )}

      {loadError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-blue-50 flex items-center justify-center">
            <svg className="w-7 h-7 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 17h8m-8 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m12 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m1-9V6a1 1 0 00-1-1H4a1 1 0 00-1 1v11a1 1 0 001 1h1m10-1a1 1 0 001-1v-5l-3-4H9" />
            </svg>
          </div>
          <p className="text-gray-500 text-sm">No tanker deliveries logged for this month.</p>
          <button
            onClick={() => setModal({ mode: "new", seed: {} })}
            className="mt-3 inline-flex items-center gap-1.5 text-blue-600 hover:underline text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 17h8m-8 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m12 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m1-9V6a1 1 0 00-1-1H4a1 1 0 00-1 1v11a1 1 0 001 1h1m10-1a1 1 0 001-1v-5l-3-4H9" />
            </svg>
            Log the first delivery
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-right px-3 py-2 font-medium">Volume</th>
                  <th className="text-right px-3 py-2 font-medium">Cost</th>
                  <th className="text-left px-3 py-2 font-medium">Payment</th>
                  <th className="text-left px-3 py-2 font-medium">Supplier</th>
                  <th className="text-left px-3 py-2 font-medium">Vehicle</th>
                  <th className="text-left px-3 py-2 font-medium">Tanks</th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((o) => (
                  <tr key={o.orderId} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                      {fmtDateTime(o.deliveredAt || o.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-right text-cyan-700 font-medium whitespace-nowrap">
                      {fmtVolume(o.volumeL)}
                      {o.waterType && (
                        <div className="text-[10px] text-gray-500 font-normal capitalize">
                          {waterTypeLabel(o.waterType)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-blue-700 font-medium whitespace-nowrap">
                      {fmtCurrency(o.cost)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {o.paymentStatus === "paid" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                          ✓ Paid
                          {o.paymentMode && (
                            <span className="text-green-600 font-normal">· {paymentModeLabel(o.paymentMode)}</span>
                          )}
                        </span>
                      ) : o.paymentStatus === "pending" ? (
                        <span className="inline-flex items-center text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                          Pending
                        </span>
                      ) : (
                        <span className="text-gray-400 text-[11px]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      <div>{o.supplier || "—"}</div>
                      {o.supplierPhone && (
                        <a href={`tel:${o.supplierPhone}`} className="text-[11px] text-blue-600 hover:underline">
                          {o.supplierPhone}
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                      {o.vehicleNo ? (
                        <div>
                          <div className="font-mono text-xs">{o.vehicleNo}</div>
                          {o.driverName && (
                            <div className="text-[10px] text-gray-500">{o.driverName}</div>
                          )}
                        </div>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {(o.deliveries || []).map((d, i) => (
                        <div key={i} className="text-xs whitespace-nowrap">
                          {i > 0 && <span className="text-gray-400 mr-1">+</span>}
                          {d.tankName || d.tankCode}
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => setModal({
                          mode: "repeat",
                          seed: {
                            supplier:      o.supplier,
                            supplierPhone: o.supplierPhone,
                            vehicleNo:     o.vehicleNo,
                            driverName:    o.driverName,
                            driverPhone:   o.driverPhone,
                            waterType:     o.waterType,
                            receivedBy:    o.receivedBy,
                            volumeL:       o.volumeL,
                            notes:         o.notes,
                            deliveries: (o.deliveries || []).map((d) => ({ tankCode: d.tankCode })),
                          },
                        })}
                        className="text-gray-400 hover:text-blue-600 px-1"
                        title="Repeat this order (date + cost blank)"
                        aria-label="Repeat"
                      >
                        ↻
                      </button>
                      {canEditAll && (
                        <>
                          <button
                            onClick={() => setModal({
                              mode: "edit",
                              seed: {
                                orderId:       o.orderId,
                                supplier:      o.supplier ?? "",
                                supplierPhone: o.supplierPhone ?? "",
                                vehicleNo:     o.vehicleNo ?? "",
                                driverName:    o.driverName ?? "",
                                driverPhone:   o.driverPhone ?? "",
                                waterType:     o.waterType ?? "",
                                receivedBy:    o.receivedBy ?? "",
                                paymentStatus: o.paymentStatus ?? "",
                                paymentMode:   o.paymentMode ?? "",
                                volumeL:       o.volumeL ?? "",
                                cost:          o.cost ?? "",
                                notes:         o.notes ?? "",
                                deliveredAt:   o.deliveredAt,
                                deliveries: (o.deliveries || []).map((d) => ({ tankCode: d.tankCode })),
                              },
                            })}
                            className="text-gray-400 hover:text-blue-600 px-1"
                            title="Edit"
                            aria-label="Edit"
                          >
                            ✎
                          </button>
                          <button
                            onClick={() => handleDelete(o)}
                            className="text-gray-400 hover:text-red-600 px-1"
                            title="Delete"
                            aria-label="Delete"
                          >
                            🗑
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <LogDeliveryModal
          mode={modal.mode}
          seed={modal.seed}
          devices={devices}
          supplierIndex={supplierIndex}
          driverIndex={driverIndex}
          vehicleSuggestions={vehicleSuggestions}
          onSave={handleSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Log Delivery Modal
// ─────────────────────────────────────────────────────────────────
// Field order (per Vishal): delivery basics first, then who
// delivered, then who received + paid, notes, tanks LAST.
// Property manager doesn't know per-tank volume of a split, so no
// per-tank volume input — just tank codes for splits. Chart marker
// appears on each participating tank regardless.
function LogDeliveryModal({ mode, seed, devices, supplierIndex, driverIndex, vehicleSuggestions, onSave, onClose }) {
  const now = new Date();
  const isEdit = mode === "edit";
  const isRepeat = mode === "repeat";

  const lastTank = typeof window !== "undefined" ? localStorage.getItem(LS_LAST_TANK) : null;

  const initialDeliveries = seed?.deliveries?.length
    ? seed.deliveries.map((d) => ({ tankCode: d.tankCode || "" }))
    : [{
        tankCode: lastTank && devices.some((x) => x.deviceCode === lastTank) ? lastTank : "",
      }];

  // Delivered at defaults to now (per Vishal — today's date/time).
  const [deliveredAtLocal, setDeliveredAtLocal] = useState(() =>
    isEdit && seed?.deliveredAt ? tsToLocalInput(seed.deliveredAt) : tsToLocalInput(now)
  );

  // Volume entered in KL for UX (tanker capacities are always
  // quoted in KL — "10 KL tanker", nobody says "10000 litres").
  // Stored in Firestore as litres (canonical unit for the whole
  // app) — we multiply on save, divide on load.
  const [volumeKL, setVolumeKL] = useState(() => {
    if (seed?.volumeL == null || seed.volumeL === "") return "";
    const kl = seed.volumeL / 1000;
    // Trim trailing zeros — 10.0 → "10", 7.5 → "7.5"
    return kl.toString();
  });
  const [cost,    setCost]    = useState(isEdit ? (seed?.cost ?? "") : "");
  const [notes,   setNotes]   = useState(seed?.notes ?? "");

  const initialSupplier = seed?.supplier ?? "";
  const [supplier, setSupplier] = useState(initialSupplier);
  const [supplierPhone, setSupplierPhone] = useState(
    seed?.supplierPhone ??
    (initialSupplier && supplierIndex?.phoneByName?.[initialSupplier]) ??
    ""
  );
  const [supplierPhoneTouched, setSupplierPhoneTouched] = useState(!!(seed?.supplierPhone));

  const [vehicleNo, setVehicleNo] = useState(seed?.vehicleNo ?? "");

  const initialDriver = seed?.driverName ?? "";
  const [driverName, setDriverName] = useState(initialDriver);
  const [driverPhone, setDriverPhone] = useState(
    seed?.driverPhone ??
    (initialDriver && driverIndex?.phoneByName?.[initialDriver]) ??
    ""
  );
  const [driverPhoneTouched, setDriverPhoneTouched] = useState(!!(seed?.driverPhone));

  const [waterType,     setWaterType]     = useState(seed?.waterType ?? "");
  const [receivedBy,    setReceivedBy]    = useState(seed?.receivedBy ?? "");
  const [paymentStatus, setPaymentStatus] = useState(seed?.paymentStatus ?? "");
  const [paymentMode,   setPaymentMode]   = useState(seed?.paymentMode ?? "");

  const [deliveries, setDeliveries] = useState(initialDeliveries);
  const [splitMode,  setSplitMode]  = useState(initialDeliveries.length > 1);
  const [saving,     setSaving]     = useState(false);
  const [err,        setErr]        = useState("");

  function updateDelivery(idx, patch) {
    setDeliveries((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function addSplit() {
    setDeliveries((prev) => [...prev, { tankCode: "" }]);
    setSplitMode(true);
  }

  function removeSplit(idx) {
    setDeliveries((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length ? next : [{ tankCode: "" }];
    });
    if (deliveries.length <= 2) setSplitMode(false);
  }

  // Autofill phone when picking a known supplier/driver — respects
  // manual typing (won't stomp on user-entered values).
  function handleSupplierChange(newName) {
    setSupplier(newName);
    if (!supplierPhoneTouched) {
      const known = supplierIndex?.phoneByName?.[newName];
      setSupplierPhone(known || "");
    }
  }
  function handleSupplierPhoneChange(v) {
    setSupplierPhone(v);
    setSupplierPhoneTouched(true);
  }
  function handleDriverChange(newName) {
    setDriverName(newName);
    if (!driverPhoneTouched) {
      const known = driverIndex?.phoneByName?.[newName];
      setDriverPhone(known || "");
    }
  }
  function handleDriverPhoneChange(v) {
    setDriverPhone(v);
    setDriverPhoneTouched(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");

    const validDeliveries = deliveries
      .filter((d) => d.tankCode)
      .map((d) => ({ tankCode: d.tankCode }));
    if (validDeliveries.length === 0) {
      setErr("Pick at least one tank.");
      return;
    }

    setSaving(true);
    try {
      await onSave({
        deliveredAt:   localInputToDate(deliveredAtLocal),
        // KL → L for storage. Round to nearest litre to avoid
        // floating-point noise like 7500.0000000000001.
        volumeL:       volumeKL === "" ? null : Math.round(Number(volumeKL) * 1000),
        cost:          cost === "" ? null : Number(cost),
        supplier:      supplier.trim() || null,
        supplierPhone: supplierPhone.trim() || null,
        vehicleNo:     vehicleNo.trim() || null,
        driverName:    driverName.trim() || null,
        driverPhone:   driverPhone.trim() || null,
        waterType:     waterType || null,
        receivedBy:    receivedBy.trim() || null,
        paymentStatus: paymentStatus || null,
        // Only save payment mode when marked paid (otherwise it's
        // meaningless data).
        paymentMode:   paymentStatus === "paid" ? (paymentMode || null) : null,
        notes:         notes.trim() || null,
        deliveries:    validDeliveries,
      });
    } finally {
      setSaving(false);
    }
  }

  const fieldLabel = "text-xs font-medium text-gray-700";
  const fieldInput = "mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
         onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-1">
          {isEdit ? "Edit tanker entry" : isRepeat ? "Repeat tanker entry" : "Log tanker delivery"}
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          {isRepeat ? "Fields copied from a previous entry. Date defaults to now; enter fresh cost."
                    : "All fields except tank are optional."}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">

          {/* SECTION 1 — Delivery basics: Volume, Cost, When */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={fieldLabel}>Volume (KL)</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={volumeKL}
                  onChange={(e) => setVolumeKL(e.target.value)}
                  placeholder="e.g. 10"
                  className={fieldInput + " font-semibold"}
                />
              </label>
              <label className="block">
                <span className={fieldLabel}>Cost (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="Optional"
                  className={fieldInput}
                />
              </label>
            </div>
            <label className="block">
              <span className={fieldLabel}>Delivered at</span>
              <input
                type="datetime-local"
                value={deliveredAtLocal}
                onChange={(e) => setDeliveredAtLocal(e.target.value)}
                className={fieldInput}
                required
              />
            </label>
          </div>

          {/* SECTION 2 — Who delivered */}
          <div className="space-y-3 bg-gray-50 rounded-lg p-3 border border-gray-200">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Who delivered</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={fieldLabel}>Supplier</span>
                <input
                  type="text"
                  list="tanker-supplier-list"
                  value={supplier}
                  onChange={(e) => handleSupplierChange(e.target.value)}
                  placeholder="Optional"
                  className={fieldInput}
                />
                <datalist id="tanker-supplier-list">
                  {supplierIndex.names.map((s) => <option key={s} value={s} />)}
                </datalist>
              </label>
              <label className="block">
                <span className={fieldLabel}>Supplier phone</span>
                <input
                  type="tel"
                  value={supplierPhone}
                  onChange={(e) => handleSupplierPhoneChange(e.target.value)}
                  placeholder="Optional"
                  className={fieldInput}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={fieldLabel}>Vehicle number</span>
                <input
                  type="text"
                  list="tanker-vehicle-list"
                  value={vehicleNo}
                  onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
                  placeholder="e.g. MH14-AB-1234"
                  className={fieldInput + " font-mono"}
                />
                <datalist id="tanker-vehicle-list">
                  {vehicleSuggestions.map((v) => <option key={v} value={v} />)}
                </datalist>
              </label>
              <label className="block">
                <span className={fieldLabel}>Water type</span>
                <select
                  value={waterType}
                  onChange={(e) => setWaterType(e.target.value)}
                  className={fieldInput}
                >
                  <option value="">— select —</option>
                  {WATER_TYPES.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={fieldLabel}>Driver name</span>
                <input
                  type="text"
                  list="tanker-driver-list"
                  value={driverName}
                  onChange={(e) => handleDriverChange(e.target.value)}
                  placeholder="Optional"
                  className={fieldInput}
                />
                <datalist id="tanker-driver-list">
                  {driverIndex.names.map((n) => <option key={n} value={n} />)}
                </datalist>
              </label>
              <label className="block">
                <span className={fieldLabel}>Driver phone</span>
                <input
                  type="tel"
                  value={driverPhone}
                  onChange={(e) => handleDriverPhoneChange(e.target.value)}
                  placeholder="Optional"
                  className={fieldInput}
                />
              </label>
            </div>
          </div>

          {/* SECTION 3 — Received + Payment */}
          <div className="space-y-3 bg-gray-50 rounded-lg p-3 border border-gray-200">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Received & payment</p>
            <label className="block">
              <span className={fieldLabel}>Received by</span>
              <input
                type="text"
                value={receivedBy}
                onChange={(e) => setReceivedBy(e.target.value)}
                placeholder="Optional (watchman / staff name)"
                className={fieldInput}
              />
            </label>
            <div className="flex items-center gap-2">
              <span className={fieldLabel + " shrink-0"}>Payment</span>
              <div className="flex gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => setPaymentStatus(paymentStatus === "paid" ? "" : "paid")}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                    paymentStatus === "paid"
                      ? "bg-green-600 text-white border-green-600"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  ✓ Paid
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentStatus(paymentStatus === "pending" ? "" : "pending")}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                    paymentStatus === "pending"
                      ? "bg-amber-500 text-white border-amber-500"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  Pending
                </button>
              </div>
            </div>
            {paymentStatus === "paid" && (
              <label className="block">
                <span className={fieldLabel}>Payment mode <span className="text-gray-400 font-normal">(optional)</span></span>
                <select
                  value={paymentMode}
                  onChange={(e) => setPaymentMode(e.target.value)}
                  className={fieldInput}
                >
                  <option value="">— select —</option>
                  {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* SECTION 4 — Notes */}
          <label className="block">
            <span className={fieldLabel}>Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional"
              className={fieldInput}
            />
          </label>

          {/* SECTION 5 — Tank(s) at the bottom (per Vishal — "in last
              keep split among water tanks"). Single tank by default;
              toggle reveals multi-tank editor. No per-tank volume —
              manager doesn't know the actual split. */}
          <div className="space-y-2 border-t border-gray-200 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Delivered to which tank?</p>
            {!splitMode ? (
              <label className="block">
                <select
                  value={deliveries[0]?.tankCode || ""}
                  onChange={(e) => updateDelivery(0, { tankCode: e.target.value })}
                  className={fieldInput}
                  required
                >
                  <option value="">— pick tank —</option>
                  {devices.map((d) => (
                    <option key={d.deviceCode} value={d.deviceCode}>
                      {d.deviceName || d.info?.userAssignedName || d.deviceCode}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="space-y-2">
                {deliveries.map((d, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_28px] gap-2 items-center">
                    <select
                      value={d.tankCode}
                      onChange={(e) => updateDelivery(idx, { tankCode: e.target.value })}
                      className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                      required
                    >
                      <option value="">— pick tank —</option>
                      {devices.map((dev) => (
                        <option key={dev.deviceCode} value={dev.deviceCode}>
                          {dev.deviceName || dev.info?.userAssignedName || dev.deviceCode}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeSplit(idx)}
                      disabled={deliveries.length <= 1}
                      className="text-gray-400 hover:text-red-500 text-lg leading-none disabled:opacity-30"
                      title="Remove this split"
                      aria-label="Remove split"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addSplit}
                  className="text-xs text-blue-600 hover:underline mt-1"
                >
                  + Add another tank
                </button>
              </div>
            )}
            {deliveries.length === 1 && (
              <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer mt-1">
                <input
                  type="checkbox"
                  checked={splitMode}
                  onChange={(e) => {
                    setSplitMode(e.target.checked);
                    if (e.target.checked && deliveries.length === 1) {
                      setDeliveries((prev) => [...prev, { tankCode: "" }]);
                    }
                  }}
                />
                Split this tanker across multiple tanks
              </label>
            )}
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex gap-2 pt-2 sticky bottom-0 bg-white">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : isEdit ? "Save changes" : "Save delivery"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
