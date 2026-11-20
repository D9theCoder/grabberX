import { formatBytes, formatCount } from "@/lib/format";
import { formatEta, formatSpeed, progressFraction } from "@/lib/progress";
import type { RunProgress } from "@/lib/spec";

interface RunProgressProps {
  progress?: RunProgress;
  active: boolean;
  /** True when the run finished with status "done" (every viewable post was processed). */
  completed?: boolean;
}

/** Speed, data total and ETA for every run; the bar and its estimate only when the site gave a total. */
export function RunProgressView({ progress, active, completed = false }: RunProgressProps) {
  if (!progress) return null;
  const processed = progress.processed ?? 0;
  const showCompleted = !active && completed && progress.total !== undefined && processed > 0;
  const fraction = showCompleted ? 1 : progressFraction(progress, !active);
  const percent = fraction === null ? null : Math.floor(fraction * 100);
  const details: string[] = [];
  if (active) details.push(formatSpeed(progress.bytesPerSec));
  else if (progress.bytes > 0) details.push(`avg ${formatSpeed(progress.bytesPerSec)}`);
  if (progress.bytes > 0) details.push(`${formatBytes(progress.bytes)} downloaded`);
  if (active && progress.etaSeconds !== undefined) details.push(`${formatEta(progress.etaSeconds)} left`);
  if (details.length === 0 && percent === null) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {percent !== null && progress.total ? (
        <>
          <div
            role="progressbar"
            aria-label={showCompleted ? "Progress" : "Estimated progress"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-line"
          >
            <div className="h-full bg-ink" style={{ width: `${percent}%` }} />
          </div>
          {showCompleted ? (
            <p className="m-0 text-small text-ink-2 tabular-nums">
              100% · {formatCount(processed)} {processed === 1 ? "post" : "posts"}
            </p>
          ) : (
            <p
              className="m-0 text-small text-ink-2 tabular-nums"
              title="Estimated from the profile's reported media count; deleted or hidden posts may make the actual total lower."
            >
              About {percent}% · {formatCount(processed)} of ~{formatCount(progress.total)} posts
              <span className="sr-only"> (estimate from the account&apos;s media count)</span>
            </p>
          )}
        </>
      ) : null}
      {details.length > 0 ? <p className="m-0 text-small text-ink-2 tabular-nums">{details.join(" · ")}</p> : null}
    </div>
  );
}
