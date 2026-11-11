import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  frequencyKey,
  isFrequencyValid,
  nextRunAt,
  parseTimeOfDay,
  passNotification,
  planSchedule,
} from "@/lib/schedule";
import type { ScheduleFrequency } from "@/lib/schedule";

const daily = (time: string): ScheduleFrequency => ({ kind: "daily", time });
const every = (hours: number): ScheduleFrequency => ({ kind: "everyHours", hours });

/** Local calendar fields, so the assertions read as the wall clock the user set. */
function local(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(" ");
}

/**
 * Runs `body` in a fixed zone, then puts the process back in its own zone. Deleting TZ is not
 * enough on Windows: Node keeps the last zone it resolved, so the restore names it explicitly.
 */
const HOME_ZONE = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function withTimeZone(zone: string, body: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    body();
  } finally {
    if (previous === undefined) process.env.TZ = HOME_ZONE;
    else process.env.TZ = previous;
  }
}

describe("parseTimeOfDay", () => {
  it("accepts a 24-hour time and rejects anything else", () => {
    expect(parseTimeOfDay("03:00")).toEqual({ hours: 3, minutes: 0 });
    expect(parseTimeOfDay("23:59")).toEqual({ hours: 23, minutes: 59 });
    expect(parseTimeOfDay("00:05")).toEqual({ hours: 0, minutes: 5 });
    for (const bad of ["", "3:00", "24:00", "23:60", "03:0", "03:00:00", "morning"]) {
      expect(parseTimeOfDay(bad), bad).toBeNull();
    }
  });
});

describe("isFrequencyValid", () => {
  it("accepts a valid time and 1 to 168 hours", () => {
    expect(isFrequencyValid(daily("03:00"))).toBe(true);
    expect(isFrequencyValid(every(1))).toBe(true);
    expect(isFrequencyValid(every(168))).toBe(true);
    expect(isFrequencyValid(every(6))).toBe(true);
  });

  it("rejects a broken time and out-of-range hours", () => {
    expect(isFrequencyValid(daily("3am"))).toBe(false);
    expect(isFrequencyValid(every(0))).toBe(false);
    expect(isFrequencyValid(every(169))).toBe(false);
    expect(isFrequencyValid(every(2.5))).toBe(false);
  });
});

describe("frequencyKey", () => {
  it("distinguishes every setting a user can change", () => {
    expect(frequencyKey(daily("03:00"))).toBe("daily:03:00");
    expect(frequencyKey(daily("21:15"))).toBe("daily:21:15");
    expect(frequencyKey(every(6))).toBe("every:6");
  });
});

describe("nextRunAt", () => {
  it("returns today's time when it is still ahead", () => {
    const after = new Date(2026, 10, 12, 1, 30);
    expect(local(nextRunAt(daily("03:00"), after))).toBe("2026-11-12 03:00");
  });

  it("returns tomorrow's time when today's has passed", () => {
    const after = new Date(2026, 10, 12, 4, 0);
    expect(local(nextRunAt(daily("03:00"), after))).toBe("2026-11-13 03:00");
  });

  it("is strictly after the reference, so a pass at the exact time is not repeated", () => {
    const after = new Date(2026, 10, 12, 3, 0, 0, 0);
    expect(local(nextRunAt(daily("03:00"), after))).toBe("2026-11-13 03:00");
  });

  it("rolls over month and year ends", () => {
    expect(local(nextRunAt(daily("03:00"), new Date(2026, 11, 31, 9, 0)))).toBe("2027-01-01 03:00");
    expect(local(nextRunAt(daily("03:00"), new Date(2026, 10, 30, 9, 0)))).toBe("2026-12-01 03:00");
  });

  it("adds whole hours for an interval, measured from the reference", () => {
    const after = new Date(2026, 10, 12, 9, 15);
    expect(local(nextRunAt(every(6), after))).toBe("2026-11-12 15:15");
    expect(local(nextRunAt(every(1), new Date(2026, 10, 12, 23, 30)))).toBe("2026-11-13 00:30");
  });

  it("keeps the chosen wall clock across a daylight-saving change", () => {
    // America/New_York springs forward on 2026-03-08 and falls back on 2026-11-01. Node applies a
    // TZ change to dates created afterwards, which is all this test creates.
    withTimeZone("America/New_York", () => {
      expect(new Date(2026, 6, 1).getTimezoneOffset(), "TZ did not apply").toBe(240);

      const beforeSpring = new Date(2026, 2, 7, 10, 0);
      const spring = nextRunAt(daily("09:00"), beforeSpring);
      expect(local(spring)).toBe("2026-03-08 09:00");
      // 23 wall-clock hours minus the hour the clock skipped.
      expect(spring.getTime() - beforeSpring.getTime()).toBe(22 * 60 * 60 * 1000);

      const beforeFall = new Date(2026, 9, 31, 10, 0);
      const fall = nextRunAt(daily("09:00"), beforeFall);
      expect(local(fall)).toBe("2026-11-01 09:00");
      // 23 wall-clock hours plus the hour the clock repeated.
      expect(fall.getTime() - beforeFall.getTime()).toBe(24 * 60 * 60 * 1000);
    });
  });

  it("runs once on the morning a daily time does not exist", () => {
    withTimeZone("America/New_York", () => {
      expect(new Date(2026, 6, 1).getTimezoneOffset(), "TZ did not apply").toBe(240);
      // 02:30 never happens on 2026-03-08; the local Date normalises it to 03:30 instead of skipping
      // the day or returning a time before the reference.
      const after = new Date(2026, 2, 7, 12, 0);
      const next = nextRunAt(daily("02:30"), after);
      expect(next.getTime()).toBeGreaterThan(after.getTime());
      expect(local(next)).toBe("2026-03-08 03:30");
    });
  });
});

