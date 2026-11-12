import { formatBytes, formatCount } from "@/lib/format";
import { formatEta, formatSpeed, progressFraction } from "@/lib/progress";
import type { RunProgress } from "@/lib/spec";

interface RunProgressProps {
  progress?: RunProgress;
  active: boolean;
}

/** Speed, data total and ETA for every run; the bar and its estimate only when the site gave a total. */
export function RunProgressView({ progress, active }: RunProgressProps) {
  if (!progress) return null;
  const fraction = progressFraction(progress, !active);
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
            aria-label="Estimated progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-line"
          >
            <div className="h-full bg-ink" style={{ width: `${percent}%` }} />
          </div>
          <p className="m-0 text-small text-ink-2">
            About {percent}% · {formatCount(progress.processed ?? 0)} of ~{formatCount(progress.total)} posts
            <span className="sr-only"> (estimate from the account&apos;s media count)</span>
          </p>
        </>
      ) : null}
      {details.length > 0 ? <p className="m-0 text-small text-ink-2 tabular-nums">{details.join(" · ")}</p> : null}
    </div>
  );
}
