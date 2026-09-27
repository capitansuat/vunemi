/** Dates the way the lists show them: today, yesterday, then the date — in the current language. */

import { formatDate, t } from "@ocak/i18n";

export function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return t("time.today");
  const yesterday = new Date(today.getTime() - 86_400_000);
  return sameDay(d, yesterday) ? t("time.yesterday") : formatDate(d, { day: "numeric", month: "long", year: "numeric" });
}

export function clock(at: number): string {
  return formatDate(new Date(at), { hour: "2-digit", minute: "2-digit" });
}

/** Keeps the incoming order; lists arrive newest first. */
export function groupByDay<T extends { at: number }>(items: T[]): [string, T[]][] {
  const days = new Map<string, T[]>();
  for (const item of items) {
    const key = dayLabel(item.at);
    const list = days.get(key);
    if (list) list.push(item);
    else days.set(key, [item]);
  }
  return [...days];
}
