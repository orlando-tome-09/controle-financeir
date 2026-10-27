// Criptografia feita no próprio aparelho: a nuvem só recebe dados embaralhados.
// A chave dos dados é sorteada uma vez e fica na nuvem protegida de dois jeitos:
// pela senha dos dados e pelo código de recuperação.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KDF_ITERATIONS = 600000;
// Sem 0/O e 1/I, para o código não ser digitado errado.
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function toBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function deriveWrappingKey(secret, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function seal(key, bytes) {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

async function unseal(key, box) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.iv) }, key, fromBase64(box.data));
  return new Uint8Array(plain);
}

export function newDataKeyBytes() {
  return randomBytes(32);
}

export function importDataKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function wrapDataKey(raw, secret) {
  const salt = randomBytes(16);
  const key = await deriveWrappingKey(secret, salt, KDF_ITERATIONS);
  return { salt: toBase64(salt), iterations: KDF_ITERATIONS, box: await seal(key, raw) };
}

// Rejeita quando a senha ou o código estão errados.
export async function unwrapDataKey(wrap, secret) {
  const key = await deriveWrappingKey(secret, fromBase64(wrap.salt), wrap.iterations);
  return unseal(key, wrap.box);
}

export function encryptJson(key, value) {
  return seal(key, encoder.encode(JSON.stringify(value)));
}

export async function decryptJson(key, box) {
  return JSON.parse(decoder.decode(await unseal(key, box)));
}

function groupCode(chars) {
  return (chars.match(/.{1,4}/g) || []).join("-");
}

export function newRecoveryCode() {
  return groupCode(Array.from(randomBytes(24), (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join(""));
}

export function normalizeRecoveryCode(text) {
  return groupCode(String(text).toUpperCase().replace(/[^A-Z0-9]/g, ""));
}

// ---- Chave lembrada neste aparelho ----
// Fica no IndexedDB como chave não exportável: o app consegue usar, mas não dá para copiá-la.

const KEYSTORE = "consultorio-chaves";

function openKeystore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEYSTORE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withKeystore(mode, action) {
  const db = await openKeystore();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("keys", mode);
      const request = action(tx.objectStore("keys"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function rememberKey(uid, key) {
  return withKeystore("readwrite", (store) => store.put(key, uid));
}

export function recallKey(uid) {
  return withKeystore("readonly", (store) => store.get(uid));
}

export function forgetKey(uid) {
  return withKeystore("readwrite", (store) => store.delete(uid));
}
