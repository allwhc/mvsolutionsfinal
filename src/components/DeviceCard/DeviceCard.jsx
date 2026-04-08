import SensorCard from "./SensorCard";
import ValveCard from "./ValveCard";
import MotorCard from "./MotorCard";

// deviceClass: 1=valve, 2=sensor, 3=motor
export default function DeviceCard({ deviceCode, deviceName, live, info, catalog, isOnline, lastCleanedAt, cleanIntervalDays, tankCapacityLitres, alertLowPct, alertHighPct, valveAlertOpenHours, valveAlertClosedHours }) {
  const deviceClass = info?.deviceClass ?? catalog?.deviceClass ?? 2;

  const props = { deviceCode, deviceName, live, info, catalog, isOnline, lastCleanedAt, cleanIntervalDays, tankCapacityLitres, alertLowPct, alertHighPct, valveAlertOpenHours, valveAlertClosedHours };

  switch (deviceClass) {
    case 1:
      return <ValveCard {...props} />;
    case 3:
      return <MotorCard {...props} />;
    case 2:
    default:
      return <SensorCard {...props} />;
  }
}
