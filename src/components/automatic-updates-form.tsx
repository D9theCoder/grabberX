"use client";

import { useEffect, useState, useTransition } from "react";
import { saveScheduleAction } from "@/app/actions";
import { CheckIcon } from "@/components/icons";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { TextField } from "@/components/ui/text-field";
import { DEFAULT_SCHEDULE } from "@/lib/schedule";
import type { ScheduleFrequency, ScheduleSettings } from "@/lib/schedule";
import type { Settings } from "@/lib/spec";

const DEFAULT_TIME = DEFAULT_SCHEDULE.frequency.kind === "daily" ? DEFAULT_SCHEDULE.frequency.time : "03:00";
const DEFAULT_HOURS = 6;

function Saved() {
  return (
    <span className="inline-flex items-center gap-1 text-ink-2">
      <CheckIcon className="size-3" strokeWidth={2.25} />
      Saved
    </span>
  );
}

/** The "Automatic updates" group on the Settings page. */
export function AutomaticUpdatesForm({ initial }: { initial: Settings }) {
  const [schedule, setSchedule] = useState<ScheduleSettings>(initial.schedule);
  const [kind, setKind] = useState<ScheduleFrequency["kind"]>(initial.schedule.frequency.kind);
  const [draft, setDraft] = useState({
    time: initial.schedule.frequency.kind === "daily" ? initial.schedule.frequency.time : DEFAULT_TIME,
    hours:
      initial.schedule.frequency.kind === "everyHours"
        ? String(initial.schedule.frequency.hours)
        : String(DEFAULT_HOURS),
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  const savedTime = schedule.frequency.kind === "daily" ? schedule.frequency.time : DEFAULT_TIME;
  const savedHours =
    schedule.frequency.kind === "everyHours" ? schedule.frequency.hours : DEFAULT_HOURS;

  function save(changes: Partial<{ enabled: boolean; kind: ScheduleFrequency["kind"]; time: string; hours: string }>) {
    const frequency: ScheduleFrequency =
      (changes.kind ?? kind) === "daily"
        ? { kind: "daily", time: changes.time ?? draft.time }
        : { kind: "everyHours", hours: Number(changes.hours ?? draft.hours) };
    const enabled = changes.enabled ?? schedule.enabled;
    setError(null);

    startSaving(async () => {
      const result = await saveScheduleAction({ enabled, frequency });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const next = result.data.schedule;
      setSchedule(next);
      setKind(next.frequency.kind);
      if (next.frequency.kind === "everyHours") {
        const { hours } = next.frequency;
        setDraft((current) => ({ ...current, hours: String(hours) }));
      }
      setSaved(true);
    });
  }

  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8">
      <h2 className="m-0 text-title">Automatic updates</h2>

      <Switch
        label="Automatic updates"
        checked={schedule.enabled}
        disabled={saving}
        onChange={(enabled) => save({ enabled })}
        hint={
          saving && !saved
            ? "Saving…"
            : saved
              ? <Saved />
              : "grabberX must be running (in the tray) for updates to happen."
        }
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-label">Frequency</span>
        <Segmented
          label="Frequency"
          size="sm"
          value={kind}
          onChange={(value) => save({ kind: value as ScheduleFrequency["kind"] })}
          options={[
            { value: "daily", label: "Every day" },
            { value: "everyHours", label: "Every N hours" },
          ]}
        />
      </div>

      {kind === "daily" ? (
        <TextField
          label="Time"
          type="time"
          mono
          className="w-40"
          value={draft.time}
          disabled={saving}
          hint={saved ? <Saved /> : "24-hour local time, in this PC's clock."}
          onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))}
          onBlur={() => draft.time !== savedTime && save({ time: draft.time })}
        />
      ) : (
        <TextField
          label="Hours between updates"
          type="number"
          min={1}
          max={168}
          mono
          className="w-40"
          value={draft.hours}
          disabled={saving}
          hint={saved ? <Saved /> : "1 to 168 hours, counted from the last pass."}
          onChange={(event) => setDraft((current) => ({ ...current, hours: event.target.value }))}
          onBlur={() => Number(draft.hours) !== savedHours && save({ hours: draft.hours })}
        />
      )}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <p className="m-0 text-small text-ink-2">
        Pause an account in the Library to leave it out of these passes. Each pass only downloads what
        is new, and a run that ends because of a sign-in problem shows up in History.
      </p>
    </section>
  );
}
