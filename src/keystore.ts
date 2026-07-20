/**
 * The wallet keystore. The miner's private key lives in `wallet.json` in the
 * app folder (gitignored), either:
 *
 *   - password-protected: encrypted with AES-256-GCM under a key derived from
 *     the password with scrypt (N=2^15). The plaintext key exists only in this
 *     process's memory after the user unlocks it in the UI.
 *   - plain: stored as-is for users who skip the password. Same trust model as
 *     a .env file — anyone with the file controls the wallet.
 *
 * The app can also GENERATE a wallet: the key is created here, shown to the
 * user exactly once in the UI to write down, and stored per the same rules.
 *
 * Back-compat: a PRIVATE_KEY in .env (the old storage) is migrated into a
 * plain wallet.json on first use.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WALLET_PATH, loadPrivateKey as loadEnvKey, writeFileAtomic } from './config';

interface PlainWallet {
  version: 1;
  address: `0x${string}`;
  encrypted: false;
  privateKey: `0x${string}`;
}
interface EncryptedWallet {
  version: 1;
  address: `0x${string}`;
  encrypted: true;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string; // hex
  iv: string; // hex
  ciphertext: string; // hex
  tag: string; // hex
}
type WalletFile = PlainWallet | EncryptedWallet;

/** The decrypted key, held only in this process's memory after unlock. */
let unlockedKey: `0x${string}` | undefined;

const SCRYPT = { n: 2 ** 15, r: 8, p: 1 };

function deriveKey(password: string, salt: Buffer, n = SCRYPT.n, r = SCRYPT.r, p = SCRYPT.p): Buffer {
  return scryptSync(password, salt, 32, { N: n, r, p, maxmem: 512 * 1024 * 1024 });
}

function readWalletFile(): WalletFile | undefined {
  if (!existsSync(WALLET_PATH)) return undefined;
  return JSON.parse(readFileSync(WALLET_PATH, 'utf8')) as WalletFile;
}

function writeWalletFile(w: WalletFile): void {
  // Atomic: a crash mid-write can never corrupt (and thereby lose) the wallet.
  writeFileAtomic(WALLET_PATH, JSON.stringify(w, null, 2) + '\n', 0o600);
}

