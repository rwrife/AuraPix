const HASH_VERSION = 'v1';
const SALT_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }

  return bytes;
}

async function digestSha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const saltHex = toHex(salt);
  const digestHex = await digestSha256(`${saltHex}:${password}`);
  return `${HASH_VERSION}:${saltHex}:${digestHex}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [version, saltHex, digestHex] = storedHash.split(':');
  if (version !== HASH_VERSION || !saltHex || !digestHex) {
    return false;
  }

  const normalizedSaltHex = toHex(fromHex(saltHex));
  const expected = await digestSha256(`${normalizedSaltHex}:${password}`);
  return expected === digestHex;
}

export function isVersionedPasswordHash(value: string): boolean {
  return value.startsWith(`${HASH_VERSION}:`);
}
