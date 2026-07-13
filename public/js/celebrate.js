// Achievement-unlock celebration — a tasteful toast + in-card banner, plus an
// optional short chime (user-configurable, off by default). Animations rely on
// CSS classes that already honor prefers-reduced-motion / html[data-motion].
import { toast } from './api.js';
import { icon, badgeIcon } from './icons.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SOUND_KEY = 'rp_sound';
export const soundEnabled = () => { try { return localStorage.getItem(SOUND_KEY) === '1'; } catch { return false; } };
export const setSoundEnabled = (on) => { try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* ignore */ } };

// A brief three-note rising arpeggio via WebAudio — no asset, ~0.4s, quiet.
function playChime() {
  if (!soundEnabled()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const at = now + i * 0.11;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at); osc.stop(at + 0.28);
    });
    setTimeout(() => ctx.close?.(), 900);
  } catch { /* audio blocked — silent */ }
}

/**
 * Celebrate newly-unlocked achievements: one toast each + an optional chime.
 * Returns an HTML banner (or '') to inject into a results card.
 * @param {Array<{badge:string,label:string,icon:string}>} badges
 */
export function celebrate(badges) {
  if (!Array.isArray(badges) || !badges.length) return '';
  badges.forEach((b, i) => {
    setTimeout(() => toast(`${t('celebrate.unlocked')} ${t('achievements.' + b.badge)}`, 'success', 5200), i * 350);
  });
  playChime();
  return `<div class="notice celebrate" style="margin-top:12px;border-color:rgba(245,196,81,.4);background:linear-gradient(180deg,rgba(245,196,81,.12),transparent)">
    <span class="ai-tag" style="color:var(--gold)">${icon('trophy', { size: 14 })} ${esc(t('celebrate.title'))}</span>
    <div class="ach-grid" style="margin-top:10px">
      ${badges.map(b => `<div class="ach unlocked"><span class="ic" aria-hidden="true">${icon(badgeIcon(b.badge), { size: 30 })}</span><div class="nm">${esc(t('achievements.' + b.badge))}</div></div>`).join('')}
    </div>
  </div>`;
}
