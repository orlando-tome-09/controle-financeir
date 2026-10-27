import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, deleteDoc, doc, getDoc, initializeFirestore, onSnapshot, persistentLocalCache, query, setDoc, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import * as vault from "./crypto.js";

const OLD_PATIENTS_KEY = "controle-financeiro-psicologa";
const OLD_SETTINGS_KEY = "controle-financeiro-config";
const MIGRATED_KEY = "consultorio-migrado";
const TAB_KEY = "consultorio-aba";
const TABS = ["financeiro", "relatorios", "conta"];
const MIN_PASSWORD = 8;

const $ = (id) => document.getElementById(id);

let auth = null;
let db = null;
let uid = null;
let profile = null; // users/{uid}: a chave dos dados, protegida pela senha e pelo código
let dataKey = null;
let pendingSetup = null;

let patients = new Map();
let settings = { pixKey: "" };
let patientsReady = false;
let settingsReady = false;
let migrationChecked = false;
let watchers = [];

let reports = new Map();
let reportsReady = false;
let reportsWatcher = null;
let openPatientId = null;
let editing = null;

let removedId = null;
let undoTimer = null;
let noticeTimer = null;

// ---- Utilidades ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function show(screenId) {
  document.querySelectorAll("[data-screen]").forEach((screen) => { screen.hidden = screen.id !== screenId; });
  window.scrollTo(0, 0);
}

function formMsg(id, text, ok) {
  const node = $(id);
  node.textContent = text;
  node.setAttribute("data-state", ok ? "ok" : "error");
}

function busy(button, label) {
  button.dataset.label = button.textContent;
  button.textContent = label;
  button.disabled = true;
}

function idle(button) {
  if (button.dataset.label) button.textContent = button.dataset.label;
  button.disabled = false;
}

function newId() {
  return Date.now().toString(36) + Array.from(vault.randomBytes(4), (byte) => byte.toString(36)).join("");
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function money(n) { return brl.format(n || 0); }

// Aceita "150", "150,50", "150.50", "1.200" e "1.200,00".
function parsePrice(v) {
  let s = String(v).replace(/[^\d.,]/g, "");
  if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return isNaN(n) || n < 0 ? 0 : n;
}
function parseSessions(v) {
  const n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
function parseDueDay(v) {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 31 ? n : 0;
}
function nonNegative(v) { return typeof v === "number" && isFinite(v) && v >= 0 ? v : 0; }
function isIsoDay(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v); }

// Valida o que vem da nuvem, do app antigo ou de um arquivo de backup.
function cleanPatient(raw, id) {
  if (!raw || typeof id !== "string" || !/^[a-z0-9]+$/i.test(id)) return null;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    sessions: Math.floor(nonNegative(raw.sessions)),
    price: nonNegative(raw.price),
    phone: typeof raw.phone === "string" ? raw.phone.slice(0, 30) : "",
    dueDay: parseDueDay(raw.dueDay),
    remindedFor: isIsoDay(raw.remindedFor) ? raw.remindedFor : "",
    createdAt: nonNegative(raw.createdAt),
    archived: raw.archived === true
  };
}

function cleanReport(raw, id) {
  if (!raw) return null;
  return {
    id,
    date: isIsoDay(raw.date) ? raw.date : "",
    title: typeof raw.title === "string" ? raw.title : "",
    text: typeof raw.text === "string" ? raw.text : "",
    createdAt: nonNegative(raw.createdAt),
    updatedAt: nonNegative(raw.updatedAt)
  };
}

function minOf(p) { return p.sessions > 0 ? p.price : 0; }
function maxOf(p) { return p.sessions * p.price; }
function rangeText(p) {
  const lo = minOf(p), hi = maxOf(p);
  return lo === hi ? money(hi) : money(lo) + " a " + money(hi);
}
function sessionsText(n) { return n + (n === 1 ? " sessão" : " sessões"); }
function displayName(p) { return (p && p.name.trim()) || "Paciente sem nome"; }

