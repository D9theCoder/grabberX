"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runAgain } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

export function RunAgainButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const result = await runAgain(runId);
      if (result.ok) router.push("/");
      else setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Button variant="primary" loading={pending} onClick={onClick}>
        Run again
      </Button>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