function encryptKey(privateKey: `0x${string}`, password: string): EncryptedWallet {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return {
    version: 1,
    address: privateKeyToAccount(privateKey).address,
    encrypted: true,
    kdf: 'scrypt',
    ...{ n: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p },
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

function decryptKey(w: EncryptedWallet, password: string): `0x${string}` {
  const key = deriveKey(password, Buffer.from(w.salt, 'hex'), w.n, w.r, w.p);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(w.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(w.tag, 'hex'));
  try {
    const pk = Buffer.concat([decipher.update(Buffer.from(w.ciphertext, 'hex')), decipher.final()]).toString('utf8');
    return pk as `0x${string}`;
  } catch {
    throw new Error('Wrong password.');
  }
}

/** Migrate a legacy .env PRIVATE_KEY into wallet.json (plain) once. */
function migrateEnvKey(): WalletFile | undefined {
  const pk = loadEnvKey();
  if (!pk) return undefined;
  const w: PlainWallet = { version: 1, address: privateKeyToAccount(pk).address, encrypted: false, privateKey: pk };
  writeWalletFile(w);
  return w;
}

export interface KeyStatus {
  exists: boolean;
  encrypted: boolean;
  /** encrypted and not yet unlocked this session */
  locked: boolean;
  address?: `0x${string}`;
}

export function keyStatus(): KeyStatus {
  const w = readWalletFile() ?? migrateEnvKey();
  if (!w) return { exists: false, encrypted: false, locked: false };
  return {
    exists: true,
    encrypted: w.encrypted,
    locked: w.encrypted && !unlockedKey,
    address: w.address,
  };
}

/** The usable signing key, or undefined if none / still locked. */
export function getKey(): `0x${string}` | undefined {
  const w = readWalletFile() ?? migrateEnvKey();
  if (!w) return undefined;
  if (!w.encrypted) return w.privateKey;
  return unlockedKey;
}

function store(privateKey: `0x${string}`, password?: string, allowOverwrite = false): `0x${string}` {
  // Never silently clobber an existing wallet — replacing the key destroys
  // access to the old account unless the user backed it up.
  const existing = readWalletFile();
  if (existing && !allowOverwrite) {
    throw new Error(
      `A wallet already exists here (${existing.address.slice(0, 10)}…). Back it up (recovery file), delete wallet.json, then try again.`
    );
  }
  const normalized = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('That does not look like a private key (need 64 hex characters).');
  }
  const address = privateKeyToAccount(normalized).address;
  if (password && password.length > 0) {
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    writeWalletFile(encryptKey(normalized, password));
    unlockedKey = normalized; // usable immediately this session
  } else {
    writeWalletFile({ version: 1, address, encrypted: false, privateKey: normalized });
    unlockedKey = undefined;
  }
  return address;
}

/** Generate a brand-new wallet. Returns the key so the UI can show it ONCE. */
export function generateWallet(password?: string): { address: `0x${string}`; privateKey: `0x${string}` } {
  const pk = generatePrivateKey();
  const address = store(pk, password);
  return { address, privateKey: pk };
}

/** Import an existing private key. */
export function importWallet(privateKey: string, password?: string): `0x${string}` {
  return store(privateKey as `0x${string}`, password);
}

/** Unlock an encrypted wallet for this session. Returns the address. */
export function unlockWallet(password: string): `0x${string}` {
  const w = readWalletFile();
  if (!w) throw new Error('No wallet found.');
  if (!w.encrypted) return w.address;
  unlockedKey = decryptKey(w, password);
  return w.address;
}

/**
 * Reveal the private key (for backup). Encrypted wallets require the password
 * even if already unlocked — seeing the key is a bigger deal than using it.
 */
export function revealKey(password?: string): `0x${string}` {
  const w = readWalletFile();
  if (!w) throw new Error('No wallet found.');
  if (!w.encrypted) return w.privateKey;
  if (!password) throw new Error('Password required to reveal the key.');
  return decryptKey(w, password);
}

/** Add/remove password protection on the stored key. */
export function setPassword(newPassword: string | undefined, currentPassword?: string): void {
  const w = readWalletFile();
  if (!w) throw new Error('No wallet found.');
  const pk = w.encrypted ? decryptKey(w, currentPassword ?? '') : w.privateKey;
  store(pk, newPassword, true); // same key, new protection — overwrite is the point
}

/** The wallet file for a recovery download (encrypted if a password was set). */
export function exportWalletFile(): { address: `0x${string}`; contents: string } | undefined {
  const w = readWalletFile();
  if (!w) return undefined;
  return { address: w.address, contents: JSON.stringify(w, null, 2) + '\n' };
}

/** Restore a previously downloaded recovery file. Refuses to clobber a different wallet. */
export function restoreWalletFile(contents: string): `0x${string}` {
  let parsed: WalletFile;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('That is not a valid recovery file.');
  }
  if (parsed?.version !== 1 || typeof parsed.address !== 'string' || typeof parsed.encrypted !== 'boolean') {
    throw new Error('That is not a valid recovery file.');
  }
  if (parsed.encrypted) {
    const e = parsed as EncryptedWallet;
    if (!e.salt || !e.iv || !e.ciphertext || !e.tag) throw new Error('That recovery file is incomplete.');
  } else {
    const pk = (parsed as PlainWallet).privateKey ?? '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('That recovery file is incomplete.');
    // For a plain file the key IS present, so verify its address matches the
    // file's `address` field — otherwise the UI would show one address while
    // the app signs with a different key. (An encrypted file can't be checked
    // without the password; it's validated when unlocked.)
    const derived = privateKeyToAccount(pk as `0x${string}`).address;
    if (derived.toLowerCase() !== parsed.address.toLowerCase()) {
      throw new Error('That recovery file is inconsistent (its address does not match its key).');
    }
  }
  const existing = readWalletFile();
  if (existing && existing.address.toLowerCase() !== parsed.address.toLowerCase()) {
    throw new Error(`A different wallet (${existing.address.slice(0, 10)}…) already exists here — back it up and remove wallet.json first.`);
  }
  writeWalletFile(parsed);
  unlockedKey = undefined;
  return parsed.address;
}

/** Constant-time-ish string check helper (exported for tests). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