function activePatients() {
  return Array.from(patients.values())
    .filter((p) => !p.archived)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

// ---- Gravação na nuvem ----
// Cada mudança espera uma pausa na digitação antes de subir. O Firestore guarda
// no aparelho na hora e envia quando houver internet.

const scheduled = new Map();
const encrypting = new Set();
let pendingWrites = 0;
let syncError = "";

function schedule(key, fn, delay) {
  const previous = scheduled.get(key);
  if (previous) clearTimeout(previous.timer);
  scheduled.set(key, { fn, timer: setTimeout(() => run(key), delay || 600) });
  updateSync();
}

function run(key) {
  const entry = scheduled.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  scheduled.delete(key);
  entry.fn();
}

function cancelScheduled(key) {
  const entry = scheduled.get(key);
  if (entry) clearTimeout(entry.timer);
  scheduled.delete(key);
}

function flushAll() {
  Array.from(scheduled.keys()).forEach(run);
}

function isLocallyBusy(key) {
  return scheduled.has(key) || encrypting.has(key);
}

function describeWriteError(e) {
  const code = (e && e.code) || "";
  if (code === "permission-denied") return "A nuvem recusou a gravação. Confira as regras do Firestore.";
  if (code === "resource-exhausted") return "O limite gratuito de hoje acabou. Tente de novo amanhã.";
  return "Não foi possível salvar na nuvem. Tente de novo em instantes.";
}

function track(promise) {
  pendingWrites += 1;
  updateSync();
  return promise.then(() => {
    pendingWrites -= 1;
    syncError = "";
    updateSync();
  }, (e) => {
    pendingWrites -= 1;
    syncError = describeWriteError(e);
    updateSync();
    console.error(e);
  });
}

async function writeEncrypted(key, ref, value, extra) {
  encrypting.add(key);
  try {
    const box = await vault.encryptJson(dataKey, value);
    track(setDoc(ref, Object.assign({}, extra, box)));
  } catch (e) {
    syncError = "Não foi possível proteger os dados antes de salvar.";
    console.error(e);
  } finally {
    encrypting.delete(key);
    updateSync();
  }
}

function updateSync() {
  const waiting = pendingWrites > 0 || scheduled.size > 0 || encrypting.size > 0;
  let state = "ok";
  let text = "Tudo salvo";
  if (syncError) {
    state = "error";
    text = syncError;
  } else if (!navigator.onLine) {
    state = "offline";
    text = waiting ? "Sem internet. As alterações sobem quando a conexão voltar." : "Sem internet";
  } else if (waiting) {
    state = "saving";
    text = "Salvando…";
  }
  $("sync").setAttribute("data-state", state);
  $("sync-text").textContent = text;
}

const userRef = () => doc(db, "users", uid);
const patientRef = (id) => doc(db, "users", uid, "patients", id);
const settingsRef = () => doc(db, "users", uid, "settings", "main");
const reportRef = (id) => doc(db, "users", uid, "reports", id);

function savePatientNow(id) {
  const p = patients.get(id);
  if (!p || !dataKey) return;
  writeEncrypted("patient:" + id, patientRef(id), p);
}

function patientChanged(id) {
  schedule("patient:" + id, () => savePatientNow(id));
}

function saveSettingsNow() {
  if (!dataKey) return;
  writeEncrypted("settings", settingsRef(), settings);
}

// ---- Leitura da nuvem ----

function watchError(e) {
  console.error(e);
  syncError = e && e.code === "permission-denied"
    ? "A nuvem não deixou ler os dados. Confira as regras do Firestore."
    : "A conexão com a nuvem caiu. Feche e abra o app de novo.";
  updateSync();
}

function watchData() {
  stopWatching();
  let chain = Promise.resolve();
  const queue = (fn) => { chain = chain.then(fn).catch((e) => console.error(e)); };
  watchers.push(onSnapshot(collection(db, "users", uid, "patients"), (snap) => {
    const changes = snap.docChanges();
    const fromServer = !snap.metadata.fromCache;
    queue(() => applyPatients(changes, fromServer));
  }, watchError));
  watchers.push(onSnapshot(settingsRef(), (snap) => {
    queue(() => applySettings(snap));
  }, watchError));
}

function stopWatching() {
  watchers.forEach((stop) => stop());
  watchers = [];
}

async function applyPatients(changes, fromServer) {
  if (!dataKey) return;
  let changed = !patientsReady;
  patientsReady = true;
  for (const change of changes) {
    const id = change.doc.id;
    if (change.type === "removed") {
      changed = patients.delete(id) || changed;
      continue;
    }
    // Eco das nossas próprias gravações, ou edição local ainda não enviada.
    if (change.doc.metadata.hasPendingWrites && patients.has(id)) continue;
    if (isLocallyBusy("patient:" + id)) continue;
    let patient = null;
    try {
      patient = cleanPatient(await vault.decryptJson(dataKey, change.doc.data()), id);
    } catch (e) {
      console.error("Não foi possível abrir a paciente " + id, e);
    }
    if (patient && JSON.stringify(patient) !== JSON.stringify(patients.get(id))) {
      patients.set(id, patient);
      changed = true;
    }
  }
  if (fromServer) maybeMigrateOldData();
  if (changed) renderAll();
}

async function applySettings(snap) {
  if (!dataKey) return;
  const wasReady = settingsReady;
  settingsReady = true;
  if (!snap.exists() || isLocallyBusy("settings")) return;
  if (snap.metadata.hasPendingWrites && wasReady) return;
  try {
    const data = await vault.decryptJson(dataKey, snap.data());
    settings = { pixKey: typeof data.pixKey === "string" ? data.pixKey.slice(0, 140) : "" };
  } catch (e) {
    console.error(e);
    return;
  }
  if (document.activeElement !== $("pix")) $("pix").value = settings.pixKey;
  renderReminders();
}

// ---- App antigo (controle financeiro só no aparelho) ----

function readOldData() {
  try {
    const list = JSON.parse(localStorage.getItem(OLD_PATIENTS_KEY) || "null");
    const config = JSON.parse(localStorage.getItem(OLD_SETTINGS_KEY) || "null");
    return {
      patients: Array.isArray(list) ? list : [],
      pixKey: config && typeof config.pixKey === "string" ? config.pixKey : ""
    };
  } catch (e) {
    return { patients: [], pixKey: "" };
  }
}

function hasContent(raw) {
  return raw && ((typeof raw.name === "string" && raw.name.trim()) || raw.price > 0 || (typeof raw.phone === "string" && raw.phone.trim()));
}

function importPatients(list, pixKey) {
  const base = Date.now();
  let added = 0;
  list.forEach((raw, index) => {
    if (!hasContent(raw)) return;
    const patient = cleanPatient(raw, raw.id);
    if (!patient || patients.has(patient.id)) return;
    patient.createdAt = patient.createdAt || base + index;
    patient.archived = false;
    patients.set(patient.id, patient);
    savePatientNow(patient.id);
    added += 1;
  });
  if (pixKey && !settings.pixKey) {
    settings.pixKey = pixKey.slice(0, 140);
    $("pix").value = settings.pixKey;
    saveSettingsNow();
  }
  renderAll();
  return added;
}

// Traz as pacientes do app antigo, uma vez, quando a nuvem ainda está vazia.
function maybeMigrateOldData() {
  if (migrationChecked) return;
  migrationChecked = true;
  try {
    if (localStorage.getItem(MIGRATED_KEY) === "1") return;
  } catch (e) {
    return;
  }
  const old = readOldData();
  if (patients.size === 0 && old.patients.some(hasContent)) {
    const added = importPatients(old.patients, old.pixKey);
    if (added) showNotice(added + (added === 1 ? " paciente veio" : " pacientes vieram") + " do app antigo e já estão protegidas na nuvem.");
  }
  try { localStorage.setItem(MIGRATED_KEY, "1"); } catch (e) {}
}

function showNotice(text) {
  const notice = $("notice");
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 12000);
}

