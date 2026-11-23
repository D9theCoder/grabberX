import { MobileShareClient } from "@/components/mobile/mobile-share-client";
import { extractXAccountFromShare, extractXPostFromShare } from "@/lib/x-url";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MobileSharePage({ searchParams }: PageProps<"/m/share">) {
  const params = await searchParams;
  const shareInput = {
    title: firstParam(params.title),
    text: firstParam(params.text),
    url: firstParam(params.url),
  };
  const parsedPost = extractXPostFromShare(shareInput);
  const parsedAccount = parsedPost ? null : extractXAccountFromShare(shareInput);

  return <MobileShareClient parsedPost={parsedPost} parsedAccount={parsedAccount} />;
}
