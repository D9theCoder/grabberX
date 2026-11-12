"use client";

import { useEffect, useState, useTransition } from "react";
import {
  createPairingOfferAction,
  renameDeviceAction,
  revokeAllDevicesAction,
  revokeDeviceAction,
  setMobileAccessAction,
} from "@/app/settings/mobile-actions";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import type { MobileStatus, PairingOffer } from "@/server/mobile/service";

const AUTO_OFF_OPTIONS = [
  { value: "0", label: "Never" },
  { value: "1", label: "1 hour" },
  { value: "8", label: "8 hours" },
];

const FIREWALL_COMMAND = (port: number) =>
  `netsh advfirewall firewall add rule name="Gather mobile" dir=in action=allow protocol=TCP localport=${port} profile=private`;

function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    // Formatting waits for the browser so the server's time zone and locale cannot cause a hydration mismatch.
    setText(new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  }, [iso]);
  return <>{text}</>;
}

/** The "Mobile gallery" group on the Settings page. */
export function MobileAccessForm({ initial }: { initial: MobileStatus }) {
  const [status, setStatus] = useState(initial);
  const [autoOff, setAutoOff] = useState("0");
  const [address, setAddress] = useState(initial.addresses[0]?.address ?? "");
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  useEffect(() => {
    if (!offer) return;
    const wait = Math.max(0, offer.expiresAt - Date.now());
    const timer = setTimeout(() => setOffer(null), wait);
    return () => clearTimeout(timer);
  }, [offer]);

  const on = status.enabled && status.running;
  const noNetwork = status.addresses.length === 0;
  const selected = status.addresses.find((entry) => entry.address === address) ?? status.addresses[0];

  function toggle(next: boolean) {
    setError(null);
    startBusy(async () => {
      const result = await setMobileAccessAction({
        enabled: next,
        autoOffHours: Number(autoOff),
        forget: false,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus(result.data);
      if (!next) setOffer(null);
    });
  }

  function showCode() {
    setError(null);
    startBusy(async () => {
      const result = await createPairingOfferAction(address);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOffer(result.data);
    });
  }

  function updateDevices(action: () => Promise<{ ok: true; data: MobileStatus } | { ok: false; error: string }>) {
    setError(null);
    startBusy(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else setStatus(result.data);
    });
  }

  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8" aria-labelledby="mobile-title">
      <h2 id="mobile-title" className="m-0 text-title">
        Mobile gallery
      </h2>

      <Switch
        label="Share the gallery on my network"
        checked={on}
        disabled={busy}
        onChange={toggle}
        hint={
          on
            ? "Phones on this network can view your library, read only. They can't download, delete or change anything."
            : "Off. Nothing listens on the network. Turn on to pair an Android phone with a QR code."
        }
      />

      {!on ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-label">Turn off automatically after</span>
          <Segmented label="Turn off automatically after" size="sm" value={autoOff} onChange={setAutoOff} options={AUTO_OFF_OPTIONS} />
        </div>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {on ? (
        <div className="flex flex-col gap-4">
          {noNetwork ? (
            <Notice tone="warning" title="No network found">
              This PC has no private network address. Connect to Wi-Fi or Tailscale, then turn sharing off and on again.
            </Notice>
          ) : (
            <>
              {status.addresses.length > 1 ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-label">Address the phone will use</span>
                  <Segmented
                    label="Address the phone will use"
                    size="sm"
                    value={address}
                    onChange={(value) => {
                      setAddress(value);
                      setOffer(null);
                    }}
                    options={status.addresses.map((entry) => ({
                      value: entry.address,
                      label: `${entry.address}${entry.kind === "tailnet" ? " (Tailscale)" : ""}`,
                    }))}
                  />
                </div>
              ) : null}

              <div>
                <Button variant="primary" onClick={showCode} loading={busy && !offer}>
                  {offer ? "Make a new code" : "Pair a phone"}
                </Button>
              </div>

              {offer ? (
                <div className="flex flex-col gap-2">
                  <div
                    role="img"
                    aria-label="QR code for pairing a phone"
                    className="size-56 bg-white p-2 [&>svg]:size-full"
                    dangerouslySetInnerHTML={{ __html: offer.svg }}
                  />
                  <details className="text-small text-ink-2">
                    <summary className="cursor-pointer">Can&apos;t scan? Use the link instead</summary>
                    <p className="mt-2 mb-1">Open this link on the phone. Anyone who has it before it expires can pair, so don&apos;t share it.</p>
                    <code data-testid="pairing-link" className="block overflow-x-auto bg-sunken p-2 break-all text-ink">
                      {offer.url}
                    </code>
                  </details>
                  <span className="text-small text-ink-2">
                    Scan this with the phone&apos;s camera. It works once and stops working at{" "}
                    {new Date(offer.expiresAt).toLocaleTimeString([], { timeStyle: "short" })}.
                  </span>
                </div>
              ) : null}

              {selected?.kind === "private" ? (
                <Notice tone="info" title="Plain HTTP on your home network">
                  The phone must be on the same Wi-Fi. For access away from home, install Tailscale on both devices. It also
                  encrypts the connection.
                </Notice>
              ) : null}

              <details className="text-small text-ink-2">
                <summary className="cursor-pointer">Phone can&apos;t connect?</summary>
                <p className="mt-2 mb-1">
                  Windows Firewall may block the port. Run this once in an administrator PowerShell:
                </p>
                <code className="block overflow-x-auto bg-sunken p-2 text-ink">{FIREWALL_COMMAND(status.port)}</code>
              </details>
            </>
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-label">Paired phones</span>
          {status.devices.length > 1 ? (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => updateDevices(revokeAllDevicesAction)}>
              Remove all
            </Button>
          ) : null}
        </div>
        {status.devices.length === 0 ? (
          <span className="text-small text-ink-2">No phone is paired.</span>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line border-y border-line p-0">
            {status.devices.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <DeviceName
                    label={device.label}
                    onSave={(label) => updateDevices(() => renameDeviceAction(device.id, label))}
                  />
                  <div className="text-small text-ink-2">
                    Paired <LocalTime iso={device.createdAt} /> · last seen <LocalTime iso={device.lastSeenAt} />
                  </div>
                </div>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => updateDevices(() => revokeDeviceAction(device.id))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!on && status.devices.length > 0 ? (
          <span className="text-small text-ink-2">Sharing is off, so these phones can&apos;t connect until you turn it on.</span>
        ) : null}
      </div>
    </section>
  );
}

function DeviceName({ label, onSave }: { label: string; onSave: (label: string) => void }) {
  const [draft, setDraft] = useState(label);
  useEffect(() => setDraft(label), [label]);
  return (
    <input
      aria-label="Phone name"
      value={draft}
      maxLength={40}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== "" && draft.trim() !== label) onSave(draft);
        else setDraft(label);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="w-full min-w-0 border-0 bg-transparent p-0 text-label font-medium text-ink outline-offset-2"
    />
  );
}