// ---- Login e senha dos dados ----

function isConfigured() {
  return Boolean(firebaseConfig && firebaseConfig.apiKey && !/^COLE/.test(firebaseConfig.apiKey));
}

function showLoading(text, withRetry) {
  $("loading-text").textContent = text;
  $("loading-retry").hidden = !withRetry;
  show("screen-loading");
}

async function afterLogin(user) {
  uid = user.uid;
  $("account-email").textContent = user.email || "";
  showLoading("Abrindo…", false);
  const remembered = await vault.recallKey(uid).catch(() => null);
  if (remembered) {
    openApp(remembered);
    return;
  }
  try {
    const snap = await getDoc(userRef());
    profile = snap.exists() ? snap.data() : null;
  } catch (e) {
    console.error(e);
    showLoading("Não foi possível falar com a nuvem. Confira a internet e tente de novo.", true);
    return;
  }
  if (profile) showUnlock();
  else showSetup();
}

async function ensureProfile() {
  if (profile) return;
  const snap = await getDoc(userRef());
  profile = snap.exists() ? snap.data() : null;
}

function loginErrorText(e) {
  const code = (e && e.code) || "";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) return "E-mail ou senha incorretos.";
  if (code === "auth/too-many-requests") return "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
  if (code === "auth/network-request-failed") return "Sem internet. Conecte o aparelho e tente de novo.";
  if (code === "auth/user-disabled") return "Esta conta foi desativada.";
  return "Não foi possível entrar. Tente de novo.";
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const button = $("login-submit");
  busy(button, "Entrando…");
  formMsg("login-msg", "");
  try {
    await signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-password").value);
    $("login-password").value = "";
  } catch (e) {
    formMsg("login-msg", loginErrorText(e));
  } finally {
    idle(button);
  }
}

async function onForgotAccess() {
  const email = $("login-email").value.trim();
  if (!email) {
    formMsg("login-msg", "Escreva o seu e-mail acima e toque de novo em “Esqueci a senha de acesso”.");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    formMsg("login-msg", "Se o e-mail estiver cadastrado, chega um link para criar uma nova senha de acesso. A senha dos dados não muda.", true);
  } catch (e) {
    formMsg("login-msg", loginErrorText(e));
  }
}

function passwordProblem(password, confirm) {
  if (password.length < MIN_PASSWORD) return "Use pelo menos " + MIN_PASSWORD + " caracteres.";
  if (password !== confirm) return "As duas senhas não são iguais.";
  return "";
}

function showSetup() {
  pendingSetup = null;
  $("setup-form").reset();
  $("setup-saved").checked = false;
  $("setup-finish").disabled = true;
  $("setup-code").textContent = "";
  formMsg("setup-msg", "");
  formMsg("setup-finish-msg", "");
  $("setup-step-password").hidden = false;
  $("setup-step-code").hidden = true;
  show("screen-setup");
}

async function onSetupSubmit(event) {
  event.preventDefault();
  const password = $("setup-password").value;
  const problem = passwordProblem(password, $("setup-confirm").value);
  if (problem) {
    formMsg("setup-msg", problem);
    return;
  }
  const button = $("setup-submit");
  busy(button, "Preparando…");
  try {
    const raw = vault.newDataKeyBytes();
    const code = vault.newRecoveryCode();
    const wraps = await Promise.all([vault.wrapDataKey(raw, password), vault.wrapDataKey(raw, code)]);
    pendingSetup = { raw, profile: { version: 1, createdAt: Date.now(), passwordWrap: wraps[0], recoveryWrap: wraps[1] } };
    $("setup-form").reset();
    $("setup-code").textContent = code;
    $("setup-step-password").hidden = true;
    $("setup-step-code").hidden = false;
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    formMsg("setup-msg", "Não foi possível preparar a proteção neste aparelho.");
  } finally {
    idle(button);
  }
}

async function onSetupFinish() {
  if (!pendingSetup) return;
  const button = $("setup-finish");
  busy(button, "Salvando…");
  try {
    await setDoc(userRef(), pendingSetup.profile);
    profile = pendingSetup.profile;
    const raw = pendingSetup.raw;
    pendingSetup = null;
    $("setup-code").textContent = "";
    await finishUnlock(raw);
  } catch (e) {
    console.error(e);
    formMsg("setup-finish-msg", "Não foi possível salvar na nuvem. Confira a internet e tente de novo.");
  } finally {
    idle(button);
    button.disabled = !$("setup-saved").checked;
  }
}

function showUnlock() {
  $("unlock-form").reset();
  $("recover-form").reset();
  $("recover").open = false;
  formMsg("unlock-msg", "");
  formMsg("recover-msg", "");
  show("screen-unlock");
}

async function finishUnlock(raw) {
  const key = await vault.importDataKey(raw);
  await vault.rememberKey(uid, key).catch(() => {});
  openApp(key);
}

