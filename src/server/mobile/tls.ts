import "server-only";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherHome, writeAtomic } from "@/server/store";

// ASN.1 DER primitives for X.509 v3 certificate generation (RFC 5280) signed with ECDSA P-256 + SHA-256.

function derLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTlv(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derTlv(0x31, Buffer.concat(items));
}

function derExplicit(tagNum: number, inner: Buffer): Buffer {
  return derTlv(0xa0 | tagNum, inner);
}

function derImplicit(tagNum: number, content: Buffer): Buffer {
  return derTlv(0x80 | tagNum, content);
}

function derInt(value: number | Buffer): Buffer {
  let buf = typeof value === "number" ? Buffer.from([value]) : Buffer.from(value);
  while (buf.length > 1 && buf[0] === 0 && (buf[1]! & 0x80) === 0) {
    buf = buf.subarray(1);
  }
  if (buf[0]! & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTlv(0x02, buf);
}

function derBool(value: boolean): Buffer {
  return Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
}

function derOctetString(content: Buffer): Buffer {
  return derTlv(0x04, content);
}

function derBitString(content: Buffer, unusedBits = 0): Buffer {
  return derTlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
}

function derUtf8String(text: string): Buffer {
  return derTlv(0x0c, Buffer.from(text, "utf8"));
}

function derOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [40 * parts[0]! + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    if (v === 0) {
      bytes.push(0);
      continue;
    }
    const sub: number[] = [];
    while (v > 0) {
      sub.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    }
    for (let j = 0; j < sub.length - 1; j++) sub[j]! |= 0x80;
    bytes.push(...sub);
  }
  return derTlv(0x06, Buffer.from(bytes));
}

function derUtcOrGenTime(date: Date): Buffer {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  if (y >= 1950 && y <= 2049) {
    const yy = String(y % 100).padStart(2, "0");
    return derTlv(0x17, Buffer.from(`${yy}${m}${d}${hh}${mm}${ss}Z`, "ascii"));
  }
  return derTlv(0x18, Buffer.from(`${y}${m}${d}${hh}${mm}${ss}Z`, "ascii"));
}

function derName(commonName: string, orgName = "grabberX"): Buffer {
  const rdn = (oid: string, val: string) => derSet(derSeq(derOid(oid), derUtf8String(val)));
  return derSeq(rdn("2.5.4.10", orgName), rdn("2.5.4.3", commonName));
}

function derExtension(oid: string, critical: boolean, valueDer: Buffer): Buffer {
  return critical
    ? derSeq(derOid(oid), derBool(true), derOctetString(valueDer))
    : derSeq(derOid(oid), derOctetString(valueDer));
}

// ecdsa-with-SHA256 (1.2.840.10045.4.3.2) — RFC 5758 specifies parameters MUST be omitted
const ALG_ECDSA_SHA256 = derSeq(derOid("1.2.840.10045.4.3.2"));

function spkiBitStringValue(spkiDer: Buffer): Buffer {
  // SubjectPublicKeyInfo ::= SEQUENCE { algorithm AlgorithmIdentifier, subjectPublicKey BIT STRING }
  // Extract the raw public key bytes inside the BIT STRING (excluding the unused-bits byte) for SubjectKeyIdentifier.
  let offset = 1;
  if (spkiDer[offset]! & 0x80) {
    offset += 1 + (spkiDer[offset]! & 0x7f);
  } else {
    offset += 1;
  }
  // Skip algorithm SEQUENCE
  offset += 1;
  const algLenByte = spkiDer[offset]!;
  if (algLenByte & 0x80) {
    const n = algLenByte & 0x7f;
    let algLen = 0;
    for (let i = 0; i < n; i++) algLen = (algLen << 8) | spkiDer[offset + 1 + i]!;
    offset += 1 + n + algLen;
  } else {
    offset += 1 + algLenByte;
  }
  // Now at BIT STRING (0x03)
  offset += 1;
  const bitLenByte = spkiDer[offset]!;
  if (bitLenByte & 0x80) {
    offset += 1 + (bitLenByte & 0x7f);
  } else {
    offset += 1;
  }
  // Skip unused-bits octet
  return spkiDer.subarray(offset + 1);
}

function keyIdentifierOf(spkiDer: Buffer): Buffer {
  return createHash("sha1").update(spkiBitStringValue(spkiDer)).digest();
}

function toPem(label: string, der: Buffer): string {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function signCertificate(tbsDer: Buffer, issuerKey: KeyObject): Buffer {
  const signer = createSign("SHA256");
  signer.update(tbsDer);
  signer.end();
  const sig = signer.sign(issuerKey);
  return derSeq(tbsDer, ALG_ECDSA_SHA256, derBitString(sig));
}

function randomSerial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01;
  return derInt(bytes);
}

function ipv4Bytes(ip: string): Buffer | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (!nums.every((n) => n >= 0 && n <= 255)) return null;
  return Buffer.from(nums);
}

export interface CaBundle {
  caKeyPem: string;
  caCertPem: string;
  caCertDer: Buffer;
  caSubjectDer: Buffer;
  caSpkiDer: Buffer;
}

