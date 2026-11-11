/**
 * Time logic for automatic updates. Pure, with no Node APIs: the scheduler, the Settings form and
 * the tests share it, and every function takes the current time instead of reading a clock.
 */

/** A local wall-clock time, "HH:MM", 24-hour. */
export interface DailyFrequency {
  kind: "daily";
  time: string;
}

/** Elapsed hours between passes, so a pass never drifts across a daylight-saving change. */
export interface IntervalFrequency {
  kind: "everyHours";
  hours: number;
}

export type ScheduleFrequency = DailyFrequency | IntervalFrequency;

export interface ScheduleSettings {
  enabled: boolean;
  frequency: ScheduleFrequency;
}

/** Off by default, nightly at 03:00 once it is turned on. */
export const DEFAULT_SCHEDULE: ScheduleSettings = {
  enabled: false,
  frequency: { kind: "daily", time: "03:00" },
};

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 168;

const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const HOUR_MS = 60 * 60 * 1000;

/** What the scheduler remembers between launches, in `.gather/schedule.json`. */
export interface ScheduleState {
  /** ISO time of the next pass the scheduler is waiting for. */
  nextDueAt?: string;
  /** `frequencyKey` of the settings that produced `nextDueAt`, so a change replans from now. */
  frequency?: string;
}

export interface SchedulePlan {
  /** When the next pass should start. A catch-up plan keeps the moment that was missed. */
  nextDueAt: Date;
  /** True when that moment passed while gather was not running. */
  catchUp: boolean;
}

/** Per-account totals of one scheduled pass, for the notification. */
export interface PassResult {
  saved: number;
  /** Accounts that saved at least one file. */
  accounts: number;
  failed: number;
  authFailed: number;
}

export function parseTimeOfDay(value: string): { hours: number; minutes: number } | null {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

export function isFrequencyValid(frequency: ScheduleFrequency): boolean {
  if (frequency.kind === "daily") return parseTimeOfDay(frequency.time) !== null;
  return (
    Number.isInteger(frequency.hours) &&
    frequency.hours >= MIN_INTERVAL_HOURS &&
    frequency.hours <= MAX_INTERVAL_HOURS
  );
}

/** Stable identity of a frequency, so a changed setting replans and an unchanged one does not. */
export function frequencyKey(frequency: ScheduleFrequency): string {
  return frequency.kind === "daily" ? `daily:${frequency.time}` : `every:${frequency.hours}`;
}

/**
 * The first pass strictly after `after`.
 *
 * A daily time is built from local calendar fields on purpose: adding 24 hours of milliseconds would
 * move 03:00 to 02:00 or 04:00 on a daylight-saving day, and "every night at 03:00" must survive the
 * change. On the one morning a chosen time does not exist (the spring-forward hour), the local Date
 * rolls it to the same number of minutes in the next hour, so the pass still runs once.
 */
export function nextRunAt(frequency: ScheduleFrequency, after: Date): Date {
  if (frequency.kind === "everyHours") {
    const hours = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.floor(frequency.hours)));
    return new Date(after.getTime() + hours * HOUR_MS);
  }
  const { hours, minutes } = parseTimeOfDay(frequency.time) ?? { hours: 0, minutes: 0 };
  const today = new Date(
    after.getFullYear(),
    after.getMonth(),
    after.getDate(),
    hours,
    minutes,
    0,
    0,
  );
  if (today.getTime() > after.getTime()) return today;
  return new Date(
    after.getFullYear(),
    after.getMonth(),
    after.getDate() + 1,
    hours,
    minutes,
    0,
    0,
  );
}

/**
 * What a scheduler that just started should do.
 *
 * A saved due time in the past means gather was closed at (or before) the moment it was waiting for:
 * one pass now, not one pass for every day it missed. A missing or unreadable due time, or one saved
 * for a different frequency, is replanned from now.
 */
export function planSchedule(
  frequency: ScheduleFrequency,
  saved: ScheduleState,
  now: Date,
): SchedulePlan {
  const savedAt = saved.frequency === frequencyKey(frequency) ? readDate(saved.nextDueAt) : null;
  if (!savedAt) return { nextDueAt: nextRunAt(frequency, now), catchUp: false };
  return { nextDueAt: savedAt, catchUp: savedAt.getTime() <= now.getTime() };
}

function readDate(value: string | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

export function countNoun(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The notification body for a finished pass, or null when nothing happened. Failures come first
 * because a pass that quietly kept failing is the case a notification exists for.
 */
export function passNotification(result: PassResult): string | null {
  const saved = Math.max(0, Math.floor(result.saved));
  const accounts = Math.max(0, Math.floor(result.accounts));
  const failed = Math.max(0, Math.floor(result.failed));
  if (failed > 0) {
    const failedText = `Update failed for ${countNoun("account", failed)}`;
    return result.authFailed > 0 ? `${failedText}: sign in to x.com again` : `${failedText}.`;
  }
  if (saved === 0) return null;
  return `${countNoun("new file", saved)} from ${countNoun("account", accounts)}`;
}
