import { MobileAccessForm } from "@/components/mobile-access-form";
import { OfflineSettingsForm } from "@/components/offline-settings-form";
import { SettingsForm } from "@/components/settings-form";
import { appVersion } from "@/server/env";
import { listAccounts } from "@/server/library";
import { getMobileStatus } from "@/server/mobile/service";
import { getOfflineEncoderStatus } from "@/server/offline/encoder";
import { getOfflineEstimate } from "@/server/offline/index";
import { getOfflineSettings } from "@/server/offline/settings";
import { getSettings } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, mobile, offline, accounts] = await Promise.all([
    getSettings(),
    getMobileStatus(),
    getOfflineSettings(),
    listAccounts(),
  ]);
  const [offlineEstimate, encoderStatus] = await Promise.all([
    getOfflineEstimate(offline),
    getOfflineEncoderStatus(offline.video.encoder),
  ]);

  return (
    <main className="pt-12 pb-16">
      <SettingsForm
        initial={settings}
        appVersion={appVersion()}
        mobileSlot={<MobileAccessForm initial={mobile} />}
        offlineSlot={
          <OfflineSettingsForm
            initial={offline}
            initialEstimate={offlineEstimate}
            initialEncoderStatus={encoderStatus}
            availableAccounts={accounts.map((account) => account.folder)}
          />
        }
      />
    </main>
  );
}
