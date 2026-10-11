import { CompactEncrypt, compactDecrypt, base64url } from "jose";
import {
  canonicalize,
  identityFromSeed,
  utf8,
} from "../../../packages/core/src/index.ts";
import type { KeyBackup } from "./storage.ts";
const alg = "PBES2-HS256+A128KW";
const unlockMessage = "This file did not unlock with that passphrase.";
let decrypting = false;
export function parseBackup(raw: string): KeyBackup {
  if (utf8(raw).byteLength > 16384)
    throw new Error("The backup exceeds 16 KiB.");
  let value: any;
  try {
    value = JSON.parse(canonicalize(utf8(raw)));
  } catch {
    throw new Error("This backup is not valid JSON.");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "format,identity,jwe,version" ||
    value.format !== "jbovlacku-key-backup" ||
    value.version !== 1 ||
    !/^ed25519:[a-f0-9]{64}$/.test(value.identity) ||
    typeof value.jwe !== "string"
  )
    throw new Error("This backup format is not supported.");
  const segments = value.jwe.split(".");
  if (
    segments.length !== 5 ||
    segments.some(
      (s: string) =>
        !/^[A-Za-z0-9_-]+$/.test(s) ||
        base64url.encode(base64url.decode(s)) !== s,
    )
  )
    throw new Error("This backup container is not supported.");
  const header = JSON.parse(canonicalize(base64url.decode(segments[0])));
  if (
    header === null ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    Object.keys(header).sort().join(",") !== "alg,enc,p2c,p2s" ||
    header.alg !== alg ||
    header.enc !== "A256GCM" ||
    header.p2c !== 600000 ||
    typeof header.p2s !== "string" ||
    base64url.decode(header.p2s).length !== 16 ||
    base64url.encode(base64url.decode(header.p2s)) !== header.p2s ||
    base64url.decode(segments[2]).length !== 12 ||
    base64url.decode(segments[4]).length !== 16
  )
    throw new Error("This backup encryption profile is not supported.");
  return value;
}
async function keyFromPkcs8(
  pkcs8: Uint8Array,
): Promise<{ key: CryptoKey; identity: string }> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const canonical = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
  try {
    if (
      canonical.length !== pkcs8.length ||
      canonical.some((n, i) => n !== pkcs8[i])
    )
      throw new Error(unlockMessage);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (jwk.crv !== "Ed25519" || !jwk.d) throw new Error(unlockMessage);
    const seed = base64url.decode(jwk.d);
    try {
      const identity = identityFromSeed(seed);
      const working = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8 as BufferSource,
        { name: "Ed25519" },
        false,
        ["sign"],
      );
      return { key: working, identity };
    } finally {
      seed.fill(0);
    }
  } finally {
    canonical.fill(0);
  }
}
export async function createKey(
  passphrase: string,
): Promise<{ backup: KeyBackup; key: CryptoKey }> {
  if (!isSecureContext || !crypto.subtle)
    throw new Error("Key creation needs a secure browser connection.");
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  try {
    const { key, identity } = await keyFromPkcs8(pkcs8);
    const jwe = await new CompactEncrypt(pkcs8)
      .setProtectedHeader({ alg, enc: "A256GCM" })
      .setKeyManagementParameters({
        p2c: 600000,
        p2s: crypto.getRandomValues(new Uint8Array(16)),
      })
      .encrypt(utf8(passphrase));
    return {
      backup: { format: "jbovlacku-key-backup", version: 1, identity, jwe },
      key,
    };
  } finally {
    pkcs8.fill(0);
  }
}
export async function unlockKey(
  backup: KeyBackup,
  passphrase: string,
): Promise<CryptoKey> {
  if (decrypting) throw new Error("Another backup is still opening.");
  parseBackup(JSON.stringify(backup));
  decrypting = true;
  let plaintext: Uint8Array | undefined;
  try {
    ({ plaintext } = await compactDecrypt(backup.jwe, utf8(passphrase), {
      keyManagementAlgorithms: [alg],
      contentEncryptionAlgorithms: ["A256GCM"],
      maxPBES2Count: 600000,
    }));
    const { key, identity } = await keyFromPkcs8(plaintext);
    if (identity !== backup.identity) throw new Error(unlockMessage);
    return key;
  } catch {
    throw new Error(unlockMessage);
  } finally {
    plaintext?.fill(0);
    decrypting = false;
  }
}
