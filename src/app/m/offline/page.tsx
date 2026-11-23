import { OfflineGallery } from "@/components/mobile/offline-gallery";

/**
 * Pure client-rendered offline app shell for the mobile gallery.
 * Reads no PC state on the server so it can be precached once by /m/sw.js and
 * served whenever the PC is unreachable.
 */
export default function MobileOfflinePage() {
  return <OfflineGallery />;
}