async function onUnlockSubmit(event) {
  event.preventDefault();
  const button = $("unlock-submit");
  busy(button, "Abrindo…");
  formMsg("unlock-msg", "");
  try {
    await ensureProfile();
  } catch (e) {
    formMsg("unlock-msg", "Não foi possível falar com a nuvem. Confira a internet e tente de novo.");
    idle(button);
    return;
  }
  try {
    const raw = await vault.unwrapDataKey(profile.passwordWrap, $("unlock-password").value);
    await finishUnlock(raw);
  } catch (e) {
    formMsg("unlock-msg", "Senha dos dados incorreta.");
  } finally {
    idle(button);
  }
}

async function onRecoverSubmit(event) {
  event.preventDefault();
  const password = $("recover-password").value;
  const problem = passwordProblem(password, $("recover-confirm").value);
  if (problem) {
    formMsg("recover-msg", problem);
    return;
  }
  const button = $("recover-submit");
  busy(button, "Conferindo…");
  try {
    await ensureProfile();
    let raw;
    try {
      raw = await vault.unwrapDataKey(profile.recoveryWrap, vault.normalizeRecoveryCode($("recover-code").value));
    } catch (e) {
      formMsg("recover-msg", "Código de recuperação incorreto.");
      return;
    }
    const passwordWrap = await vault.wrapDataKey(raw, password);
    await setDoc(userRef(), { passwordWrap }, { merge: true });
    profile.passwordWrap = passwordWrap;
    await finishUnlock(raw);
  } catch (e) {
    console.error(e);
    formMsg("recover-msg", "Não foi possível salvar a nova senha. Confira a internet e tente de novo.");
  } finally {
    idle(button);
  }
}

function openApp(key) {
  dataKey = key;
  patients = new Map();
  settings = { pixKey: "" };
  patientsReady = false;
  settingsReady = false;
  migrationChecked = false;
  syncError = "";
  $("pix").value = "";
  show("screen-app");
  selectTab(readTab());
  renderAll();
  updateSync();
  watchData();
}

function resetData() {
  stopWatching();
  stopReports();
  dataKey = null;
  patients = new Map();
  settings = { pixKey: "" };
  patientsReady = false;
  settingsReady = false;
  openPatientId = null;
  editing = null;
  pendingSetup = null;
  hideUndo();
  $("pix").value = "";
  $("report-date").value = "";
  $("report-title").value = "";
  $("report-text").value = "";
  renderAll();
}

async function lockNow() {
  flushAll();
  const lockedUid = uid;
  resetData();
  await vault.forgetKey(lockedUid).catch(() => {});
  showUnlock();
}

async function onSignOut() {
  const waiting = pendingWrites > 0 || scheduled.size > 0;
  if (waiting && !navigator.onLine &&
    !window.confirm("Algumas alterações ainda não subiram para a nuvem porque o aparelho está sem internet. Se sair agora, elas podem se perder. Sair mesmo assim?")) return;
  flushAll();
  const outUid = uid;
  resetData();
  profile = null;
  await vault.forgetKey(outUid).catch(() => {});
  await signOut(auth);
}

// ---- Conta: trocar senha e código de recuperação ----

async function onChangePassword(event) {
  event.preventDefault();
  const form = event.target;
  const next = $("change-new").value;
  const problem = passwordProblem(next, $("change-confirm").value);
  if (problem) {
    formMsg("change-msg", problem);
    return;
  }
  const button = $("change-submit");
  busy(button, "Trocando…");
  try {
    await ensureProfile();
    let raw;
    try {
      raw = await vault.unwrapDataKey(profile.passwordWrap, $("change-current").value);
    } catch (e) {
      formMsg("change-msg", "A senha atual está incorreta.");
      return;
    }
    const passwordWrap = await vault.wrapDataKey(raw, next);
    await setDoc(userRef(), { passwordWrap }, { merge: true });
    profile.passwordWrap = passwordWrap;
    form.reset();
    formMsg("change-msg", "Senha dos dados trocada.", true);
  } catch (e) {
    console.error(e);
    formMsg("change-msg", "Não foi possível trocar a senha. Confira a internet e tente de novo.");
  } finally {
    idle(button);
  }
}

async function onNewCode(event) {
  event.preventDefault();
  const form = event.target;
  const button = $("code-submit");
  busy(button, "Gerando…");
  $("new-code-box").hidden = true;
  try {
    await ensureProfile();
    let raw;
    try {
      raw = await vault.unwrapDataKey(profile.passwordWrap, $("code-current").value);
    } catch (e) {
      formMsg("code-msg", "Senha dos dados incorreta.");
      return;
    }
    const code = vault.newRecoveryCode();
    const recoveryWrap = await vault.wrapDataKey(raw, code);
    await setDoc(userRef(), { recoveryWrap }, { merge: true });
    profile.recoveryWrap = recoveryWrap;
    form.reset();
    $("new-code").textContent = code;
    $("new-code-box").hidden = false;
    formMsg("code-msg", "O código antigo deixou de valer. Guarde este no lugar dele.", true);
  } catch (e) {
    console.error(e);
    formMsg("code-msg", "Não foi possível gerar o código. Confira a internet e tente de novo.");
  } finally {
    idle(button);
  }
}

function onImportFile() {
  const input = $("import-file");
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data = null;
    try { data = JSON.parse(reader.result); } catch (e) {}
    const list = Array.isArray(data) ? data : data && Array.isArray(data.patients) ? data.patients : null;
    if (!list) {
      formMsg("import-msg", "Este arquivo não é um backup do controle financeiro.");
      return;
    }
    const pix = data && data.settings && typeof data.settings.pixKey === "string" ? data.settings.pixKey : "";
    const added = importPatients(list, pix);
    formMsg("import-msg", added
      ? added + (added === 1 ? " paciente importada." : " pacientes importadas.")
      : "Essas pacientes já estavam no app.", true);
  };
  reader.onerror = () => formMsg("import-msg", "Não foi possível ler o arquivo. Tente escolher de novo.");
  reader.readAsText(file);
}

