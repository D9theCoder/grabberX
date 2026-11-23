import "server-only";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from "node:crypto";
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
  let buf: Buffer;
  if (typeof value === "number") {
    if (value === 0) {
      buf = Buffer.from([0]);
    } else {
      const bytes: number[] = [];
      let n = value;
      while (n > 0) {
        bytes.unshift(n & 0xff);
        n = Math.floor(n / 256);
      }
      buf = Buffer.from(bytes);
    }
  } else {
    buf = Buffer.from(value);
  }
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

function readTlv(der: Buffer, offset: number): { tag: number; contentStart: number; contentEnd: number; nextOffset: number } {
  if (offset + 2 > der.length) throw new Error("Truncated DER element.");
  const tag = der[offset]!;
  const lenByte = der[offset + 1]!;
  let len = lenByte;
  let contentStart = offset + 2;
  if (lenByte & 0x80) {
    const octets = lenByte & 0x7f;
    if (octets === 0 || contentStart + octets > der.length) throw new Error("Invalid DER length.");
    len = 0;
    for (let i = 0; i < octets; i++) len = len * 256 + der[contentStart + i]!;
    contentStart += octets;
  }
  const contentEnd = contentStart + len;
  if (contentEnd > der.length) throw new Error("DER element exceeds buffer.");
  return { tag, contentStart, contentEnd, nextOffset: contentEnd };
}

function spkiBitStringValue(spkiDer: Buffer): Buffer {
  const outer = readTlv(spkiDer, 0);
  if (outer.tag !== 0x30) throw new Error("Expected SPKI SEQUENCE.");
  const alg = readTlv(spkiDer, outer.contentStart);
  if (alg.tag !== 0x30) throw new Error("Expected AlgorithmIdentifier SEQUENCE.");
  const bit = readTlv(spkiDer, alg.nextOffset);
  if (bit.tag !== 0x03 || bit.contentStart >= bit.contentEnd) throw new Error("Expected subjectPublicKey BIT STRING.");
  if (spkiDer[bit.contentStart] !== 0) throw new Error("Unexpected unused bits in subjectPublicKey.");
  return spkiDer.subarray(bit.contentStart + 1, bit.contentEnd);
}

function extractCertSubjectDer(certDer: Buffer): Buffer {
  const cert = readTlv(certDer, 0);
  if (cert.tag !== 0x30) throw new Error("Expected Certificate SEQUENCE.");
  const tbs = readTlv(certDer, cert.contentStart);
  if (tbs.tag !== 0x30) throw new Error("Expected TBSCertificate SEQUENCE.");
  let pos = tbs.contentStart;
  const first = readTlv(certDer, pos);
  if (first.tag === 0xa0) pos = first.nextOffset;
  pos = readTlv(certDer, pos).nextOffset; // serialNumber
  pos = readTlv(certDer, pos).nextOffset; // signature
  pos = readTlv(certDer, pos).nextOffset; // issuer
  pos = readTlv(certDer, pos).nextOffset; // validity
  const subject = readTlv(certDer, pos);
  if (subject.tag !== 0x30) throw new Error("Expected Subject Name SEQUENCE.");
  return certDer.subarray(pos, subject.nextOffset);
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

function ipv6Bytes(raw: string): Buffer | null {
  const ip = raw.split("%", 1)[0] ?? "";
  if (!ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const tokens = part.split(":");
    const words: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const v4 = ipv4Bytes(token);
        if (!v4) return null;
        words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(token)) {
        words.push(Number.parseInt(token, 16));
      } else {
        return null;
      }
    }
    return words;
  };

  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length >= 8) return null;

  const zeros = 8 - head.length - tail.length;
  const groups = halves.length === 2 ? [...head, ...new Array<number>(zeros).fill(0), ...tail] : head;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) out.writeUInt16BE(groups[i]!, i * 2);
  return out;
}

function ipBytes(host: string): Buffer | null {
  return ipv4Bytes(host) ?? ipv6Bytes(host);
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
  const issuerKey = createPrivateKey(ca.keyPem);
  const issuerPubSpki = createPublicKey(issuerKey).export({ type: "spki", format: "der" });
  const issuerSki = keyIdentifierOf(issuerPubSpki);
  let issuerName = derName("grabberX Local Root CA");
  if (ca.certPem) {
    const caCert = new X509Certificate(ca.certPem);
    if (!caCert.checkPrivateKey(issuerKey)) {
      throw new Error("CA private key does not match CA certificate.");
    }
    issuerName = extractCertSubjectDer(caCert.raw);
  }

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const leafSki = keyIdentifierOf(spkiDer);

  const subjectName = derName("grabberX Mobile Gallery");
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  // Apple/Chromium enforce max 398 days for leaf certificates
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600_000);

  const sanItems: Buffer[] = [derImplicit(2, Buffer.from("localhost", "ascii")), derImplicit(7, Buffer.from([127, 0, 0, 1]))];
  const seen = new Set<string>(["localhost", "127.0.0.1"]);
  for (const host of hosts) {
    const clean = host.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    const ip = ipBytes(clean);
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
  caKeyPem: string;
  caCertPem: string;
  caCertDer: Buffer;
  leafKeyPem: string;
  leafCertPem: string;
}> {
  let ca: StoredCa | null = null;
  try {
    const raw = JSON.parse(await readFile(caFile(), "utf8")) as Partial<StoredCa>;
    if (typeof raw.keyPem === "string" && typeof raw.certPem === "string") {
      const parsed = new X509Certificate(raw.certPem);
      if (
        parsed.ca &&
        parsed.checkPrivateKey(createPrivateKey(raw.keyPem)) &&
        parsed.validToDate.getTime() > Date.now() + 30 * 24 * 3600_000
      ) {
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

  const caCertDer = new X509Certificate(ca.certPem).raw;
  const leaf = generateLeafCert(ca, hosts);
  return {
    caKeyPem: ca.keyPem,
    caCertPem: ca.certPem,
    caCertDer,
    leafKeyPem: leaf.keyPem,
    leafCertPem: leaf.certPem,
  };
}
