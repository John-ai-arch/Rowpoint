// RowPoint icon system — one hand-tuned line-icon family so the whole app
// speaks a single visual language instead of a grab-bag of emoji.
//
// Design rules (keep every glyph on-grid so the set reads as ONE family):
//   • 24×24 viewBox, drawn within a 3–21 safe area
//   • single stroke weight (1.75), round caps + joins, no fills except
//     deliberate "ink" dots (marked fill="currentColor" stroke="none")
//   • inherits color from `currentColor` and size from width/height
//
// Usage:  icon('oar')                      → 24px, decorative (aria-hidden)
//         icon('heart', { size: 20 })      → sized
//         icon('bell', { label: 'Alerts' })→ accessible (role=img + label)
//         icon('flame', { cls: 'accent' }) → extra class for tinting
//
// The returned markup is a trusted, static SVG string (no interpolation of
// user data) and is safe to drop into innerHTML.

const P = {
  /* ---- navigation & chrome ---- */
  home: '<path d="M3 10.8 12 3.2l9 7.6"/><path d="M5.3 9.4V19a1.4 1.4 0 0 0 1.4 1.4h10.6A1.4 1.4 0 0 0 18.7 19V9.4"/><path d="M9.6 20.4v-5.2a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2v5.2"/>',
  // signature: a single oar — shaft + teardrop blade, the sport's core tool
  oar: '<path d="M4.7 19.3 12 12"/><ellipse cx="16.4" cy="7.6" rx="4.4" ry="2.7" transform="rotate(-45 16.4 7.6)"/>',
  progress: '<path d="M4 15.5 8.5 11l3 3 5.5-6.2"/><path d="M15.6 7.8H20v4.4"/>',
  heart: '<path d="M12 20.6C12 20.6 4 14 4 8.7 4 5.8 6.4 4.3 8.8 5.4c1.3.6 2.4 1.9 3.2 3 .8-1.1 1.9-2.4 3.2-3C20.6 4.3 20 5.8 20 8.7c0 5.3-8 11.9-8 11.9z"/>',
  history: '<circle cx="12" cy="12.5" r="8"/><path d="M12 7.8v4.7l3.1 1.9"/><path d="M4.4 9.2 6.7 8.5 6 6.2"/>',
  flag: '<path d="M6.2 21V3.6"/><path d="M6.2 4.6c3.1-1.7 6.3 1.5 9.4-.2v7.9c-3.1 1.7-6.3-1.5-9.4.2"/>',
  social: '<circle cx="12" cy="12" r="8.4"/><path d="M3.7 12h16.6"/><path d="M12 3.6c2.4 2.7 2.4 14.1 0 16.8M12 3.6c-2.4 2.7-2.4 14.1 0 16.8"/>',

  bell: '<path d="M6.2 9.4a5.8 5.8 0 0 1 11.6 0c0 4.6 1.8 5.7 1.8 5.7H4.4s1.8-1.1 1.8-5.7z"/><path d="M10.2 18.6a2 2 0 0 0 3.6 0"/>',
  gear: '<path d="M4 7.4h9"/><path d="M17 7.4h3"/><circle cx="15" cy="7.4" r="2.1"/><path d="M4 16.6h3"/><path d="M11 16.6h9"/><circle cx="9" cy="16.6" r="2.1"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.6 15.6 20 20"/>',

  /* ---- directional & control ---- */
  'chevron-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  'chevron-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'chevron-down': '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
  'chevron-up': '<path d="M5.5 14.5 12 8l6.5 6.5"/>',
  'arrow-right': '<path d="M4 12h15"/><path d="M13 6l6 6-6 6"/>',
  'arrow-up-right': '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 6.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="8.4"/><path d="M8.4 12.2 11 14.8 15.8 9"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11.2v5"/><path d="M12 8.2v.1" stroke-width="2.2"/>',

  /* ---- domain: training & rowing ---- */
  // stopwatch — "start a session"
  timer: '<circle cx="12" cy="13.6" r="7.4"/><path d="M12 13.6V9.2"/><path d="M9.6 2.8h4.8"/><path d="M18.8 6.4 20.3 4.9"/>',
  flame: '<path d="M12.5 21.4c3.3 0 5.9-2.5 5.9-5.8 0-2.4-1.3-4.3-2.6-5.8-.4 1-1.1 1.8-2 2 .6-2.3-.5-4.9-2.7-6.9-.3 2.4-1.7 3.5-3 5C6.7 11.4 5.6 13 5.6 15.6c0 3.3 3.4 5.8 6.9 5.8z"/><path d="M12 21.2a2.7 2.7 0 0 0 2.7-2.7c0-1.6-1.4-2.6-2-4-.9 1-2.1 2-2.1 3.6a2.4 2.4 0 0 0 1.4 3.1z"/>',
  trophy: '<path d="M7.5 4.5h9v3.6a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 5.6H4.8v.9a3 3 0 0 0 3 3"/><path d="M16.5 5.6h2.7v.9a3 3 0 0 1-3 3"/><path d="M12 12.6v3.4"/><path d="M8.7 20.4h6.6"/><path d="M9.8 20.4 10.4 16M14.2 20.4 13.6 16"/>',
  medal: '<path d="M8.7 3.6 12 9.4M15.3 3.6 12 9.4" /><circle cx="12" cy="15" r="5.4"/><path d="m12 12.4 1 2 2.2.3-1.6 1.6.4 2.2-2-1.1-2 1.1.4-2.2L8.8 14.7l2.2-.3z"/>',
  crown: '<path d="M4 8.4 7.7 11.6 12 5.4l4.3 6.2L20 8.4l-1.4 9.8H5.4z"/><path d="M5.4 18.2h13.2"/>',
  target: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 2.6 4.6 13.4H11l-1 8 8.4-10.8H12z"/>',
  ruler: '<rect x="3.2" y="8" width="17.6" height="8" rx="1.6" transform="rotate(0 12 12)"/><path d="M7 8v3.2M10.5 8v4M14 8v3.2M17.5 8v4"/>',
  // heart with an ECG blip through it — heart-rate
  pulse: '<path d="M20.4 11.4c1.2-2.6 0-6.4-3.4-6.4-1.7 0-2.9 1-3.9 2.2M12 20.6S4 14 4 8.7"/><path d="M3.4 12.4h3.2l1.6-3.4 2.6 7 1.8-4.4 1.1 1.6h6.9"/>',
  droplet: '<path d="M12 3.2s6.2 6.7 6.2 11.3a6.2 6.2 0 0 1-12.4 0C5.8 9.9 12 3.2 12 3.2z"/>',
  moon: '<path d="M20.2 14.4A8 8 0 1 1 9.6 3.8a6.5 6.5 0 0 0 10.6 10.6z"/>',
  dumbbell: '<path d="M2.6 12h1.8M19.6 12h1.8M6.4 8.4v7.2M17.6 8.4v7.2M9 9.6v4.8M15 9.6v4.8M6.4 12h11.2"/>',
  calendar: '<rect x="4" y="5.2" width="16" height="15" rx="2.2"/><path d="M4 9.6h16M8.2 3.2v4M15.8 3.2v4"/>',
  sparkle: '<path d="M12 3.2 13.7 8.9 19.4 10.6 13.7 12.3 12 18 10.3 12.3 4.6 10.6 10.3 8.9z"/><path d="M18.4 15.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" fill="currentColor" stroke="none"/>',
  bike: '<circle cx="6.2" cy="16.8" r="3.4"/><circle cx="17.8" cy="16.8" r="3.4"/><path d="M6.2 16.8 10 9.6h5.2"/><path d="M9 9.6 12 16.8h5.8l-2.6-6.9"/><path d="M14.2 9.6h3.2"/>',
  boat: '<path d="M3.6 13.6h16.8l-1.7 4.4a2 2 0 0 1-1.9 1.3H7.2a2 2 0 0 1-1.9-1.3z"/><path d="M12 13V3.8l6.2 5.2z"/>',
  shoe: '<path d="M3 16.4h14.4c1.4 0 2.6-.4 2.6-1.6 0-1.3-1.7-1.9-3.4-2.5-1.9-.6-3-1.6-4.2-3l-1.6-1.9-2 1 .8 2.4H3z"/><path d="M3 16.4V12"/>',

  /* ---- objects & sections ---- */
  users: '<circle cx="9.2" cy="8" r="3.3"/><path d="M3.6 20a5.6 5.6 0 0 1 11.2 0"/><path d="M15.8 5.1a3.3 3.3 0 0 1 0 5.9M17.4 20a5.6 5.6 0 0 0-2-4.3"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5.4 20a6.6 6.6 0 0 1 13.2 0"/>',
  link: '<path d="M9 15l6-6"/><path d="M10.6 6.4 12 5a3.9 3.9 0 0 1 5.7 5.7l-1.4 1.4M13.4 17.6 12 19a3.9 3.9 0 0 1-5.7-5.7l1.4-1.4"/>',
  shield: '<path d="M12 3.2 19 6v5c0 4.5-3 7.6-7 9.2C8 18.6 5 15.5 5 11V6z"/><path d="M9 11.8l2 2 4-4.2"/>',
  book: '<path d="M5 5.2A2.2 2.2 0 0 1 7.2 3H19v14.4H7.2A2.2 2.2 0 0 0 5 19.6z"/><path d="M5 19.6A2.2 2.2 0 0 1 7.2 17.4H19"/>',
  lightbulb: '<path d="M8.6 16.6a6 6 0 1 1 6.8 0c-.6.4-.9 1-.9 1.7v.3H9.5v-.3c0-.7-.3-1.3-.9-1.7z"/><path d="M9.8 20.6h4.4"/>',
  warning: '<path d="M12 4.4 2.9 20.2h18.2z"/><path d="M12 10.2v4.4"/><path d="M12 17.6v.1" stroke-width="2.2"/>',
  lock: '<rect x="4.8" y="10.4" width="14.4" height="9.6" rx="2.2"/><path d="M8 10.4V7.8a4 4 0 0 1 8 0v2.6"/><path d="M12 14.4v2.2"/>',
  'map-pin': '<path d="M12 21s6-5.3 6-10.2a6 6 0 0 0-12 0C6 15.7 12 21 12 21z"/><circle cx="12" cy="10.8" r="2.3"/>',
  activity: '<path d="M3.5 12h4l2.4-6 3.2 12 2.4-6h4.9"/>',
  globe: '<circle cx="12" cy="12" r="8.4"/><path d="M3.7 12h16.6"/><path d="M12 3.6c2.4 2.7 2.4 14.1 0 16.8M12 3.6c-2.4 2.7-2.4 14.1 0 16.8"/>',
  wrench: '<path d="M15.2 3.6a4 4 0 0 0-4.6 5.8L3.8 16.2a2.1 2.1 0 0 0 3 3l6.8-6.8a4 4 0 0 0 5.8-4.6l-2.7 2.7-2.5-.7-.7-2.5z"/>',
  send: '<path d="M20.4 3.6 10.2 13.8"/><path d="M20.4 3.6 14 20.4l-3.8-6.6L3.6 10z"/>',
  logout: '<path d="M14.5 12H4.5"/><path d="M8 8l-3.5 4L8 16"/><path d="M12 4.5h6a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-6"/>',
  download: '<path d="M12 4v11"/><path d="M8 11.5 12 15.5 16 11.5"/><path d="M5 20h14"/>',
  star: '<path d="M12 3.4 14.5 9l6 .6-4.5 4 1.3 5.9L12 16.4 6.7 19.5 8 13.6l-4.5-4 6-.6z"/>',
  'trend-down': '<path d="M4 8.5 8.5 13l3-3 5.5 6.2"/><path d="M15.6 16.2H20v-4.4"/>',
  play: '<path d="M7.2 5 18.5 12 7.2 19z" fill="currentColor" stroke="none"/>',
  comment: '<path d="M4.5 5.4h15a1.6 1.6 0 0 1 1.6 1.6v7.8a1.6 1.6 0 0 1-1.6 1.6H9.4l-4.2 3.2v-3.2H4.5A1.6 1.6 0 0 1 2.9 14.8V7A1.6 1.6 0 0 1 4.5 5.4z"/>',
  pin: '<path d="M9.2 3.6h5.6l-1 5.2 2.8 2.8v1.8H7.4v-1.8l2.8-2.8z"/><path d="M12 13.4V20.4"/>',
  image: '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.2"/><circle cx="8.6" cy="9.6" r="1.7"/><path d="M4.4 16.8 9 12.2l3.4 3.4 3.2-3.2 4 4"/>',
  megaphone: '<path d="M4 10.4v3.2a1.1 1.1 0 0 0 1.1 1.1H7.4L16.6 19V5L7.4 9.3H5.1A1.1 1.1 0 0 0 4 10.4z"/><path d="M7.6 14.7 8.7 19.8"/><path d="M19.4 9.6v4.8"/>',
  smile: '<circle cx="12" cy="12" r="8.2"/><path d="M8.4 13.8c1.1 1.5 6.1 1.5 7.2 0"/><path d="M9.2 9.6v.4M14.8 9.6v.4" stroke-width="2.1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.2" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 6.5 4.5 11 9 15.5"/><path d="M4.5 11H15a4.5 4.5 0 0 1 0 9h-1.5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.4"/><path d="M16 10.5 21 8v8l-5-2.5z"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.1-5.2"/><path d="M18 3.4v4.2h-4.2"/>',
  battery: '<rect x="2.5" y="8" width="16" height="8" rx="2.2"/><path d="M21 10.8v2.4"/>',
  watch: '<rect x="6.5" y="6.8" width="11" height="10.4" rx="3.2"/><path d="M8.8 6.8 9.3 3.4h5.4l.5 3.4M8.8 17.2l.5 3.4h5.4l.5-3.4"/><path d="M12 10v2.4l1.6 1"/>',
  signal: '<path d="M4 20v-3M9 20v-6M14 20v-9M19 20V6" />',
  eye: '<path d="M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/>',
  dot: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
};

