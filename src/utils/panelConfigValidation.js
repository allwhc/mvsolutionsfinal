// Panel Settings validation — cloud-side mirror of the firmware's
// on-device range checks in checkCloudConfig(). Keeping both in one
// shared module means a bad value can't leave the browser: the Save
// button stays disabled until every field passes, and firmware's
// second-pass validation (using the SAME numeric constants) will
// never reject a value the cloud accepted. If firmware's limits change,
// update this file and the Panel-settings block in
// Wired_NAVI_v2_Terrace_cloud.ino together.
//
// The full set of fields + choice lists here mirrors the AP page's
// "Auto Mode Settings" section exactly (see the autoSections HTML in
// the firmware, ~line 5654). Any drift = confused customer who sees
// one set of options at the panel and a different set in the cloud.

// ── Choice lists (must match AP-page <select> options + firmware EEPROM validators) ──
export const MAX_TIME_TO_FULL_CHOICES  = [5, 10, 15, 30, 60, 120];                    // "Max Time to Reach FULL"
export const MAX_RUN_TIME_CHOICES      = [0, 10, 20, 30, 60, 90, 120, 180, 240];     // "Max Continuous Run Time" (0 = off)
export const DRY_RUN_WAIT_CHOICES      = [1, 2, 3, 5, 7, 10, 15];                    // "Wait Between Retries" (dry-run)
export const SOURCE_DEBOUNCE_CHOICES   = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180]; // "Source Confirmation Period"
export const GRACE_PERIOD_TENS_CHOICES = [4, 6, 12, 18, 24, 30, 42, 60];             // "Grace Period" (tens of seconds — 4=40s, 60=10min)
export const RETRY_WAIT_CHOICES        = [1, 2, 3, 5, 7, 10, 15];                    // "Wait Between Retries" (source)
export const MAX_RETRY_CHOICES         = [1, 2, 3, 4, 5];                            // 1-5 (source retries)
export const MAX_DRY_RUN_CHOICES       = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];            // 1-10 (dry-run retries, extended v118.0.9)
export const SMART_CHECK_MINS_CHOICES  = [1, 2, 3, 5, 10, 15, 20, 30, 60];           // smart dry-run check window (v118.0.13: added 20/30/60 for very tall tanks)
export const SMART_MIN_PCT_CHOICES     = [1, 2, 3, 5, 10];                           // smart dry-run minimum rise
export const DETECTION_MODE_CHOICES    = [
  { value: 0, label: "Pre-Detection (detect water first, then start motor)" },
  { value: 1, label: "Post-Detection (start motor first, then detect water)" },
];

// Simple human-readable labels for choice values that need formatting.
export const formatMinutesLabel = (n) => {
  if (n === 0) return "Off (no limit)";
  if (n < 60)  return `${n} min`;
  if (n % 60 === 0) return `${n / 60} hour${n / 60 === 1 ? "" : "s"}`;
  return `${(n / 60).toFixed(1)} hours`;
};
export const formatGraceLabel = (tens) => {
  const secs = tens * 10;
  if (secs < 60)  return `${secs} sec`;
  if (secs % 60 === 0) return `${secs / 60} min`;
  return `${(secs / 60).toFixed(1)} min`;
};

export const LIMITS = {
  autoRecoverTimeoutHours: { min: 1, max: 72 },
};

// Choice-list validator factory — returns a validator that checks
// membership in the whitelist. Non-integer inputs = invalid.
const choiceValidator = (choices, label) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n)) return "Must be a whole number";
  if (!choices.includes(n)) return `${label}: pick one of ${choices.join(", ")}`;
  return null;
};

