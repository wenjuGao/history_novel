/** Historical years have no zero; astronomical year 0 denotes 1 BCE. */
export function historicalToAstronomical(year: number): number {
  if (!Number.isInteger(year) || year === 0 || Math.abs(year) > 10000) throw new Error('历史年份必须是非零整数。');
  return year < 0 ? year + 1 : year;
}
export function astronomicalToHistorical(year: number): number {
  if (!Number.isInteger(year)) throw new Error('年份无效。');
  return year <= 0 ? year - 1 : year;
}
export function overlaps(start: number | null, end: number | null, from: number, to: number): boolean {
  return start !== null && end !== null && start <= to && end >= from;
}
