import { auth, db } from './firebase-config.js';
import { collection, doc, getDoc, getDocs, limit, query, setDoc, where } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { browserLocalPersistence, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { normalizeBranding, brandingName, readCachedBranding, cacheBranding, clearBrandingCache, applyLogo } from './branding-config.js';

const ADMIN_ROLES = new Set(['admin', 'superAdmin']);
const ROLE_REDIRECTS = { admin: 'admin.html', superAdmin: 'admin.html', teamLeader: 'team.html', judge: 'judge.html', publisher: 'publish.html' };
const byId = (id) => document.getElementById(id);
const setText = (id, text) => { const el = byId(id); if (el) el.textContent = text || ''; };
const params = new URLSearchParams(window.location.search);
const requestedNext = params.get('next') || '';
const clearRoleSessions = () => ['team_access_uid', 'team_leader_team', 'judge_access_uid', 'judge_user', 'publisher_access_uid', 'media_access_uid'].forEach(key => sessionStorage.removeItem(key));

const normalizeUsername = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
const normalizeEmailKey = (value) => `email_${normalizeUsername(value).replace(/[^a-z0-9_@.-]/g, '_')}`;

let accessLoginInProgress = false;
let navigationStarted = false;
const authPersistenceReady = setPersistence(auth, browserLocalPersistence);
let loginBranding = {};

function applyLoginBranding(config = {}) {
  loginBranding = normalizeBranding(config);
  const festName = brandingName(loginBranding);
  setText('login-fest-name', festName);
  setText('transition-fest-name', festName);
  document.title = `${festName} Login`;
  document.querySelectorAll('[data-fest-logo]').forEach(image => applyLogo(image,image.parentElement?.querySelector('[data-logo-fallback]'),loginBranding));
}

async function loadLoginBranding() {
  try {
    applyLoginBranding(readCachedBranding());
  } catch (_) { /* Ignore malformed legacy cache. */ }
  try {
    const snapshot = await getDoc(doc(db, 'settings', 'home_config'));
    if (snapshot.exists()) {
      const config = snapshot.data();
      applyLoginBranding(cacheBranding(config));
    } else { clearBrandingCache(); applyLoginBranding({}); }
  } catch (error) { console.warn('Login branding could not be refreshed', error); }
}

function showLoginTransition() {
  applyLoginBranding(loginBranding);
  const overlay = byId('login-transition');
  overlay?.classList.remove('hidden');
  overlay?.classList.add('flex');
}

const loginBrandingReady = Promise.race([loadLoginBranding(), new Promise(resolve => window.setTimeout(resolve, 1200))]);

async function navigateOnce(target) {
  if (navigationStarted) return;
  navigationStarted = true;
  await loginBrandingReady;
  showLoginTransition();
  window.requestAnimationFrame(() => window.location.replace(target));
}

async function resolveLoginEmail(identifier) {
  const value = String(identifier ?? '').trim();
  if (value.includes('@')) return value;
  const username = normalizeUsername(value);
  if (!username) return '';
  let snap = await getDoc(doc(db, 'accessUsernames', username));
  if (!snap.exists() && value.includes('@')) snap = await getDoc(doc(db, 'accessUsernames', normalizeEmailKey(value)));
  if (!snap.exists()) snap = await getDoc(doc(db, 'adminUsernames', username));
  if (!snap.exists()) throw new Error('username-not-found');
  const data = snap.data();
  if (data.active === false || !data.email) throw new Error('username-disabled');
  return String(data.email).trim();
}

async function loadAccessProfile(user) {
  const accessSnap = await getDoc(doc(db, 'accessUsers', user.uid));
  if (accessSnap.exists()) {
    const profile = { uid: user.uid, ...accessSnap.data() };
    if (profile.active === true && ROLE_REDIRECTS[profile.role]) return profile;
  }

  const pendingQuery = query(collection(db, 'accessUsers'), where('email', '==', String(user.email || '').toLowerCase()), limit(1));
  const pendingSnap = await getDocs(pendingQuery);
  if (!pendingSnap.empty) {
    const source = pendingSnap.docs[0];
    const profile = { uid: user.uid, accessDocId: source.id, ...source.data(), authUid: user.uid };
    if (profile.active === true && ROLE_REDIRECTS[profile.role]) {
      await setDoc(doc(db, 'accessUsers', user.uid), profile, { merge: true });
      return profile;
    }
  }

  const adminSnap = await getDoc(doc(db, 'adminUsers', user.uid));
  if (adminSnap.exists()) {
    const profile = { uid: user.uid, ...adminSnap.data() };
    if (profile.active === true && ADMIN_ROLES.has(profile.role)) return profile;
  }
  return null;
}

function redirectForProfile(profile) {
  clearRoleSessions();
  if (profile.role === 'teamLeader') {
    sessionStorage.setItem('team_access_uid', profile.uid || '');
    sessionStorage.setItem('team_leader_team', profile.team || '');
  }
  if (profile.role === 'judge') sessionStorage.setItem('judge_access_uid', profile.uid || '');
  if (profile.role === 'publisher') sessionStorage.setItem('publisher_access_uid', profile.uid || '');
  const roleTarget = ROLE_REDIRECTS[profile.role] || 'admin.html';
  const requestedPage = requestedNext.split(/[?#]/)[0].split('/').pop() || '';
  const allowedNextPages = ADMIN_ROLES.has(profile.role) ? new Set(['admin.html', 'publish.html']) : new Set([roleTarget]);
  if (allowedNextPages.has(requestedPage)) return requestedPage;
  return roleTarget;
}

function setBusy(isBusy) {
  const btn = byId('login-button');
  if (!btn) return;
  btn.disabled = isBusy;
  btn.classList.toggle('opacity-70', isBusy);
  btn.classList.toggle('cursor-not-allowed', isBusy);
  btn.querySelector('[data-login-label]').textContent = isBusy ? 'Checking...' : 'Login';
}

function loginError(error) {
  if (error.message === 'username-not-found' || error.message === 'username-disabled') {
    return 'Username/email or password is incorrect.';
  }
  if (error.code === 'permission-denied') {
    return 'Unable to verify access right now. Please try again.';
  }
  return 'Invalid username/email, password, or missing active access role.';
}

async function completeLogin(user) {
  if (navigationStarted) return;
  const profile = await loadAccessProfile(user);
  if (!profile) {
    await signOut(auth);
    setText('login-error', 'This account is not active or does not have page access.');
    setBusy(false);
    return;
  }
  navigateOnce(redirectForProfile(profile));
}

byId('login-toggle-password')?.addEventListener('click', () => {
  const input = byId('login-password');
  const button = byId('login-toggle-password');
  const nextType = input?.type === 'password' ? 'text' : 'password';
  if (input) input.type = nextType;
  button?.setAttribute('aria-label', nextType === 'password' ? 'Show password' : 'Hide password');
  button?.querySelector('[data-eye-icon]')?.setAttribute('data-lucide', nextType === 'password' ? 'eye' : 'eye-off');
  window.lucide?.createIcons?.();
});

byId('standalone-login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);
  setText('login-error', '');
  try {
    const identifier = byId('login-identifier')?.value || '';
    const password = byId('login-password')?.value || '';
    const email = await resolveLoginEmail(identifier);
    if (!email || !password) throw new Error('missing-credentials');
    accessLoginInProgress = true;
    await authPersistenceReady;
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await completeLogin(credential.user);
  } catch (error) {
    console.error('Standalone admin login failed', error);
    setText('login-error', loginError(error));
    setBusy(false);
    accessLoginInProgress = false;
  }
});

onAuthStateChanged(auth, async (user) => {
  if (user && !accessLoginInProgress && !navigationStarted) {
    accessLoginInProgress = true;
    try { await completeLogin(user); }
    finally { if(!navigationStarted) accessLoginInProgress = false; }
  }
});

const initialMessage = params.get('message') || sessionStorage.getItem('admin_login_message') || '';
sessionStorage.removeItem('admin_login_message');
if (initialMessage) setText('login-error', initialMessage);

window.lucide?.createIcons?.();
byId('login-identifier')?.focus();