// Field-level validators. Return null on valid, error string on invalid.
export const VALIDATORS = {
  autoModeEnabled:      (v) => (typeof v === "boolean" ? null : "Must be true or false"),
  dryRunProtectionOn:   (v) => (typeof v === "boolean" ? null : "Must be true or false"),
  hasWPSensor:          (v) => (typeof v === "boolean" ? null : "Must be true or false"),
  autoRecoverOnSchedule:(v) => (typeof v === "boolean" ? null : "Must be true or false"),
  autoRecoverOnTimeout: (v) => (typeof v === "boolean" ? null : "Must be true or false"),
  scheduleModeEnabled:  (v) => (typeof v === "boolean" ? null : "Must be true or false"),

  maxTimeToNextProbeMins: choiceValidator(MAX_TIME_TO_FULL_CHOICES,  "Max time to full"),
  maxDryRunCount:         choiceValidator(MAX_DRY_RUN_CHOICES,       "Max dry-run retries"),
  maxRunTimeMins:         choiceValidator(MAX_RUN_TIME_CHOICES,      "Max run time"),
  dryRunWaitMins:         choiceValidator(DRY_RUN_WAIT_CHOICES,      "Dry-run wait"),
  detectionMode:          choiceValidator([0, 1],                    "Detection mode"),
  sourceDebounceSecs:     choiceValidator(SOURCE_DEBOUNCE_CHOICES,   "Source confirmation period"),
  gracePeriodTens:        choiceValidator(GRACE_PERIOD_TENS_CHOICES, "Grace period"),
  maxRetryCount:          choiceValidator(MAX_RETRY_CHOICES,         "Source retries"),
  retryWaitMins:          choiceValidator(RETRY_WAIT_CHOICES,        "Retry wait"),

  autoRecoverTimeoutHours: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return "Must be a whole number";
    if (n < LIMITS.autoRecoverTimeoutHours.min || n > LIMITS.autoRecoverTimeoutHours.max) {
      return `Must be ${LIMITS.autoRecoverTimeoutHours.min}–${LIMITS.autoRecoverTimeoutHours.max} hours`;
    }
    return null;
  },

  // v118 ultrasonic variant — water level config.
  // Pump start%: 2-98, even values (2% step).
  startPercent: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return "Must be a whole number";
    if (n < 2 || n > 98) return "Must be 2–98%";
    if (n % 2 !== 0) return "Must be an even number (2% step)";
    return null;
  },
  // Pump stop%: 4-100, even, at least 2% above start (checked cross-field below).
  stopPercent: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return "Must be a whole number";
    if (n < 4 || n > 100) return "Must be 4–100%";
    if (n % 2 !== 0) return "Must be an even number (2% step)";
    return null;
  },
  // Tank inner height (cm).
  usTankHeightCm: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return "Must be a whole number";
    // v118.0.8: upper limit matches firmware's 1200 cm (12 m) ceiling —
    // taller than any realistic domestic/commercial tank. Rejecting
    // > 1200 catches obvious data-entry mistakes (e.g. 10000 instead of 1000).
    if (n < 10 || n > 1200) return "Must be 10–1200 cm (max 12 m)";
    return null;
  },
  // Sensor dead-zone offset (cm).
  usSensorOffsetCm: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return "Must be a whole number";
    if (n < 0 || n > 100) return "Must be 0–100 cm";
    return null;
  },
  // Tank capacity in litres (for volume display). Optional — 0 = unset.
  tankVolume: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return "Must be a whole number";
    if (n < 0 || n > 100000) return "Must be 0–100000 litres";
    return null;
  },

  // Schedule = array of exactly 3 slots { enabled, startHour, startMinute, endHour, endMinute }.
  // Firmware struct holds exactly 3 slots. Enabled slots must have end > start with at least
  // 5-minute duration (matches AP page's client-side validateSchedules).
  schedules: (arr) => {
    if (!Array.isArray(arr)) return "Schedules must be an array";
    if (arr.length > 3) return "Max 3 schedules";
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (typeof s.enabled !== "boolean") return `Schedule ${i + 1}: enabled must be boolean`;
      const parts = [s.startHour, s.startMinute, s.endHour, s.endMinute];
      if (parts.some((p) => !Number.isInteger(p))) return `Schedule ${i + 1}: times must be whole numbers`;
      if (s.startHour < 0 || s.startHour > 23)     return `Schedule ${i + 1}: start hour 0-23`;
      if (s.endHour   < 0 || s.endHour   > 23)     return `Schedule ${i + 1}: end hour 0-23`;
      if (s.startMinute < 0 || s.startMinute > 59) return `Schedule ${i + 1}: start minute 0-59`;
      if (s.endMinute   < 0 || s.endMinute   > 59) return `Schedule ${i + 1}: end minute 0-59`;
      if (s.enabled) {
        const startMin = s.startHour * 60 + s.startMinute;
        const endMin   = s.endHour   * 60 + s.endMinute;
        const duration = endMin - startMin;
        if (duration <= 0) return `Schedule ${i + 1}: end must be after start`;
        if (duration < 5)  return `Schedule ${i + 1}: duration must be at least 5 minutes`;
      }
      // v118.0.9: dayMask + fillUntilFull — optional with safe defaults
      // (older cloud deploys that don't send them should still validate).
      if (s.dayMask !== undefined) {
        if (!Number.isInteger(s.dayMask) || s.dayMask < 0 || s.dayMask > 0x7F) {
          return `Schedule ${i + 1}: dayMask must be 0-127`;
        }
        if (s.enabled && (s.dayMask & 0x7F) === 0) {
          return `Schedule ${i + 1}: must run on at least one day`;
        }
      }
      if (s.fillUntilFull !== undefined && typeof s.fillUntilFull !== "boolean") {
        return `Schedule ${i + 1}: fillUntilFull must be boolean`;
      }
    }
    return null;
  },

  // v118.0.9 smart dry-run block
  smartDryRunEnabled: (v) => (typeof v === "boolean" ? null : "Must be true/false"),
  smartDryRunCheckMins: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return "Must be a whole number";
    // v118.0.13: range extended 1-15 → 1-60 for very tall tanks that
    // physically need 20-60 min between measurable level changes.
    if (n < 1 || n > 60) return "Must be 1–60 minutes";
    return null;
  },
  smartDryRunMinPct: (v) => {
    const n = Number(v);
    const allowed = [1, 2, 3, 5, 10];
    if (!allowed.includes(n)) return `Must be one of ${allowed.join(", ")}%`;
    return null;
  },
};

