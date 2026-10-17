import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS: ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLength, SCRYPT_OPTIONS, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format: scrypt$<salt base64>$<key base64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "base64");
  const expected = Buffer.from(parts[2]!, "base64");
  const actual = await scrypt(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

/** Opaque 256-bit random token handed to the client; only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
