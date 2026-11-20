"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runAgain } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { notifyRunsChanged } from "@/lib/task-list";

export function RunAgainButton({
  runId,
  offerFreshCutoff = false,
}: {
  runId: string;
  offerFreshCutoff?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function trigger(freshCutoff?: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await runAgain(runId, freshCutoff === undefined ? undefined : { freshCutoff });
      if (result.ok) {
        notifyRunsChanged();
        router.push("/");
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={pending} onClick={() => trigger()}>
          Run again
        </Button>
        {offerFreshCutoff ? (
          <Button variant="secondary" disabled={pending} onClick={() => trigger(true)}>
            Update from latest
          </Button>
        ) : null}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
