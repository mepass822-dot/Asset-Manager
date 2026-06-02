import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-cbc";
const SALT = "meta-earth-wallet-agent-salt-v1";

function deriveKey(password: string): Buffer {
  return scryptSync(password, SALT, 32);
}

export function encryptMnemonic(mnemonic: string, password: string): string {
  const key = deriveKey(password);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decryptMnemonic(encrypted: string, password: string): string {
  const [ivHex, encHex] = encrypted.split(":");
  if (!ivHex || !encHex) throw new Error("Invalid encrypted format");
  const key = deriveKey(password);
  const iv = Buffer.from(ivHex, "hex");
  const encData = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encData), decipher.final()]).toString("utf8");
}
