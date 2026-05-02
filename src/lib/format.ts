const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const diffSec = Math.round((epochMs - now) / 1000);
  const abs = Math.abs(diffSec);
  for (const [unit, seconds] of UNITS) {
    if (abs >= seconds || unit === "second") {
      const value = Math.round(diffSec / seconds);
      return rtf.format(value, unit);
    }
  }
  return rtf.format(0, "second");
}