function fallbackCopy(text) {
  const area = el("textarea", "visually-hidden");
  area.value = text;
  area.setAttribute("readonly", "");
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  area.remove();
  return ok;
}

function copyText(text, button, doneLabel) {
  const label = button.dataset.copyLabel || button.textContent;
  button.dataset.copyLabel = label;
  const done = (ok) => {
    button.textContent = ok ? doneLabel : "Não deu para copiar";
    setTimeout(() => { button.textContent = label; }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)));
    return;
  }
  done(fallbackCopy(text));
}

// ---- Abas ----

function readTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.includes(saved) ? saved : "financeiro";
  } catch (e) {
    return "financeiro";
  }
}

function selectTab(name) {
  if (!TABS.includes(name)) name = "financeiro";
  if (name !== "relatorios" && editing) run("report:" + editing.id);
  document.querySelectorAll("[data-tab]").forEach((section) => { section.hidden = section.id !== "tab-" + name; });
  document.querySelectorAll("[data-go]").forEach((button) => {
    if (button.dataset.go === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
  if (name === "relatorios") autosize();
  window.scrollTo(0, 0);
}

function renderAll() {
  renderFinance();
  renderReportsTab();
}

// ---- Financeiro ----

function updateTotals() {
  let min = 0, max = 0, sessions = 0;
  const list = activePatients();
  list.forEach((p) => { min += minOf(p); max += maxOf(p); sessions += p.sessions; });
  $("min").textContent = money(min);
  $("max").textContent = money(max);
  const pct = max > 0 ? Math.round((min / max) * 100) : 0;
  $("fill").style.width = pct + "%";
  $("bar-caption").textContent = "O mínimo representa " + pct + "% do máximo.";
  const np = list.length;
  $("facts").textContent = np + (np === 1 ? " paciente, " : " pacientes, ") + sessions + (sessions === 1 ? " sessão no mês" : " sessões no mês");
}

function patientCard(p, index) {
  const li = el("li", "patient");
  li.innerHTML =
    '<div class="name-field">' +
      '<label class="field-label" for="name-' + p.id + '">Nome da paciente</label>' +
      '<input type="text" id="name-' + p.id + '" placeholder="Paciente ' + (index + 1) + '" autocomplete="off">' +
    '</div>' +
    '<div class="row">' +
      '<div>' +
        '<label class="field-label" for="ses-' + p.id + '">Sessões no mês</label>' +
        '<div class="stepper">' +
          '<button type="button" class="step-btn" data-act="dec" aria-label="Menos uma sessão">−</button>' +
          '<input type="number" id="ses-' + p.id + '" min="0" step="1" inputmode="numeric">' +
          '<button type="button" class="step-btn" data-act="inc" aria-label="Mais uma sessão">+</button>' +
        '</div>' +
      '</div>' +
      '<div>' +
        '<label class="field-label" for="price-' + p.id + '">Valor por sessão (R$)</label>' +
        '<input type="text" id="price-' + p.id + '" inputmode="decimal" placeholder="0,00" autocomplete="off">' +
      '</div>' +
    '</div>' +
    '<div class="row">' +
      '<div>' +
        '<label class="field-label" for="phone-' + p.id + '">Celular (WhatsApp)</label>' +
        '<input type="tel" id="phone-' + p.id + '" inputmode="tel" placeholder="(11) 91234-5678" autocomplete="off">' +
      '</div>' +
      '<div>' +
        '<label class="field-label" for="due-' + p.id + '">Dia do vencimento</label>' +
        '<input type="number" id="due-' + p.id + '" min="1" max="31" step="1" inputmode="numeric" placeholder="Ex.: 10">' +
      '</div>' +
    '</div>' +
    '<div class="patient-total">' +
      '<span>Entra <span class="amount"></span></span>' +
      '<button type="button" class="remove" data-act="remove">Remover</button>' +
    '</div>';

  const nameIn = li.querySelector("#name-" + p.id);
  const sesIn = li.querySelector("#ses-" + p.id);
  const priceIn = li.querySelector("#price-" + p.id);
  const phoneIn = li.querySelector("#phone-" + p.id);
  const dueIn = li.querySelector("#due-" + p.id);
  const amount = li.querySelector(".amount");

  nameIn.value = p.name;
  sesIn.value = p.sessions;
  priceIn.value = p.price ? String(p.price).replace(".", ",") : "";
  phoneIn.value = p.phone;
  dueIn.value = p.dueDay || "";
  amount.textContent = rangeText(p);

  const changed = () => patientChanged(p.id);
  const refresh = () => { amount.textContent = rangeText(p); updateTotals(); renderReminders(); changed(); };

  nameIn.addEventListener("input", () => { p.name = nameIn.value; renderReminders(); changed(); });
  sesIn.addEventListener("input", () => { p.sessions = parseSessions(sesIn.value); refresh(); });
  priceIn.addEventListener("input", () => { p.price = parsePrice(priceIn.value); refresh(); });
  phoneIn.addEventListener("input", () => { p.phone = phoneIn.value; renderReminders(); changed(); });
  dueIn.addEventListener("input", () => { p.dueDay = parseDueDay(dueIn.value); renderReminders(); changed(); });
  li.querySelector('[data-act="dec"]').addEventListener("click", () => {
    p.sessions = Math.max(0, p.sessions - 1);
    sesIn.value = p.sessions;
    refresh();
  });
  li.querySelector('[data-act="inc"]').addEventListener("click", () => {
    p.sessions += 1;
    sesIn.value = p.sessions;
    refresh();
  });
  li.querySelector('[data-act="remove"]').addEventListener("click", () => {
    p.archived = true;
    changed();
    showUndo(p);
    renderAll();
  });
  return li;
}

function renderFinance() {
  const listEl = $("list");
  const focused = listEl.contains(document.activeElement) ? document.activeElement.id : "";
  listEl.innerHTML = "";
  const list = activePatients();
  if (!patientsReady) listEl.appendChild(el("li", "empty", "Carregando pacientes…"));
  else if (!list.length) listEl.appendChild(el("li", "empty", "Adicione a primeira paciente para ver quanto pode receber no mês."));
  list.forEach((p, index) => listEl.appendChild(patientCard(p, index)));
  updateTotals();
  renderReminders();
  if (focused) {
    const target = $(focused);
    if (target) target.focus({ preventScroll: true });
  }
}

function showUndo(p) {
  removedId = p.id;
  const name = p.name.trim();
  $("undo-text").textContent = (name ? "“" + name + "”" : "Paciente") + " saiu do financeiro. Os relatórios continuam guardados.";
  $("undo").hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 8000);
}

function hideUndo() {
  removedId = null;
  $("undo").hidden = true;
}

function undoRemove() {
  const p = removedId && patients.get(removedId);
  hideUndo();
  if (!p) return;
  p.archived = false;
  patientChanged(p.id);
  renderAll();
}

function addPatient() {
  const p = { id: newId(), name: "", sessions: 4, price: 0, phone: "", dueDay: 0, remindedFor: "", createdAt: Date.now(), archived: false };
  patients.set(p.id, p);
  savePatientNow(p.id);
  renderAll();
  const input = $("name-" + p.id);
  if (input) input.focus();
}

// ---- Lembretes de cobrança ----

function pad(n) { return n < 10 ? "0" + n : String(n); }
function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function isoDay(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function shortDay(d) { return pad(d.getDate()) + "/" + pad(d.getMonth() + 1); }
// Vencimento no dia 31 cai no último dia dos meses mais curtos.
function dueDateIn(p, year, month) {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(p.dueDay, last));
}
function reminderFor(p, day0) {
  if (!p.dueDay || maxOf(p) <= 0) return null;
  const days = [{ date: day0, when: "hoje" }, { date: addDays(day0, 1), when: "amanhã" }];
  return days.find((d) => isoDay(dueDateIn(p, d.date.getFullYear(), d.date.getMonth())) === isoDay(d.date)) || null;
}
function nextDue(p, day0) {
  const from = addDays(day0, 2);
  const due = dueDateIn(p, from.getFullYear(), from.getMonth());
  return due < from ? dueDateIn(p, from.getFullYear(), from.getMonth() + 1) : due;
}
function reminderText(p, r) {
  const first = p.name.trim().split(/\s+/)[0];
  const lines = [
    (first ? "Olá, " + first + "!" : "Olá!") + " Passando para lembrar que " + r.when + " (" + shortDay(r.date) +
      ") vence o pagamento de " + sessionsText(p.sessions) + ", no total de " + money(maxOf(p)) + "."
  ];
  if (settings.pixKey.trim()) lines.push("Chave Pix: " + settings.pixKey.trim());
  lines.push("Qualquer dúvida, estou à disposição.");
  return lines.join("\n\n");
}
// Número no formato do wa.me: DDI + DDD + número. Sem "+", assume Brasil (55).
function whatsappNumber(phone) {
  const raw = String(phone || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (raw.charAt(0) === "+") return digits.length >= 8 && digits.length <= 15 ? digits : "";
  digits = digits.replace(/^0+/, "");
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  return /^55\d{10,11}$/.test(digits) ? digits : "";
}

function reminderItem(p, r) {
  const sent = p.remindedFor === isoDay(r.date);
  const text = reminderText(p, r);
  const number = whatsappNumber(p.phone);
  const li = el("li", "reminder");

  const head = el("div", "reminder-head");
  head.appendChild(el("strong", "", displayName(p)));
  head.appendChild(el("span", sent ? "pill sent" : "pill", sent ? "Lembrete enviado" : "Vence " + r.when + ", " + shortDay(r.date)));
  li.appendChild(head);
  li.appendChild(el("p", "reminder-sum", sessionsText(p.sessions) + " · " + money(maxOf(p))));

  const actions = el("div", "reminder-actions");
  if (number) {
    const link = el("a", "wa", sent ? "Enviar de novo" : "Enviar no WhatsApp");
    link.href = "https://wa.me/" + number + "?text=" + encodeURIComponent(text);
    link.target = "_blank";
    link.rel = "noopener";
    link.addEventListener("click", () => {
      p.remindedFor = isoDay(r.date);
      patientChanged(p.id);
      setTimeout(renderReminders, 0);
    });
    actions.appendChild(link);
  } else {
    actions.appendChild(el("p", "reminder-warn", p.phone.trim() ? "Celular incompleto. Use DDD e número." : "Cadastre o celular para enviar."));
  }
  const copy = el("button", "secondary", "Copiar mensagem");
  copy.type = "button";
  copy.addEventListener("click", () => copyText(text, copy, "Mensagem copiada"));
  actions.appendChild(copy);
  li.appendChild(actions);
  return li;
}

function emptyReminders(list, day0) {
  let next = null;
  list.forEach((p) => {
    if (!p.dueDay || maxOf(p) <= 0) return;
    const date = nextDue(p, day0);
    if (!next || date < next.date) next = { p, date };
  });
  return el("li", "empty", next
    ? "Ninguém vence hoje nem amanhã. Próximo vencimento: " + displayName(next.p) + ", em " + shortDay(next.date) + "."
    : "Preencha o celular e o dia do vencimento das pacientes para os lembretes aparecerem aqui.");
}

function renderReminders() {
  const listEl = $("reminders");
  const day0 = today();
  const list = activePatients();
  const due = list.map((p) => ({ p, r: reminderFor(p, day0) })).filter((item) => item.r);
  due.sort((a, b) => a.r.date - b.r.date);
  listEl.innerHTML = "";
  if (!due.length) listEl.appendChild(emptyReminders(list, day0));
  due.forEach((item) => listEl.appendChild(reminderItem(item.p, item.r)));
  $("pix-warning").hidden = !(due.length && !settings.pixKey.trim());
}

// ---- Relatórios ----

function watchReports(patientId) {
  stopReports();
  reports = new Map();
  reportsReady = false;
  let chain = Promise.resolve();
  const q = query(collection(db, "users", uid, "reports"), where("patientId", "==", patientId));
  reportsWatcher = onSnapshot(q, (snap) => {
    const changes = snap.docChanges();
    chain = chain.then(() => applyReports(changes, patientId)).catch((e) => console.error(e));
  }, watchError);
}

function stopReports() {
  if (reportsWatcher) reportsWatcher();
  reportsWatcher = null;
}

async function applyReports(changes, patientId) {
  if (openPatientId !== patientId || !dataKey) return;
  for (const change of changes) {
    const id = change.doc.id;
    if (change.type === "removed") {
      reports.delete(id);
      continue;
    }
    if (change.doc.metadata.hasPendingWrites && reports.has(id)) continue;
    if (isLocallyBusy("report:" + id)) continue;
    try {
      const report = cleanReport(await vault.decryptJson(dataKey, change.doc.data()), id);
      if (report) reports.set(id, report);
    } catch (e) {
      console.error("Não foi possível abrir o relatório " + id, e);
    }
  }
  reportsReady = true;
  if (!editing) renderPatientReports();
}

function longDate(iso) {
  const parts = iso.split("-");
  return parts[2] + "/" + parts[1] + "/" + parts[0];
}

function reportLabel(r) {
  if (r.title.trim()) return r.title.trim();
  const first = r.text.trim().split("\n")[0];
  if (!first) return "Sem texto";
  return first.length > 90 ? first.slice(0, 90) + "…" : first;
}

function renderReportsTab() {
  $("reports-list-view").hidden = Boolean(openPatientId);
  $("reports-patient-view").hidden = !openPatientId || Boolean(editing);
  $("report-editor-view").hidden = !editing;
  if (!openPatientId) renderReportPatients();
  else if (!editing) renderPatientReports();
}

function fillPicker(listEl, items, emptyText) {
  listEl.innerHTML = "";
  if (!items.length && emptyText) listEl.appendChild(el("li", "empty", emptyText));
  items.forEach((p) => {
    const li = el("li");
    const button = el("button", "pick");
    button.type = "button";
    button.appendChild(el("span", "", displayName(p)));
    const chevron = el("span", "chevron", "›");
    chevron.setAttribute("aria-hidden", "true");
    button.appendChild(chevron);
    button.addEventListener("click", () => openPatientReports(p.id));
    li.appendChild(button);
    listEl.appendChild(li);
  });
}

function renderReportPatients() {
  const byName = (a, b) => displayName(a).localeCompare(displayName(b), "pt-BR");
  const all = Array.from(patients.values()).sort(byName);
  const archived = all.filter((p) => p.archived);
  fillPicker($("report-patients"), all.filter((p) => !p.archived),
    patientsReady ? "Cadastre as pacientes na aba Financeiro para escrever os relatórios." : "Carregando pacientes…");
  $("archived-group").hidden = !archived.length;
  fillPicker($("report-archived"), archived, "");
}

function openPatientReports(id) {
  openPatientId = id;
  editing = null;
  watchReports(id);
  renderReportsTab();
  window.scrollTo(0, 0);
}

function closePatientReports() {
  stopReports();
  openPatientId = null;
  reports = new Map();
  renderReportsTab();
}

function renderPatientReports() {
  const p = patients.get(openPatientId);
  $("reports-patient-name").textContent = displayName(p);
  $("archived-note").hidden = !(p && p.archived);
  const listEl = $("report-list");
  listEl.innerHTML = "";
  const items = Array.from(reports.values())
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  if (!reportsReady) listEl.appendChild(el("li", "empty", "Carregando relatórios…"));
  else if (!items.length) listEl.appendChild(el("li", "empty", "Nenhum relatório ainda."));
  items.forEach((r) => {
    const li = el("li");
    const button = el("button", "report-item");
    button.type = "button";
    button.appendChild(el("span", "report-date", r.date ? longDate(r.date) : "Sem data"));
    button.appendChild(el("span", "report-title", reportLabel(r)));
    button.addEventListener("click", () => openEditor(r));
    li.appendChild(button);
    listEl.appendChild(li);
  });
}

function setEditorStatus(text) {
  $("editor-status").textContent = text;
}

function autosize() {
  const area = $("report-text");
  area.style.height = "auto";
  area.style.height = area.scrollHeight + "px";
}

function openEditor(report) {
  editing = Object.assign({ patientId: openPatientId, isNew: false }, report);
  $("report-date").value = editing.date;
  $("report-title").value = editing.title;
  $("report-text").value = editing.text;
  $("editor-back-name").textContent = displayName(patients.get(openPatientId));
  setEditorStatus(editing.isNew ? "Começa a salvar quando você escrever." : "Salvo");
  renderReportsTab();
  autosize();
  window.scrollTo(0, 0);
}

function newReport() {
  openEditor({ id: newId(), date: isoDay(today()), title: "", text: "", createdAt: Date.now(), updatedAt: 0, isNew: true });
  $("report-text").focus();
}

function editorChanged() {
  if (!editing) return;
  editing.date = $("report-date").value;
  editing.title = $("report-title").value;
  editing.text = $("report-text").value;
  setEditorStatus("Salvando…");
  const id = editing.id;
  schedule("report:" + id, () => saveReportNow(id), 800);
}

function saveReportNow(id) {
  const r = editing;
  if (!r || r.id !== id || !dataKey) return;
  if (r.isNew && !r.title.trim() && !r.text.trim()) {
    setEditorStatus("Começa a salvar quando você escrever.");
    return;
  }
  r.isNew = false;
  r.updatedAt = Date.now();
  const stored = { date: r.date, title: r.title, text: r.text, createdAt: r.createdAt, updatedAt: r.updatedAt };
  reports.set(id, Object.assign({ id }, stored));
  writeEncrypted("report:" + id, reportRef(id), stored, { patientId: r.patientId });
  setEditorStatus(navigator.onLine ? "Salvo" : "Salvo no aparelho. Sobe para a nuvem quando a internet voltar.");
}

function closeEditor() {
  if (editing) run("report:" + editing.id);
  editing = null;
  renderReportsTab();
  window.scrollTo(0, 0);
}

function deleteReport() {
  if (!editing) return;
  if (!window.confirm("Excluir este relatório? Não tem como desfazer.")) return;
  const id = editing.id;
  cancelScheduled("report:" + id);
  if (!editing.isNew) track(deleteDoc(reportRef(id)));
  reports.delete(id);
  editing = null;
  renderReportsTab();
}

function unarchiveOpenPatient() {
  const p = patients.get(openPatientId);
  if (!p) return;
  p.archived = false;
  patientChanged(p.id);
  renderAll();
}

// ---- Instalação no iPhone ----

function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isInstalled() {
  return window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}

// ---- Início ----

function wireEvents() {
  $("login-form").addEventListener("submit", onLoginSubmit);
  $("forgot-access").addEventListener("click", onForgotAccess);
  $("setup-form").addEventListener("submit", onSetupSubmit);
  $("setup-copy").addEventListener("click", () => copyText($("setup-code").textContent, $("setup-copy"), "Código copiado"));
  $("setup-saved").addEventListener("change", () => { $("setup-finish").disabled = !$("setup-saved").checked; });
  $("setup-finish").addEventListener("click", onSetupFinish);
  $("unlock-form").addEventListener("submit", onUnlockSubmit);
  $("recover-form").addEventListener("submit", onRecoverSubmit);
  $("unlock-signout").addEventListener("click", onSignOut);
  $("setup-signout").addEventListener("click", onSignOut);
  $("loading-retry").addEventListener("click", () => { if (auth.currentUser) afterLogin(auth.currentUser); });

  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.go));
  });

  $("add").addEventListener("click", addPatient);
  $("undo-btn").addEventListener("click", undoRemove);
  $("notice").addEventListener("click", () => { $("notice").hidden = true; });
  $("pix").addEventListener("input", () => {
    settings.pixKey = $("pix").value;
    renderReminders();
    schedule("settings", saveSettingsNow);
  });

  $("patient-back").addEventListener("click", closePatientReports);
  $("new-report").addEventListener("click", newReport);
  $("unarchive").addEventListener("click", unarchiveOpenPatient);
  $("editor-back").addEventListener("click", closeEditor);
  $("report-delete").addEventListener("click", deleteReport);
  ["report-date", "report-title", "report-text"].forEach((id) => $(id).addEventListener("input", editorChanged));
  $("report-date").addEventListener("change", editorChanged);
  $("report-text").addEventListener("input", autosize);

  $("lock-now").addEventListener("click", lockNow);
  $("sign-out").addEventListener("click", onSignOut);
  $("change-form").addEventListener("submit", onChangePassword);
  $("code-form").addEventListener("submit", onNewCode);
  $("new-code-copy").addEventListener("click", () => copyText($("new-code").textContent, $("new-code-copy"), "Código copiado"));
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", onImportFile);

  // Com o teclado aberto, a barra de abas some para não cobrir o texto.
  document.addEventListener("focusin", (event) => {
    if (event.target.matches("input:not([type=checkbox]):not([type=file]), textarea")) document.body.classList.add("typing");
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || !active.matches("input, textarea")) document.body.classList.remove("typing");
    }, 0);
  });
  // Ao sair do app, envia o que estiver esperando; ao voltar, atualiza os lembretes do dia.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushAll();
    else if (dataKey) renderReminders();
  });
  window.addEventListener("online", updateSync);
  window.addEventListener("offline", updateSync);
}

function boot() {
  wireEvents();
  $("install").hidden = !(isIos() && !isInstalled());
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const secure = location.protocol === "https:" || location.hostname === "localhost";
  if ("serviceWorker" in navigator && secure) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (!isConfigured()) {
    show("screen-config");
    return;
  }
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
  onAuthStateChanged(auth, (user) => {
    if (user) {
      afterLogin(user);
    } else {
      resetData();
      uid = null;
      profile = null;
      show("screen-login");
    }
  });
}

boot();
