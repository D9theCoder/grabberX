import { redirect } from "next/navigation";
import { checkGalleryDl } from "@/app/actions";
import { WelcomeForm } from "@/components/welcome-form";
import { isConfigured, getSettings } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  if (await isConfigured()) redirect("/");
  const settings = await getSettings();
  const check = await checkGalleryDl(settings.galleryDlPath);

  return (
    <main className="pt-12 pb-16">
      <WelcomeForm
        defaultMediaRoot={settings.mediaRoot}
        defaultBrowser={settings.cookies.browser}
        galleryDl={check.ok ? { ok: true, version: check.data.version } : { ok: false, error: check.error }}
      />
    </main>
  );
}
