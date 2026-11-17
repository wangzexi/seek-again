// Holiday ranges announced by China's State Council for 2026 and 2027.
// Use the published days off. DeepSeek separately classifies all weekends as off-peak.
const holidays: Readonly<Record<number, ReadonlyArray<readonly [number, number]>>> = {
  2026: [
    [101, 103],
    [215, 223],
    [404, 406],
    [501, 505],
    [619, 621],
    [925, 927],
    [1001, 1007],
  ],
  2027: [
    [101, 103],
    [205, 213],
    [403, 405],
    [501, 505],
    [609, 609],
    [915, 915],
    [1001, 1007],
  ],
};

export function pricingPeriod(now: Date): "peak" | "offPeak" | "unknown" {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const weekday = beijing.getUTCDay();
  const hour = beijing.getUTCHours();
  const peakHour = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  if (weekday === 0 || weekday === 6 || !peakHour) {
    return "offPeak";
  }

  const calendar = holidays[beijing.getUTCFullYear()];
  if (!calendar) {
    return "unknown";
  }
  const date = (beijing.getUTCMonth() + 1) * 100 + beijing.getUTCDate();
  return calendar.some(([start, end]) => date >= start && date <= end) ? "offPeak" : "peak";
}
