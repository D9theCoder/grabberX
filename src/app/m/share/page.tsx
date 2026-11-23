import { MobileShareClient } from "@/components/mobile/mobile-share-client";
import { extractSharedLink } from "@/lib/share-link";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MobileSharePage({ searchParams }: PageProps<"/m/share">) {
  const params = await searchParams;
  const link = extractSharedLink({
    title: firstParam(params.title)?.slice(0, 4096),
    text: firstParam(params.text)?.slice(0, 4096),
    url: firstParam(params.url)?.slice(0, 4096),
  });

  return <MobileShareClient link={link} />;
}
