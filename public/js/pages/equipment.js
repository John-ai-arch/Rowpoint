// Equipment management (vision #8): the athlete's gear, maintenance + battery
// reminders, and per-erg usage totals from real workout history. CRUD over
// /api/equipment.
import { api, toast, esc, fmtDistance, fmtDate } from '../api.js';
import { confirmDialog } from '../components/dialog.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const TYPES = ['erg', 'hrm', 'boat', 'oars', 'shoes', 'other'];
const TYPE_ICON = { erg: 'oar', hrm: 'pulse', boat: 'boat', oars: 'oar', shoes: 'shoe', other: 'wrench' };
let editing = null; // equipment id being edited, or 'new', or null

export async function renderEquipment(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:80px"></div></div>`;
  let data;
  try { data = await api('/equipment'); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  draw(el, data);
}

function draw(el, data) {
  const items = data.equipment;
  const usage = data.machineUsage || [];
  el.innerHTML = `
    <header class="mb">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div class="page-head"><h1>${esc(t('equip.title'))}</h1><p class="muted">${esc(t('equip.subtitle'))}</p></div>
        <button id="addBtn">${icon('plus', { size: 16 })} ${esc(t('equip.add'))}</button>
      </div>
    </header>
    <div id="formHost"></div>
    ${items.length ? TYPES.filter(ty => items.some(i => i.type === ty)).map(ty => `
      <div class="card">
        <div class="card-head"><span class="icon-chip sm">${icon(TYPE_ICON[ty], { size: 18 })}</span><h3>${esc(t('equip.type_' + ty))}</h3></div>
        ${items.filter(i => i.type === ty).map(itemHtml).join('')}
      </div>`).join('') : `<div class="card"><div class="empty"><div class="center" style="margin-bottom:12px"><span class="icon-chip lg">${icon('wrench')}</span></div><h3>${esc(t('equip.empty'))}</h3></div></div>`}
    ${usage.length ? `<div class="card"><div class="card-head"><span class="icon-chip sm">${icon('activity', { size: 18 })}</span><h3>${esc(t('equip.usage'))}</h3></div>
      <table><thead><tr><th>${esc(t('equip.machine'))}</th><th>${esc(t('equip.meters'))}</th><th>${esc(t('equip.sessions'))}</th><th>${esc(t('equip.lastUsed'))}</th></tr></thead><tbody>
      ${usage.map(m => `<tr><td class="small"><code>${esc((m.machineId || '').slice(0, 16))}</code> ${esc(m.machineType || '')}</td>
        <td>${fmtDistance(m.meters)}</td><td>${m.sessions}</td><td class="small muted">${fmtDate(m.lastUsed)}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted small mt">${esc(t('equip.usageNote'))}</p></div>` : ''}`;

  el.querySelector('#addBtn').onclick = () => { editing = 'new'; renderForm(el, data); };
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { editing = b.dataset.edit; renderForm(el, data); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!(await confirmDialog(t('equip.deleteConfirm'), { confirmText: t('common.delete'), danger: true }))) return;
    await api(`/equipment/${b.dataset.del}`, { method: 'DELETE' });
    toast(t('equip.deleted'), 'success');
    renderEquipment(el);
  });
}

function batteryDue(i) {
  if (i.type !== 'hrm' || !i.batteryChangedOn) return false;
  const months = (Date.now() - new Date(i.batteryChangedOn).getTime()) / (30 * 86400 * 1000);
  return months >= 10;
}

function itemHtml(i) {
  const sub = [i.brand, i.model].filter(Boolean).join(' ');
  return `<div class="list-item" style="align-items:flex-start">
    <div style="flex:1">
      <strong>${esc(i.name)}</strong>${i.retired ? ` <span class="badge">${esc(t('equip.retired'))}</span>` : ''}
      ${batteryDue(i) ? ` <span class="badge amber">${icon('battery', { size: 12 })} ${esc(t('equip.batteryDue'))}</span>` : ''}
      ${sub ? `<div class="muted small">${esc(sub)}${i.serial ? ` · #${esc(i.serial)}` : ''}</div>` : ''}
      ${i.batteryChangedOn ? `<div class="muted small">${esc(t('equip.battery'))}: ${esc(i.batteryChangedOn)}</div>` : ''}
      ${i.maintenanceNote ? `<div class="small row" style="margin-top:3px;gap:5px;align-items:flex-start"><span style="color:var(--muted);flex:none">${icon('wrench', { size: 14 })}</span> ${esc(i.maintenanceNote)}</div>` : ''}
    </div>
    <div class="row" style="gap:4px"><button class="ghost sm" data-edit="${esc(i.id)}">${esc(t('common.edit') || 'Edit')}</button>
      <button class="ghost sm icon-btn" data-del="${esc(i.id)}" aria-label="${esc(t('common.delete') || 'Delete')}">${icon('close', { size: 16 })}</button></div>
  </div>`;
}

function renderForm(el, data) {
  const host = el.querySelector('#formHost');
  const cur = editing === 'new' ? {} : data.equipment.find(i => i.id === editing) || {};
  const machineOpts = (data.machineUsage || []).map(m => `<option value="${esc(m.machineId)}" ${cur.machineId === m.machineId ? 'selected' : ''}>${esc((m.machineId || '').slice(0, 16))} (${esc(m.machineType || '')})</option>`).join('');
  host.innerHTML = `<div class="card">
    <h3>${esc(editing === 'new' ? t('equip.addTitle') : t('equip.editTitle'))}</h3>
    <div class="grid cols2">
      <label class="field"><span>${esc(t('equip.fType'))}</span><select id="eType">${TYPES.map(ty => `<option value="${ty}" ${cur.type === ty ? 'selected' : ''}>${esc(t('equip.type_' + ty))}</option>`).join('')}</select></label>
      <label class="field"><span>${esc(t('equip.fName'))}</span><input id="eName" value="${esc(cur.name || '')}" placeholder="${esc(t('equip.namePh'))}"></label>
      <label class="field"><span>${esc(t('equip.fBrand'))}</span><input id="eBrand" value="${esc(cur.brand || '')}"></label>
      <label class="field"><span>${esc(t('equip.fModel'))}</span><input id="eModel" value="${esc(cur.model || '')}"></label>
      <label class="field"><span>${esc(t('equip.fSerial'))}</span><input id="eSerial" value="${esc(cur.serial || '')}"></label>
      <label class="field"><span>${esc(t('equip.fBattery'))}</span><input id="eBattery" type="date" value="${esc(cur.batteryChangedOn || '')}"></label>
      ${machineOpts ? `<label class="field"><span>${esc(t('equip.fMachine'))}</span><select id="eMachine"><option value="">—</option>${machineOpts}</select></label>` : ''}
    </div>
    <label class="field"><span>${esc(t('equip.fNote'))}</span><textarea id="eNote" rows="2">${esc(cur.maintenanceNote || '')}</textarea></label>
    <div class="row" style="gap:8px"><button id="eSave">${esc(t('equip.save'))}</button><button class="secondary" id="eCancel">${esc(t('common.cancel') || 'Cancel')}</button></div>
  </div>`;
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  host.querySelector('#eCancel').onclick = () => { editing = null; host.innerHTML = ''; };
  host.querySelector('#eSave').onclick = async () => {
    const body = {
      type: host.querySelector('#eType').value,
      name: host.querySelector('#eName').value.trim(),
      brand: host.querySelector('#eBrand').value.trim(),
      model: host.querySelector('#eModel').value.trim(),
      serial: host.querySelector('#eSerial').value.trim(),
      batteryChangedOn: host.querySelector('#eBattery').value || null,
      machineId: host.querySelector('#eMachine')?.value || null,
      maintenanceNote: host.querySelector('#eNote').value.trim(),
    };
    if (!body.name) { toast(t('equip.needName'), 'error'); return; }
    try {
      if (editing === 'new') await api('/equipment', { method: 'POST', body });
      else await api(`/equipment/${editing}`, { method: 'PATCH', body });
      editing = null;
      toast(t('equip.saved'), 'success');
      renderEquipment(el);
    } catch (e) { toast(e.message, 'error'); }
  };
}