/**
 * Return an inline SVG icon string.
 * @param {string} name  key in the icon set (falls back to a neutral dot)
 * @param {{size?:number, cls?:string, stroke?:number, label?:string}} [opts]
 */
export function icon(name, opts = {}) {
  const { size = 24, cls = '', stroke = 1.75, label } = opts;
  const body = P[name] || P.dot;
  const a11y = label
    ? `role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"`
    : 'aria-hidden="true" focusable="false"';
  const klass = `icon${cls ? ' ' + cls : ''}`;
  return `<svg class="${klass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ${a11y}>`
    + `${body}</svg>`;
}

/** True when an icon with this exact name exists (no fallback). */
export function hasIcon(name) { return Object.prototype.hasOwnProperty.call(P, name); }

/** Machine type → icon name (workout list rows, avatars). */
export function machineIcon(type) {
  return type === 'bike' ? 'bike' : 'oar';
}

/**
 * Best icon for an achievement/badge, chosen from its key so the set stays
 * cohesive instead of leaning on server-sent emoji. Falls back to a medal.
 */
export function badgeIcon(key = '') {
  const k = String(key).toLowerCase();
  if (/(champion|first_place|winner|gold|podium)/.test(k)) return 'crown';
  if (/(streak|fire|consist)/.test(k)) return 'flame';
  if (/(week|month|day|year|calendar|anniversary)/.test(k)) return 'calendar';
  if (/(distance|km|meter|marathon|million|volume)/.test(k)) return 'ruler';
  if (/(pb|record|personal_best|fast|speed|2k|sprint)/.test(k)) return 'bolt';
  if (/(team|social|friend|group|club)/.test(k)) return 'users';
  if (/(power|watt|strong|strength)/.test(k)) return 'dumbbell';
  if (/(goal|target)/.test(k)) return 'target';
  if (/(first|start|begin|rookie|welcome)/.test(k)) return 'star';
  return 'medal';
}
