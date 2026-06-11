const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;

function getKey() {
  const raw = process.env.PAYOUT_ENCRYPTION_KEY || "";
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error("PAYOUT_ENCRYPTION_KEY must be a 32-byte hex key");
  }
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

function decrypt(encryptedString) {
  const [ivHex, authTagHex, encryptedHex] = String(encryptedString || "").split(":");
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Encrypted value is malformed");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { encrypt, decrypt };
