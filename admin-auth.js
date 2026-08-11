import { auth, db } from './firebase-config.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const ADMIN_ROLES = new Set(['admin', 'superAdmin']);
let adminAuthRedirecting = false;
let adminAuthReady = false;

const byId = (id) => document.getElementById(id);
const setText = (id, text) => { const el = byId(id); if (el) el.textContent = text || ''; };

function loginRedirectUrl(message = '') {
  const currentPage = window.location.pathname.split('/').pop() || 'admin.html';
  const next = currentPage === 'login.html' ? 'admin.html' : currentPage;
  const url = new URL('login.html', window.location.href);
  url.searchParams.set('next', next);
  if (message) url.searchParams.set('message', message);
  return url.href;
}

function redirectToLogin(message = '', includeNext = true) {
  if (adminAuthRedirecting) return;
  adminAuthRedirecting = true;
  if (message) sessionStorage.setItem('admin_login_message', message);
  window.location.replace(includeNext ? loginRedirectUrl(message) : new URL('login.html', window.location.href).href);
}

async function loadAdminProfile(user) {
  const snap = await getDoc(doc(db, 'adminUsers', user.uid));
  if (!snap.exists()) return null;
  const profile = { id: snap.id, ...snap.data() };
  if (profile.active !== true || !ADMIN_ROLES.has(profile.role)) return null;
  return profile;
}

function showAdminApp(profile, user) {
  adminAuthReady = true;
  setText('admin-user-label', profile.displayName || profile.username || user.email || 'Admin');
}

function showLogin(message = '') {
  byId('app-loader')?.classList.remove('hide');
  byId('app-layout')?.classList.add('opacity-0');
  redirectToLogin(message);
}

export function initAdminAuth({ onReady } = {}) {
  const logout = byId('admin-logout-button');

  logout?.addEventListener('click', async () => {
    await signOut(auth);
    window.adminUnsubscribers?.forEach(unsub => unsub?.());
    window.adminUnsubscribers = [];
    window.dispatchEvent(new CustomEvent('admin-auth-logout'));
    redirectToLogin('Logged out. Please login again.', false);
  });

  onAuthStateChanged(auth, async (user) => {
    if (adminAuthRedirecting || adminAuthReady) return;
    if (!user) {
      showLogin('');
      return;
    }
    let profile = null;
    try { profile = await loadAdminProfile(user); }
    catch (error) { console.error('Admin profile validation failed', error); await signOut(auth).catch(() => {}); showLogin('Unable to verify admin access. Check your connection and try again.'); return; }
    if (!profile) {
      await signOut(auth);
      showLogin('This Firebase user is not enabled as an admin.');
      return;
    }
    showAdminApp(profile, user);
    onReady?.(user, profile);
    window.dispatchEvent(new CustomEvent('admin-auth-ready', { detail: { user, profile } }));
  });
}