export function generateRootCa(now = new Date()): { keyPem: string; certPem: string; certDer: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const ski = keyIdentifierOf(spkiDer);
  const subject = derName("grabberX Local Root CA");
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  const notAfter = new Date(now.getTime() + 3650 * 24 * 3600_000); // 10 years

  // KeyUsage: keyCertSign (bit 5) | cRLSign (bit 6) -> 0x06 with 1 unused bit
  const keyUsageVal = derBitString(Buffer.from([0x06]), 1);
  const basicConstraintsVal = derSeq(derBool(true), derInt(0));
  const skiVal = derOctetString(ski);
  const akiVal = derSeq(derImplicit(0, ski));

  const extensions = derSeq(
    derExtension("2.5.29.19", true, basicConstraintsVal),
    derExtension("2.5.29.15", true, keyUsageVal),
    derExtension("2.5.29.14", false, skiVal),
    derExtension("2.5.29.35", false, akiVal),
  );

  const tbs = derSeq(
    derExplicit(0, derInt(2)), // v3
    randomSerial(),
    ALG_ECDSA_SHA256,
    subject,
    derSeq(derUtcOrGenTime(notBefore), derUtcOrGenTime(notAfter)),
    subject,
    spkiDer,
    derExplicit(3, extensions),
  );

  const certDer = signCertificate(tbs, privateKey);
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const certPem = toPem("CERTIFICATE", certDer);
  return { keyPem, certPem, certDer };
}

export function generateLeafCert(
  ca: { keyPem: string; certPem: string },
  hosts: string[],
  now = new Date(),
): { keyPem: string; certPem: string } {
  const caPrivateKey = generateKeyPairSync; // keep import used
  void caPrivateKey;
  const { createPrivateKey, createPublicKey } = require("node:crypto") as typeof import("node:crypto");
  const issuerKey = createPrivateKey(ca.keyPem);
  const issuerPubSpki = createPublicKey(issuerKey).export({ type: "spki", format: "der" });
  const issuerSki = keyIdentifierOf(issuerPubSpki);

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const leafSki = keyIdentifierOf(spkiDer);

  const issuerName = derName("grabberX Local Root CA");
  const subjectName = derName("grabberX Mobile Gallery");
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  // Apple/Chromium enforce max 398 days for leaf certificates
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600_000);

  const sanItems: Buffer[] = [derImplicit(2, Buffer.from("localhost", "ascii")), derImplicit(7, Buffer.from([127, 0, 0, 1]))];
  const seen = new Set<string>(["localhost", "127.0.0.1"]);
  for (const host of hosts) {
    const clean = host.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const ip = ipv4Bytes(clean);
    if (ip) sanItems.push(derImplicit(7, ip));
    else sanItems.push(derImplicit(2, Buffer.from(clean, "ascii")));
  }

  // KeyUsage: digitalSignature (bit 0) -> 0x80 with 7 unused bits
  const keyUsageVal = derBitString(Buffer.from([0x80]), 7);
  // ExtendedKeyUsage: serverAuth (1.3.6.1.5.5.7.3.1)
  const extKeyUsageVal = derSeq(derOid("1.3.6.1.5.5.7.3.1"));
  const basicConstraintsVal = derSeq(); // cA = FALSE
  const sanVal = derSeq(...sanItems);
  const skiVal = derOctetString(leafSki);
  const akiVal = derSeq(derImplicit(0, issuerSki));

  const extensions = derSeq(
    derExtension("2.5.29.19", true, basicConstraintsVal),
    derExtension("2.5.29.15", true, keyUsageVal),
    derExtension("2.5.29.37", false, extKeyUsageVal),
    derExtension("2.5.29.17", false, sanVal),
    derExtension("2.5.29.14", false, skiVal),
    derExtension("2.5.29.35", false, akiVal),
  );

  const tbs = derSeq(
    derExplicit(0, derInt(2)),
    randomSerial(),
    ALG_ECDSA_SHA256,
    issuerName,
    derSeq(derUtcOrGenTime(notBefore), derUtcOrGenTime(notAfter)),
    subjectName,
    spkiDer,
    derExplicit(3, extensions),
  );

  const certDer = signCertificate(tbs, issuerKey);
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const certPem = toPem("CERTIFICATE", certDer);
  return { keyPem, certPem };
}

interface StoredCa {
  keyPem: string;
  certPem: string;
  createdAt: string;
}

function caFile(): string {
  return join(gatherHome(), "mobile-ca.json");
}

export async function ensureMobileTls(hosts: string[]): Promise<{
  caCertPem: string;
  caCertDer: Buffer;
  leafKeyPem: string;
  leafCertPem: string;
}> {
  let ca: StoredCa | null = null;
  try {
    const raw = JSON.parse(await readFile(caFile(), "utf8")) as Partial<StoredCa>;
    if (typeof raw.keyPem === "string" && typeof raw.certPem === "string") {
      const { X509Certificate } = await import("node:crypto");
      const parsed = new X509Certificate(raw.certPem);
      if (new Date(parsed.validTo).getTime() > Date.now() + 30 * 24 * 3600_000) {
        ca = { keyPem: raw.keyPem, certPem: raw.certPem, createdAt: raw.createdAt ?? new Date().toISOString() };
      }
    }
  } catch {
    ca = null;
  }

  if (!ca) {
    const fresh = generateRootCa();
    ca = { keyPem: fresh.keyPem, certPem: fresh.certPem, createdAt: new Date().toISOString() };
    await mkdir(gatherHome(), { recursive: true });
    await writeAtomic(caFile(), JSON.stringify(ca, null, 2));
  }

  const { X509Certificate } = await import("node:crypto");
  const caCertDer = new X509Certificate(ca.certPem).raw;
  const leaf = generateLeafCert(ca, hosts);
  return {
    caCertPem: ca.certPem,
    caCertDer,
    leafKeyPem: leaf.keyPem,
    leafCertPem: leaf.certPem,
  };
}
