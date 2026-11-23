import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMobileTls, generateLeafCert, generateRootCa } from "@/server/mobile/tls";

describe("mobile TLS certificates", () => {
  it("generates a valid Root CA and SAN leaf certificate accepted by Node's TLS stack", async () => {
    const ca = generateRootCa();
    const leaf = generateLeafCert(ca, ["192.168.0.100", "100.64.1.2"]);

    const caX509 = new X509Certificate(ca.certPem);
    const leafX509 = new X509Certificate(leaf.certPem);

    expect(caX509.ca).toBe(true);
    expect(leafX509.ca).toBe(false);
    expect(leafX509.verify(caX509.publicKey)).toBe(true);
    expect(leafX509.checkIP("192.168.0.100")).toBe("192.168.0.100");
    expect(leafX509.checkIP("100.64.1.2")).toBe("100.64.1.2");
    expect(leafX509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leafX509.checkHost("localhost")).toBe("localhost");
    expect(leafX509.keyUsage).toContain("1.3.6.1.5.5.7.3.1");

    const validityDays = (leafX509.validToDate.getTime() - leafX509.validFromDate.getTime()) / (24 * 3600_000);
    expect(validityDays).toBeLessThanOrEqual(398);

    const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpsGet(
          {
            host: "127.0.0.1",
            port,
            path: "/",
            ca: ca.certPem,
            rejectUnauthorized: true,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          },
        );
        req.on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("encodes IPv6 ULA and link-local addresses as SAN IP entries", () => {
    const ca = generateRootCa();
    const leaf = generateLeafCert(ca, ["fd7a:115c:a1e0::1", "fe80::1%eth0"]);
    const leafX509 = new X509Certificate(leaf.certPem);

    expect(leafX509.checkIP("fd7a:115c:a1e0::1")).toBe("fd7a:115c:a1e0::1");
    expect(leafX509.checkIP("fe80::1")).toBe("fe80::1");
    expect(leafX509.subjectAltName).toContain("IP Address:FD7A:115C:A1E0:0:0:0:0:1");
  });

  it("persists the Root CA in mobile-ca.json and reuses it across restarts", async () => {
    const prevHome = process.env.GATHER_HOME;
    const tempHome = await mkdtemp(join(tmpdir(), "gather-tls-"));
    process.env.GATHER_HOME = tempHome;

    try {
      const first = await ensureMobileTls(["192.168.0.100"]);
      const savedFirst = await readFile(join(tempHome, "mobile-ca.json"), "utf8");
      const second = await ensureMobileTls(["192.168.0.100", "100.64.1.2"]);
      const savedSecond = await readFile(join(tempHome, "mobile-ca.json"), "utf8");

      expect(second.caCertPem).toBe(first.caCertPem);
      expect(second.caKeyPem).toBe(first.caKeyPem);
      expect(savedSecond).toBe(savedFirst);
      expect(new X509Certificate(second.leafCertPem).verify(new X509Certificate(first.caCertPem).publicKey)).toBe(true);

      // Corrupt key mismatch triggers regeneration rather than signing with a mismatched key.
      const other = generateRootCa();
      await writeFile(
        join(tempHome, "mobile-ca.json"),
        JSON.stringify({ keyPem: other.keyPem, certPem: first.caCertPem, createdAt: new Date().toISOString() }),
      );
      const recovered = await ensureMobileTls(["192.168.0.100"]);
      expect(recovered.caCertPem).not.toBe(first.caCertPem);
      expect(new X509Certificate(recovered.leafCertPem).verify(new X509Certificate(recovered.caCertPem).publicKey)).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.GATHER_HOME;
      else process.env.GATHER_HOME = prevHome;
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