describe("planSchedule", () => {
  const now = new Date(2026, 10, 12, 12, 0);

  it("plans forward from now when nothing was saved", () => {
    const plan = planSchedule(daily("03:00"), {}, now);
    expect(plan.catchUp).toBe(false);
    expect(local(plan.nextDueAt)).toBe("2026-11-13 03:00");
  });

  it("keeps a future due time that was saved", () => {
    const due = new Date(2026, 10, 13, 3, 0);
    const plan = planSchedule(daily("03:00"), { nextDueAt: due.toISOString(), frequency: "daily:03:00" }, now);
    expect(plan.catchUp).toBe(false);
    expect(plan.nextDueAt.getTime()).toBe(due.getTime());
  });

  it("catches up once when the app was closed over the scheduled time", () => {
    const missed = new Date(2026, 10, 12, 8, 0);
    const plan = planSchedule(daily("03:00"), { nextDueAt: missed.toISOString(), frequency: "daily:03:00" }, now);
    expect(plan.catchUp).toBe(true);
    expect(plan.nextDueAt.getTime()).toBe(missed.getTime());
  });

  it("treats a due time that has only just passed as due now, not as a catch-up", () => {
    // Timers fire late by milliseconds, and the heartbeat can wake up seconds after the moment.
    const justNow = new Date(now.getTime() - 30_000);
    const plan = planSchedule(daily("03:00"), { nextDueAt: justNow.toISOString(), frequency: "daily:03:00" }, now);
    expect(plan.catchUp).toBe(false);
    expect(plan.nextDueAt.getTime()).toBe(justNow.getTime());
  });

  it("makes one catch-up for many missed days, not one per day", () => {
    const missed = new Date(2026, 10, 8, 3, 0);
    const plan = planSchedule(daily("03:00"), { nextDueAt: missed.toISOString(), frequency: "daily:03:00" }, now);
    expect(plan.catchUp).toBe(true);
    // The plan carries the single moment that was missed; the scheduler replaces it after that pass.
    expect(plan.nextDueAt.getTime()).toBe(missed.getTime());
  });

  it("replans when the frequency changed, instead of firing for the old one", () => {
    const saved = { nextDueAt: new Date(2026, 10, 11, 3, 0).toISOString(), frequency: "daily:03:00" };
    const plan = planSchedule(every(6), saved, now);
    expect(plan.catchUp).toBe(false);
    expect(local(plan.nextDueAt)).toBe("2026-11-12 18:00");
  });

  it("replans from an unreadable due time", () => {
    const plan = planSchedule(daily("03:00"), { nextDueAt: "not a date", frequency: "daily:03:00" }, now);
    expect(plan.catchUp).toBe(false);
    expect(local(plan.nextDueAt)).toBe("2026-11-13 03:00");
  });
});

describe("passNotification", () => {
  it("says how many files and accounts a pass brought in", () => {
    expect(passNotification({ saved: 12, accounts: 3, failed: 0, authFailed: 0 })).toBe(
      "12 new files from 3 accounts",
    );
    expect(passNotification({ saved: 1, accounts: 1, failed: 0, authFailed: 0 })).toBe(
      "1 new file from 1 account",
    );
  });

  it("stays quiet when nothing changed", () => {
    expect(passNotification({ saved: 0, accounts: 0, failed: 0, authFailed: 0 })).toBeNull();
  });

  it("reports failures, with the sign-in hint when the site asked for a login", () => {
    expect(passNotification({ saved: 0, accounts: 0, failed: 2, authFailed: 2 })).toBe(
      "Update failed for 2 accounts: sign in to x.com again",
    );
    expect(passNotification({ saved: 0, accounts: 0, failed: 1, authFailed: 0 })).toBe(
      "Update failed for 1 account.",
    );
  });

  it("puts a failure ahead of new files, because it needs the user", () => {
    expect(passNotification({ saved: 4, accounts: 2, failed: 1, authFailed: 1 })).toBe(
      "Update failed for 1 account: sign in to x.com again",
    );
  });
});

describe("DEFAULT_SCHEDULE", () => {
  it("is off and nightly", () => {
    expect(DEFAULT_SCHEDULE.enabled).toBe(false);
    expect(DEFAULT_SCHEDULE.frequency).toEqual({ kind: "daily", time: "03:00" });
  });
});
