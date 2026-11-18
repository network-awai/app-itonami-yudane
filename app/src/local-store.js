// Local record store. It keeps the read/write contract the domain code was
// written against (collection + rkey records, paged listing), but every record
// stays on this device: an in-memory map, persisted to localStorage when one is
// given. Sealed records are encrypted (see below). Nothing here talks to a
// network.

const PAGE_MAX = 100;
const SEALED_PREFIX = "sealed:";

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

async function digest(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  return "sha256-" + hex(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const PASSPHRASE_MIN = 8;
const PBKDF2_ITERATIONS = 600000;

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw sealedError("SEALED_UNAVAILABLE", "Web Crypto is not available, so sealed records cannot be used");
  return s;
}

function sealedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== "string" || [...passphrase].length < PASSPHRASE_MIN) {
    throw sealedError("SEALED_WEAK_PASSPHRASE", `the passphrase needs at least ${PASSPHRASE_MIN} characters`);
  }
}

const b64encode = (bytes) => {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// Metadata bound to the ciphertext. Key order is fixed here, not taken from the stored object.
const sealedAad = (collection, rkey, m) =>
  JSON.stringify(["itonami.sealed.v1", collection, rkey, m.sender, m.readCap, m.keyId, m.createdAt]);

async function deriveKek(passphrase, salt, iterations) {
  const s = subtle();
  const base = await s.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return s.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function wrapDataKey(dataKey, passphrase, iterations, keyId) {
  const s = subtle();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKek(passphrase, salt, iterations);
  const raw = await s.exportKey("raw", dataKey);
  const wrapped = await s.encrypt({ name: "AES-GCM", iv }, kek, raw);
  const id = keyId ?? "k-" + hex(await s.digest("SHA-256", raw)).slice(0, 16);
  return { schema: "itonami.sealed-key.v1", kdf: "PBKDF2-SHA256", iterations, salt: b64encode(salt), iv: b64encode(iv), wrappedKey: b64encode(wrapped), keyId: id };
}

async function unwrapDataKey(vault, passphrase) {
  const s = subtle();
  const kek = await deriveKek(String(passphrase ?? ""), b64decode(vault.salt), vault.iterations);
  let raw;
  try {
    raw = await s.decrypt({ name: "AES-GCM", iv: b64decode(vault.iv) }, kek, b64decode(vault.wrappedKey));
  } catch {
    throw sealedError("SEALED_BAD_PASSPHRASE", "the passphrase is wrong");
  }
  // Import back as non-extractable: page code can use it but not read it out.
  return s.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

let tidCounter = 0;
function nextTid() {
  tidCounter = (tidCounter + 1) % 1000;
  return Date.now().toString(36) + tidCounter.toString(36).padStart(2, "0");
}

export class LocalStore {
  #dataKey = null;

  /**
   * @param {{ did: string, storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void } | null, key?: string, sealIterations?: number }} options
   *   sealIterations: PBKDF2 iterations for a new passphrase (tests lower it; unlocking uses the stored count).
   */
  constructor({ did, storage = null, key = "", sealIterations = PBKDF2_ITERATIONS }) {
    if (!did) throw new Error("LocalStore needs a did");
    this.did = did;
    this.storage = storage;
    this.key = key;
    this.lastSaveError = null;
    if (!Number.isInteger(sealIterations) || sealIterations < 1000) throw new Error("LocalStore: sealIterations must be an integer >= 1000");
    this.sealIterations = sealIterations;
    /** Wrapped sealed-record key, or null before a passphrase is set. */
    this.vault = null;
    /** @type {Map<string, Map<string, { cid: string | null, value: unknown }>>} */
    this.collections = new Map();
    if (storage && key) this.#load();
  }

  #load() {
    let raw = null;
    try { raw = this.storage.getItem(this.key); } catch { raw = null; }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || data.schema !== "itonami.local-store.v1" || typeof data.collections !== "object") return;
    for (const [collection, records] of Object.entries(data.collections)) {
      const map = new Map();
      for (const [rkey, rec] of Object.entries(records ?? {})) map.set(rkey, { cid: rec.cid ?? null, value: rec.value });
      this.collections.set(collection, map);
    }
    const v = data.sealedKey;
    if (v && v.schema === "itonami.sealed-key.v1" && v.kdf === "PBKDF2-SHA256" && Number.isInteger(v.iterations)) this.vault = v;
  }

  #save() {
    if (!this.storage || !this.key) return;
    const collections = {};
    for (const [collection, map] of this.collections) collections[collection] = Object.fromEntries(map);
    try {
      this.storage.setItem(this.key, JSON.stringify({ schema: "itonami.local-store.v1", collections, ...(this.vault ? { sealedKey: this.vault } : {}) }));
      this.lastSaveError = null;
    } catch (error) {
      this.lastSaveError = error;
      throw new Error("local save failed: " + (error?.message ?? String(error)));
    }
  }

  uri(collection, rkey) {
    return `at://${this.did}/${collection}/${rkey}`;
  }

  /**
   * Write a record. Writing an existing rkey replaces it (put semantics): the
   * domain code updates state-machine records this way, and checks for
   * existence itself where a duplicate must be refused.
   */
  async write({ collection, record, rkey }) {
    if (!collection) throw new Error("write: collection is required");
    if (record === null || typeof record !== "object") throw new Error("write: record must be an object");
    const key = rkey || nextTid();
    const map = this.collections.get(collection) ?? new Map();
    const value = JSON.parse(JSON.stringify(record));
    const cid = await digest(JSON.stringify(value));
    map.set(key, { cid, value });
    this.collections.set(collection, map);
    this.#save();
    return { uri: this.uri(collection, key), cid, blobCids: {}, pendingAnchor: 0n };
  }

  /** Read one record (rkey) or a page of a collection (limit, cursor, prefix). */
  async read({ collection, rkey, limit, cursor, prefix }) {
    const map = this.collections.get(collection) ?? new Map();
    const view = (key, rec) => ({ uri: this.uri(collection, key), cid: rec.cid, value: JSON.parse(JSON.stringify(rec.value)) });
    if (rkey) {
      const rec = map.get(rkey);
      return { records: rec ? [view(rkey, rec)] : [] };
    }
    const keys = [...map.keys()].sort();
    const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
    if (start < 0) return { records: [] };
    const size = Math.max(1, Math.min(limit ?? 50, PAGE_MAX));
    const page = keys.slice(start, start + size);
    const next = start + size < keys.length ? page[page.length - 1] : undefined;
    const records = page.filter((k) => !prefix || k.startsWith(prefix)).map((k) => view(k, map.get(k)));
    return next ? { records, cursor: next } : { records };
  }

  // ---- Sealed records -------------------------------------------------------
  //
  // A sealed record is encrypted on this device with AES-GCM-256. The data key
  // is random; a key-encryption key derived from the user's passphrase
  // (PBKDF2-SHA256, random salt) wraps it, and only the wrapped key is stored.
  // While unlocked the data key is held in memory as a non-extractable
  // CryptoKey; lockSealed() drops it. The metadata (sender, read-cap,
  // createdAt, key id) stays readable so records can be filtered by read-cap
  // without decrypting, and is bound to the ciphertext as AES-GCM additional
  // data, so editing it makes decryption fail.
  //
  // The read-cap decides which did may read a record through this API. There
  // is no key exchange: every sealed record on this device uses this device's
  // data key, and nothing is sent anywhere.

  /** "none" (no passphrase set yet), "locked" or "unlocked". */
  sealedState() {
    if (!this.vault) return "none";
    return this.#dataKey ? "unlocked" : "locked";
  }

  /** Set the passphrase and create the data key. Encrypts any plaintext sealed records left by an earlier version. */
  async setupSealKey(passphrase) {
    if (this.vault) throw sealedError("SEALED_EXISTS", "a sealed-record passphrase is already set");
    checkPassphrase(passphrase);
    const s = subtle();
    const dataKey = await s.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const vault = await wrapDataKey(dataKey, passphrase, this.sealIterations);
    this.vault = vault;
    this.#dataKey = await unwrapDataKey(vault, passphrase);
    await this.#migratePlaintextSealed();
    this.#save();
    return { state: this.sealedState(), keyId: vault.keyId };
  }

  /** Unwrap the data key with the passphrase. A wrong passphrase throws SEALED_BAD_PASSPHRASE. */
  async unlockSealed(passphrase) {
    if (!this.vault) throw sealedError("SEALED_NONE", "no sealed-record passphrase is set");
    this.#dataKey = await unwrapDataKey(this.vault, passphrase);
    if (await this.#migratePlaintextSealed()) this.#save();
    return { state: this.sealedState(), keyId: this.vault.keyId };
  }

  lockSealed() {
    this.#dataKey = null;
    return { state: this.sealedState() };
  }

  /** Re-wrap the same data key under a new passphrase; records are not re-encrypted. */
  async changeSealPassphrase(oldPassphrase, newPassphrase) {
    if (!this.vault) throw sealedError("SEALED_NONE", "no sealed-record passphrase is set");
    checkPassphrase(newPassphrase);
    const s = subtle();
    const kek = await deriveKek(oldPassphrase, b64decode(this.vault.salt), this.vault.iterations);
    let raw;
    try {
      raw = await s.decrypt({ name: "AES-GCM", iv: b64decode(this.vault.iv) }, kek, b64decode(this.vault.wrappedKey));
    } catch {
      throw sealedError("SEALED_BAD_PASSPHRASE", "the passphrase is wrong");
    }
    const dataKey = await s.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    const vault = await wrapDataKey(dataKey, newPassphrase, this.sealIterations, this.vault.keyId);
    this.vault = vault;
    this.#dataKey = await unwrapDataKey(vault, newPassphrase);
    this.#save();
    return { state: this.sealedState(), keyId: vault.keyId };
  }

  #requireDataKey(op) {
    if (this.#dataKey) return this.#dataKey;
    if (!this.vault) throw sealedError("SEALED_NONE", `${op}: set a sealed-record passphrase first`);
    throw sealedError("SEALED_LOCKED", `${op}: sealed records are locked`);
  }

  async #seal(collection, rkey, meta, record) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(sealedAad(collection, rkey, meta));
    const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, this.#dataKey, new TextEncoder().encode(JSON.stringify(record)));
    return { ...meta, alg: "A256GCM", iv: b64encode(iv), ct: b64encode(ct) };
  }

  async #open(collection, rkey, stored) {
    const { alg, iv, ct, ...meta } = stored;
    if (alg !== "A256GCM") throw sealedError("SEALED_CORRUPT", `sealed record ${rkey}: unknown algorithm`);
    const aad = new TextEncoder().encode(sealedAad(collection, rkey, meta));
    try {
      const pt = await subtle().decrypt({ name: "AES-GCM", iv: b64decode(iv), additionalData: aad }, this.#dataKey, b64decode(ct));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch {
      throw sealedError("SEALED_CORRUPT", `sealed record ${rkey} failed to decrypt (altered, or another key)`);
    }
  }

  /** Encrypt records written by the read-cap-only version (they carry `value` instead of `ct`). */
  async #migratePlaintextSealed() {
    let changed = 0;
    for (const [collection, map] of this.collections) {
      if (!collection.startsWith(SEALED_PREFIX)) continue;
      for (const [rkey, rec] of map) {
        const v = rec.value;
        if (!v || v.ct !== undefined || !("value" in v)) continue;
        const { value, ...rest } = v;
        const meta = { sender: rest.sender, readCap: rest.readCap, keyId: this.vault.keyId, createdAt: rest.createdAt };
        const sealed = await this.#seal(collection, rkey, meta, value);
        map.set(rkey, { cid: await digest(JSON.stringify(sealed)), value: sealed });
        changed++;
      }
    }
    return changed;
  }

  /** Same signature as the SDK the domain code was written against. Needs the store unlocked. */
  async encryptedWrite({ innerType, record, recipients = [], rkey }) {
    if (!innerType) throw new Error("encryptedWrite: innerType is required");
    if (record === null || typeof record !== "object") throw new Error("encryptedWrite: record must be an object");
    this.#requireDataKey("encryptedWrite");
    const collection = SEALED_PREFIX + innerType;
    const key = rkey || nextTid();
    const readCap = [...new Set([this.did, ...recipients])].sort();
    const meta = { sender: this.did, readCap, keyId: this.vault.keyId, createdAt: new Date().toISOString() };
    const sealed = await this.#seal(collection, key, meta, JSON.parse(JSON.stringify(record)));
    const receipt = await this.write({ collection, record: sealed, rkey: key });
    return { uri: receipt.uri, cid: receipt.cid, keyId: meta.keyId };
  }

  /**
   * Records whose read-cap includes this store's did, decrypted. A store with
   * no passphrase and no sealed records returns an empty page; otherwise it
   * must be unlocked.
   */
  async encryptedRead({ innerType, cursor, limit }) {
    const collection = SEALED_PREFIX + innerType;
    if (!this.vault && this.count(collection) === 0) return { records: [] };
    this.#requireDataKey("encryptedRead");
    const page = await this.read({ collection, cursor, limit });
    const records = [];
    for (const r of page.records) {
      if (!Array.isArray(r.value?.readCap) || !r.value.readCap.includes(this.did)) continue;
      const rkey = r.uri.slice(r.uri.lastIndexOf("/") + 1);
      const value = await this.#open(collection, rkey, r.value);
      records.push({ uri: r.uri, cid: r.cid, value, sender: r.value.sender, createdAt: r.value.createdAt, keyId: r.value.keyId });
    }
    return page.cursor ? { records, cursor: page.cursor } : { records };
  }

  /** All records of a collection, for the UI. */
  list(collection) {
    const map = this.collections.get(collection) ?? new Map();
    return [...map.keys()].sort().map((k) => ({ rkey: k, uri: this.uri(collection, k), value: map.get(k).value }));
  }

  count(collection) {
    return this.collections.get(collection)?.size ?? 0;
  }

  /** Remove every local record (used by the UI's reset). */
  clear() {
    this.collections.clear();
    this.vault = null;
    this.#dataKey = null;
    this.#save();
  }
}
