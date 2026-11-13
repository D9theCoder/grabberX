import { X509Certificate } from "node:crypto";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { generateLeafCert, generateRootCa } from "@/server/mobile/tls";

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
    expect(leafX509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leafX509.checkHost("localhost")).toBe("localhost");

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
});
