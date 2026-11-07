import { monthName, type Meta, type Month } from "./data";

/** A label on one of the scatterplot's axes, at a share of the data along it. */
export interface Tick {
  share: number;
  label: string;
}

// The closest labels can sit, in pixels.
const MIN_DATE_SPACING = 40;
const MIN_X_SPACING = 96;

// From the finest to the coarsest. The coarsest date label is the month.
const DAY_STEPS = [1, 2, 3, 7, 14];
const LONGITUDE_STEPS = [0.01, 0.02, 0.05, 0.1];
const HOUR_STEPS = [0.5, 1, 2, 3, 6];

function monthLabel({ year, month }: Month, index: number) {
  const name = monthName(month);
  return index === 0 || month === 1 ? `${name} ${year}` : name;
}

/** Labels each month, adding days within the months when `height` leaves room. */
export function dateTicks({ months, days, tStart, tEnd }: Meta, height: number): Tick[] {
  const dayPixels = height / (days.length - 1);
  const step = DAY_STEPS.find((count) => count * dayPixels >= MIN_DATE_SPACING);
  const toTick = (t: number, label: string) => ({ share: t / (tEnd - tStart), label });

  return months.slice(0, -1).flatMap((month, index) => {
    if (!step) return [toTick(month.t, monthLabel(month, index))];
    const ticks = [toTick(month.t, `${monthName(month.month)} 1`)];
    const first = days.indexOf(month.t);
    const length = days.indexOf(months[index + 1]!.t) - first;
    // Leaves a gap before the next month's label.
    for (let day = step; day <= length - step; day += step) {
      ticks.push(toTick(days[first + day]!, `${monthName(month.month)} ${day + 1}`));
    }
    return ticks;
  });
}

/** `width` is how wide all of the data is on screen. */
export function longitudeTicks({ lonMin, lonMax }: Meta["bounds"], width: number): Tick[] {
  const span = lonMax - lonMin;
  const step =
    LONGITUDE_STEPS.find((degrees) => (degrees / span) * width >= MIN_X_SPACING) ??
    LONGITUDE_STEPS[LONGITUDE_STEPS.length - 1]!;
  const ticks: Tick[] = [];
  for (let index = Math.ceil(lonMin / step); index * step <= lonMax; index += 1) {
    const longitude = index * step;
    ticks.push({
      share: (longitude - lonMin) / span,
      label: `${Math.abs(longitude).toFixed(step < 0.1 ? 2 : 1)}°W`,
    });
  }
  return ticks;
}

function hourLabel(hour: number) {
  const whole = Math.floor(hour) % 24;
  const minutes = hour % 1 === 0 ? "" : ":30";
  return `${whole % 12 || 12}${minutes}${whole < 12 ? "am" : "pm"}`;
}

/** `width` is how wide a whole day is on screen. */
export function hourTicks(width: number): Tick[] {
  const step =
    HOUR_STEPS.find((hours) => (hours / 24) * width >= MIN_X_SPACING) ??
    HOUR_STEPS[HOUR_STEPS.length - 1]!;
  const ticks: Tick[] = [];
  for (let hour = 0; hour <= 24; hour += step) {
    ticks.push({ share: hour / 24, label: hourLabel(hour) });
  }
  return ticks;
}
