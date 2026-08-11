export const BRANDING_CACHE_KEY = 'fest_home_config';
export const DEFAULT_BRANDING = Object.freeze({
  configured: false,
  festName1: 'Fest Management',
  festName2: 'Setup Required',
  tagline: 'Configure your festival from the Admin Panel',
  logoUrl: '',
  aboutSubtitle: 'Festival information not configured',
  aboutText: 'Festival details will appear here after the administrator completes setup.',
  footerText: 'Festival management system'
});

export function normalizeBranding(raw = {}) {
  const festName1=String(raw.festName1||'').trim(), festName2=String(raw.festName2||'').trim();
  const configured=raw.setupCompleted === true || Boolean(festName1);
  return { ...DEFAULT_BRANDING, ...raw, festName1:festName1||DEFAULT_BRANDING.festName1, festName2:festName2||(configured?'':DEFAULT_BRANDING.festName2), configured };
}
export const brandingName = config => [normalizeBranding(config).festName1, normalizeBranding(config).festName2].filter(Boolean).join(' ');
export const currentYear = () => String(new Date().getFullYear());
export function cacheBranding(raw) { const value=normalizeBranding(raw); try { if(value.configured)localStorage.setItem(BRANDING_CACHE_KEY,JSON.stringify(raw));else localStorage.removeItem(BRANDING_CACHE_KEY); } catch(_) {} return value; }
export function readCachedBranding() { try { return normalizeBranding(JSON.parse(localStorage.getItem(BRANDING_CACHE_KEY)||'{}')); } catch(_) { return normalizeBranding(); } }
export function clearBrandingCache() { try { localStorage.removeItem(BRANDING_CACHE_KEY); } catch(_) {} }
export const isBase64Image = value => /^data:image\/(jpeg|png|webp|gif);base64,/i.test(String(value||''));
export function applyLogo(image, fallback, config, fallbackText='FM') {
  const value=normalizeBranding(config); if(fallback)fallback.textContent=fallbackText;
  const showFallback=()=>{if(image){image.removeAttribute('src');image.classList.add('hidden');image.classList.remove('loaded');}fallback?.classList.remove('hidden');};
  if(!image||!isBase64Image(value.logoUrl)){showFallback();return;}
  image.onload=()=>{image.classList.remove('hidden');image.classList.add('loaded');fallback?.classList.add('hidden');};image.onerror=showFallback;image.src=value.logoUrl;
}
export function applyBase64Image(image, value, fallback=null) {
  if(!image)return;const showFallback=()=>{image.removeAttribute('src');image.classList.add('hidden');fallback?.classList.remove('hidden');};
  if(!isBase64Image(value)){showFallback();return;}image.onload=()=>{image.classList.remove('hidden');image.classList.add('loaded');fallback?.classList.add('hidden');};image.onerror=showFallback;image.src=value;
}
