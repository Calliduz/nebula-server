import crypto from "crypto";

const KEY_HEX =
  "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
const key = Buffer.from(KEY_HEX, "hex");

/**
 * Decrypts Vidrock stream URLs using AES-256-GCM.
 * @param ciphertextUrl The base64url-encoded encrypted stream URL
 */
export function decryptVidrock(ciphertextUrl: string): string {
  const bytes = Buffer.from(ciphertextUrl, "base64url");

  if (bytes.length < 28) {
    throw new Error("Ciphertext too short");
  }

  // GCM structure: IV (12 bytes) + Ciphertext + Auth Tag (16 bytes)
  const iv = bytes.subarray(0, 12);
  const cipherAndTag = bytes.subarray(12);
  const tag = cipherAndTag.subarray(cipherAndTag.length - 16);
  const ciphertext = cipherAndTag.subarray(0, cipherAndTag.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, undefined, "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
