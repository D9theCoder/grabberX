import { SettingsForm } from "@/components/settings-form";
import { getSettings } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <main className="pt-12 pb-16">
      <SettingsForm initial={settings} />
    </main>
  );
}