// Run every validator and return { valid: bool, errors: { field: msg } }.
// Missing fields are treated as unset — validators are only run when the
// key exists in the input, so partial forms don't produce noise.
export function validateAll(cfg) {
  const errors = {};
  for (const [field, fn] of Object.entries(VALIDATORS)) {
    if (cfg[field] === undefined) continue;
    const err = fn(cfg[field]);
    if (err) errors[field] = err;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Fill in defaults for any missing field, matching firmware boot defaults
// so a brand-new device with no /config node yet still renders a coherent
// form. Values sourced from Wired_NAVI_v2_Terrace_cloud.ino globals.
export function withDefaults(cfg) {
  return {
    autoModeEnabled:         cfg.autoModeEnabled         ?? true,
    scheduleModeEnabled:     cfg.scheduleModeEnabled     ?? false,

    dryRunProtectionOn:      cfg.dryRunProtectionOn      ?? false,
    maxTimeToNextProbeMins:  cfg.maxTimeToNextProbeMins  ?? 10,
    maxDryRunCount:          cfg.maxDryRunCount          ?? 2,
    maxRunTimeMins:          cfg.maxRunTimeMins          ?? 120,
    dryRunWaitMins:          cfg.dryRunWaitMins          ?? 10,

    hasWPSensor:             cfg.hasWPSensor             ?? false,
    detectionMode:           cfg.detectionMode           ?? 0,
    sourceDebounceSecs:      cfg.sourceDebounceSecs      ?? 30,
    gracePeriodTens:         cfg.gracePeriodTens         ?? 18,
    maxRetryCount:           cfg.maxRetryCount           ?? 3,
    retryWaitMins:           cfg.retryWaitMins           ?? 10,

    autoRecoverOnSchedule:   cfg.autoRecoverOnSchedule   ?? false,
    autoRecoverOnTimeout:    cfg.autoRecoverOnTimeout    ?? false,
    autoRecoverTimeoutHours: cfg.autoRecoverTimeoutHours ?? 4,

    // v118 ultrasonic variant — water level config.
    startPercent:     cfg.startPercent     ?? 30,
    stopPercent:      cfg.stopPercent      ?? 90,
    usTankHeightCm:   cfg.usTankHeightCm   ?? 100,
    usSensorOffsetCm: cfg.usSensorOffsetCm ?? 20,
    tankVolume:       cfg.tankVolume       ?? 0,

    schedules: (Array.isArray(cfg.schedules) && cfg.schedules.length === 3
      ? cfg.schedules
      : [
          { enabled: false, startHour: 6,  startMinute: 0, endHour: 7,  endMinute: 0 },
          { enabled: false, startHour: 18, startMinute: 0, endHour: 19, endMinute: 0 },
          { enabled: false, startHour: 22, startMinute: 0, endHour: 23, endMinute: 0 },
        ]
    ).map((s) => ({
      ...s,
      // v118.0.9: fill in extended fields with safe defaults so pre-118.0.9
      // devices (that never publish these) still render the UI correctly.
      dayMask:       s.dayMask       ?? 0x7F,
      fillUntilFull: s.fillUntilFull ?? false,
    })),

    // v118.0.9 smart dry-run defaults (ON by default per user).
    smartDryRunEnabled:   cfg.smartDryRunEnabled   ?? true,
    smartDryRunCheckMins: cfg.smartDryRunCheckMins ?? 5,
    smartDryRunMinPct:    cfg.smartDryRunMinPct    ?? 2,
  };
}

// Deep-equality check for the form vs. server state — used by the
// "dirty" indicator so we know whether to switch the Save button to
// orange and warn on tab-change.
export function isFormDirty(form, base) {
  if (!base) return false;
  const keys = Object.keys(VALIDATORS);
  for (const k of keys) {
    if (k === "schedules") continue;
    if (form[k] !== base[k]) return true;
  }
  // Schedules array — compare slot by slot.
  const a = form.schedules || [];
  const b = base.schedules || [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i], sb = b[i] || {};
    if (sa.enabled !== sb.enabled) return true;
    if (sa.startHour !== sb.startHour) return true;
    if (sa.startMinute !== sb.startMinute) return true;
    if (sa.endHour !== sb.endHour) return true;
    if (sa.endMinute !== sb.endMinute) return true;
    // v118.0.9 extended fields
    if ((sa.dayMask ?? 0x7F) !== (sb.dayMask ?? 0x7F)) return true;
    if ((sa.fillUntilFull ?? false) !== (sb.fillUntilFull ?? false)) return true;
  }
  return false;
}

// Preset choices for the Force Run modal — must match the AP page's
// dropdown (Wired_NAVI_v2_Terrace_cloud.ino line ~5049). -1 = "until
// tank full" (firmware handles this as a special sentinel value).
export const FORCE_RUN_PRESETS = [
  { value: 5,   label: "5 minutes"      },
  { value: 10,  label: "10 minutes"     },
  { value: 15,  label: "15 minutes"     },
  { value: 30,  label: "30 minutes"     },
  { value: 60,  label: "1 hour"         },
  { value: -1,  label: "Until tank full"},
];
