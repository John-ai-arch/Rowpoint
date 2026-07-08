// Lightweight internationalization framework (no dependencies).
//
// Usage:
//   import { t, setLocale, getLocale } from './i18n.js';
//   t('auth.signIn')                     → "Sign in" / "Anmelden"
//   t('progress.metersTotal', { n: 5 })  → interpolates {n}
//   t('common.workouts', { count: 3 })   → pluralization via _one/_other keys
//
// Keys are dot-paths into the locale dictionaries (locales/en.js, de.js).
// A missing key falls back to English, then to the raw key — the app never
// shows a blank string. Language choice persists in localStorage.
import { en } from './locales/en.js';
import { de } from './locales/de.js';

const DICTS = { en, de };
export const LOCALES = [
  { code: 'en', label: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'de', label: 'German', native: 'Deutsch', flag: '🇩🇪' },
];

const STORAGE_KEY = 'rp_locale';
let current = detectInitial();

function detectInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && DICTS[saved]) return saved;
  } catch { /* storage blocked */ }
  return null; // null → first-run language selection is needed
}

/** True on first launch when the user has not yet chosen a language. */
export function firstRunNeedsLanguage() {
  return current === null;
}

export function getLocale() { return current || 'en'; }

export function setLocale(code) {
  if (!DICTS[code]) return;
  current = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.lang = code;
  window.dispatchEvent(new CustomEvent('rp:locale', { detail: code }));
}

function lookup(dict, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

/**
 * Translate a key. Supports {var} interpolation and simple pluralization:
 * if `vars.count` is provided and `<key>_one` / `<key>_other` exist, the
 * right variant is chosen automatically.
 */
export function t(key, vars) {
  const loc = getLocale();
  let raw;
  if (vars && typeof vars.count === 'number') {
    const variant = vars.count === 1 ? `${key}_one` : `${key}_other`;
    raw = lookup(DICTS[loc], variant) ?? lookup(DICTS.en, variant);
  }
  if (raw === undefined) raw = lookup(DICTS[loc], key);
  if (raw === undefined) raw = lookup(DICTS.en, key); // fall back to English
  if (raw === undefined) return key;                  // last resort: the key
  if (typeof raw !== 'string') return key;
  return vars ? interpolate(raw, vars) : raw;
}

function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/**
 * Translate any element in a subtree carrying a data-i18n attribute.
 *   <span data-i18n="nav.home"></span>          → textContent
 *   <input data-i18n-placeholder="auth.email">  → placeholder
 *   <button data-i18n-aria="common.close">      → aria-label
 * Lets static/HTML-authored strings be localized without rebuilding markup.
 */
export function translateStaticDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
}

// Keep <html lang> in sync from the very first paint.
if (typeof document !== 'undefined' && current) document.documentElement.lang = current;
