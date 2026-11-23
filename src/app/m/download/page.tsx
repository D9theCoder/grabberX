import { MobileDownloadClient } from "@/components/mobile/mobile-download-client";
import { SITES } from "@/lib/sites";
import type { SiteId } from "@/lib/spec";
import { getSettings } from "@/server/store";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MobileDownloadPage({ searchParams }: PageProps<"/m/download">) {
  const params = await searchParams;
  const settings = await getSettings();
  const requestedSite = firstParam(params.site);
  const site = SITES.find((entry) => entry.id === requestedSite)?.id as SiteId | undefined;
  const account = firstParam(params.account)?.slice(0, 2048) ?? "";

  return (
    <MobileDownloadClient
      defaults={{
        defaultMedia: settings.defaultMedia,
        defaultLayout: settings.defaultLayout,
        cookies: settings.cookies,
      }}
      initialSite={site}
      initialAccount={account}
    />
  );
}
