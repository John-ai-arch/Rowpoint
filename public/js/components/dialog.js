// In-app replacements for window.confirm() / window.prompt().
// Styled like every other modal (same .rp-modal overlay + card animation),
// keyboard-accessible (Escape cancels, Enter confirms, focus is trapped and
// restored), and Promise-based so call sites read like the natives:
//   if (!(await confirmDialog('Delete this goal?'))) return;
//   const name = await promptDialog('New name for this monitor:');
//   const idx = await chooseDialog('Share which workout?', labels);
import { esc } from '../api.js';
import { t } from '../i18n.js';

/* Shared scaffold: overlay, card, footer buttons, Escape/Tab handling, focus
   restore. onDecide receives false for every "cancel" path (Escape, backdrop,
   Cancel button) and true for the confirm button. The returned element carries
   a closeDialog(result) function so the dialog variants below can settle with
   their own result values (module-internal contract). */
function openDialog({ title, message, bodyHtml = '', confirmText, cancelText, danger = false, noConfirm = false }, onDecide) {
  document.querySelector('.rp-modal')?.remove();
  const prevFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'rp-modal';
  wrap.setAttribute('role', danger ? 'alertdialog' : 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  if (title) wrap.setAttribute('aria-label', title);
  wrap.innerHTML = `<div class="card dialog-card">
    ${title ? `<h2 class="dialog-title">${esc(title)}</h2>` : ''}
    ${message ? `<p class="dialog-msg">${esc(message)}</p>` : ''}
    ${bodyHtml}
    <div class="dialog-actions">
      <button class="secondary" data-cancel>${esc(cancelText || t('common.cancel'))}</button>
      ${noConfirm ? '' : `<button class="${danger ? 'danger' : ''}" data-confirm>${esc(confirmText || t('common.confirm'))}</button>`}
    </div></div>`;

  const decide = (result) => {
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    onDecide(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); decide(false); }
    if (e.key === 'Tab') {
      // Minimal focus trap: keep Tab cycling inside the dialog.
      const focusables = [...wrap.querySelectorAll('input, textarea, button')];
      const i = focusables.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
      else if (!e.shiftKey && i === focusables.length - 1) { e.preventDefault(); focusables[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) decide(false); });
  wrap.querySelector('[data-cancel]').onclick = () => decide(false);
  const confirmBtn = wrap.querySelector('[data-confirm]');
  if (confirmBtn) confirmBtn.onclick = () => decide(true);
  wrap.closeDialog = decide;
  document.body.appendChild(wrap);
  return wrap;
}

/** Styled confirm(). Resolves true only when the user explicitly confirms. */
export function confirmDialog(message, { title, confirmText, cancelText, danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = openDialog({ title, message, confirmText, cancelText, danger }, (r) => resolve(r === true));
    // Destructive dialogs focus the safe action; others focus the primary one.
    wrap.querySelector(danger ? '[data-cancel]' : '[data-confirm]').focus();
  });
}

/** Styled prompt(). Resolves the entered string, or null when cancelled. */
export function promptDialog(message, { title, initial = '', placeholder = '', confirmText, cancelText, multiline = false } = {}) {
  return new Promise((resolve) => {
    const field = multiline
      ? `<textarea id="dlgInput" rows="3" placeholder="${esc(placeholder)}">${esc(initial)}</textarea>`
      : `<input id="dlgInput" type="text" value="${esc(initial)}" placeholder="${esc(placeholder)}">`;
    const wrap = openDialog(
      { title, message, bodyHtml: `<div class="dialog-field">${field}</div>`, confirmText, cancelText },
      (r) => resolve(r === true ? wrap.querySelector('#dlgInput').value : null));
    const input = wrap.querySelector('#dlgInput');
    if (!multiline) input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); wrap.querySelector('[data-confirm]').click(); }
    });
    input.focus();
    if (initial) input.select();
  });
}

/** Styled option picker. Resolves the chosen option's index, or null when
    cancelled. `inline: true` lays the options out as a compact row (e.g. an
    emoji palette) instead of a stacked list. */
export function chooseDialog(message, options, { title, cancelText, inline = false } = {}) {
  return new Promise((resolve) => {
    const bodyHtml = `<div class="dialog-choices${inline ? ' inline' : ''}">${options.map((o, i) =>
      `<button class="secondary dialog-choice" data-choice="${i}">${esc(o)}</button>`).join('')}</div>`;
    const wrap = openDialog(
      { title, message, bodyHtml, cancelText, noConfirm: true },
      (r) => resolve(typeof r === 'number' ? r : null));
    wrap.querySelectorAll('[data-choice]').forEach(b => {
      b.onclick = () => wrap.closeDialog(Number(b.dataset.choice));
    });
    wrap.querySelector('[data-choice]')?.focus();
  });
}
