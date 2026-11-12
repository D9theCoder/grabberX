import { MobileAccessForm } from "@/components/mobile-access-form";
import { SettingsForm } from "@/components/settings-form";
import { appVersion } from "@/server/env";
import { getMobileStatus } from "@/server/mobile/service";
import { getSettings } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, mobile] = await Promise.all([getSettings(), getMobileStatus()]);

  return (
    <main className="pt-12 pb-16">
      <SettingsForm initial={settings} appVersion={appVersion()} mobileSlot={<MobileAccessForm initial={mobile} />} />
    </main>
  );
}
