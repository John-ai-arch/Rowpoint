// Settings: profile & goals, units (§14), social-sharing privacy (§4/§5 —
// deliberately separate from research), research toggle (§5.1), per-category
// notifications (§14), CSV export (§14), full account deletion (§10.1(v)).
import { api, state, setSession, toast, esc } from '../api.js';
import { t, getLocale, setLocale, LOCALES } from '../i18n.js';
import { soundEnabled, setSoundEnabled } from '../celebrate.js';

export function renderSettings(el) {
  const u = state.user;
  const np = u.notifPrefs || {};
  el.innerHTML = `<h1>${esc(t('settings.title'))}</h1>

  <div class="card">
    <h3>${esc(t('settings.language'))}</h3>
    <div class="seg" role="radiogroup" aria-label="${esc(t('settings.language'))}">
      ${LOCALES.map(l => `<button type="button" data-lang="${l.code}" class="${getLocale() === l.code ? 'on' : ''}">${l.flag} ${esc(l.native)}</button>`).join('')}
    </div>
    <p class="muted small mt">${esc(t('settings.languageHint'))}</p>
    <div class="toggle"><div>${esc(t('settings.celebrationSounds'))}</div>
      <label class="switch"><input type="checkbox" id="soundToggle" ${soundEnabled() ? 'checked' : ''}><span class="sl"></span></label></div>
  </div>

  <div class="card">
    <h3>${esc(t('settings.profileGoals'))}</h3>
    <div class="grid cols2">
      <label class="field"><span>Display name</span><input id="displayName" value="${esc(u.displayName)}"></label>
      <label class="field"><span>Units</span>
        <select id="units"><option value="metric" ${u.units === 'metric' ? 'selected' : ''}>Metric</option>
        <option value="imperial" ${u.units === 'imperial' ? 'selected' : ''}>Imperial</option></select></label>
      <label class="field"><span>Weight (kg)</span><input id="weightKg" type="number" value="${u.weightKg ?? ''}"></label>
      <label class="field"><span>Weekly session goal</span><input id="goalWeeklySessions" type="number" min="0" max="28" value="${u.goalWeeklySessions ?? ''}"></label>
      <label class="field"><span>Goal</span>
        <select id="goalType">${['general_fitness', 'race_prep', 'weight_class', 'return_from_injury', 'other'].map(g =>
    `<option value="${g}" ${u.goalType === g ? 'selected' : ''}>${g.replaceAll('_', ' ')}</option>`).join('')}</select></label>
      <label class="field"><span>Target event date</span><input id="goalTargetDate" type="date" value="${u.goalTargetDate || ''}"></label>
    </div>
    <button id="saveProfile">Save profile</button>
    <p class="muted small">Signed in as ${esc(u.email)} (${esc(u.accountType)})${u.emailVerified ? ' · verified ✓' : ' · unverified'}</p>
  </div>

  <div class="card">
    <h3>${esc(t('settings.sharing'))}</h3>
    <p class="muted small">Controls what teammates, coaches, and groups can see. Completely separate from research below.</p>
    ${toggle('shareWorkoutsTeam', 'Share my workouts with my teams & groups', u.shareWorkoutsTeam)}
    ${toggle('share2kHistory', 'Share my 2k PB and attempt history', u.share2kHistory)}
    ${toggle('shareWellnessCoach', 'Share wellness trends with my coach', u.shareWellnessCoach)}
    ${toggle('shareProfile', 'Show profile details (photo, weight class, goal)', u.shareProfile)}
  </div>

  <div class="card">
    <h3>${esc(t('settings.research'))}</h3>
    ${toggle('researchOptIn', 'Contribute my workout and wellness data to research', u.researchOptIn)}
    ${toggle('researchShareDemographics', 'Include demographics (age decade, weight class) in contributions', u.researchShareDemographics)}
    <p class="muted small">Pseudonymized — your name and email never enter the research dataset. Contributions include workout metrics and, when recorded, full heart-rate data. Demographics are a separate consent: with it off, your workouts contribute without any age or weight information. Opting out stops all future contribution immediately and never affects any feature — your own workouts, charts, and heart-rate history stay exactly the same. Data contributed while opted in stays in the research set; deleting your account removes it entirely.</p>
  </div>

  <div class="card">
    <h3>Research profile <span class="muted small">(optional)</span></h3>
    <p class="muted small">These optional fields let anonymized research group you with more precise cohorts. Each is explained; leave any blank. They only enter the dataset while “Include demographics” above is on — always coarsened (e.g. age becomes a broad band, height a 5&nbsp;cm band) so no field can identify you.</p>
    <div class="grid cols2">
      <label class="field"><span>Biological sex <span class="muted">— physiological differences in training response</span></span>
        <select id="rf_sex">${sel(['', 'female', 'male', 'other', 'prefer_not'], ['—', 'Female', 'Male', 'Other', 'Prefer not to say'], u.sex)}</select></label>
      <label class="field"><span>Years rowing <span class="muted">— training age vs calendar age</span></span>
        <input id="rf_years" type="number" min="0" max="80" value="${u.yearsRowing ?? ''}"></label>
      <label class="field"><span>Competition level <span class="muted">— context for training load</span></span>
        <select id="rf_comp">${sel(['', 'recreational', 'club', 'school', 'university', 'national', 'elite'], ['—', 'Recreational', 'Club', 'School', 'University', 'National', 'Elite'], u.competitionLevel)}</select></label>
      <label class="field"><span>Club type <span class="muted">— training environment differs by setting</span></span>
        <select id="rf_club">${sel(['', 'community', 'school', 'university', 'masters', 'national', 'none'], ['—', 'Community', 'School', 'University', 'Masters', 'National', 'None'], u.clubType)}</select></label>
      <label class="field"><span>Training environment <span class="muted">— erg vs water changes the data</span></span>
        <select id="rf_env">${sel(['', 'erg', 'water', 'mixed'], ['—', 'Erg', 'On water', 'Mixed'], u.trainingEnvironment)}</select></label>
      <label class="field"><span>Country <span class="muted">— regional training patterns</span></span>
        <input id="rf_country" maxlength="60" value="${esc(u.country || '')}"></label>
    </div>
    <button class="secondary" id="rf_save">Save research profile</button>
  </div>

  <div class="card" id="experimentsCard">
    <h3>${esc(t('settings.experiments'))}</h3>
    <p class="muted small">${esc(t('settings.experimentsBlurb'))}</p>
    <label class="field"><span>${esc(t('settings.experimentsStatus'))}</span>
      <select id="expConsent">
        <option value="none">${esc(t('settings.expNone'))}</option>
        <option value="active">${esc(t('settings.expActive'))}</option>
        <option value="paused">${esc(t('settings.expPaused'))}</option>
      </select></label>
    <div id="expCurrent" class="small"></div>
    <div class="row mt" style="gap:8px;flex-wrap:wrap">
      <button class="secondary sm" id="expPropose" style="display:none">${esc(t('settings.expPropose'))}</button>
      <button class="ghost sm" id="expDeleteData">${esc(t('settings.expDelete'))}</button>
    </div>
  </div>

  <div class="card">
    <h3>${esc(t('settings.notifications'))}</h3>
    <p class="muted small">Each category is separate — no blanket switch.</p>
    ${toggle('np_workout_reminder', 'Workout reminders', np.workout_reminder)}
    ${toggle('np_wellness_reminder', 'Daily wellness check-in reminder', np.wellness_reminder)}
    ${toggle('np_team_activity', 'Team activity', np.team_activity)}
    ${toggle('np_group_activity', 'Group & connection activity', np.group_activity)}
    ${toggle('np_announcement', 'RowPoint announcements', np.announcement)}
  </div>

  <div class="card">
    <h3>${esc(t('equip.title'))}</h3>
    <p class="muted small">${esc(t('equip.settingsHint'))}</p>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <a class="btn secondary" href="#/equipment">🧰 ${esc(t('equip.manage'))}</a>
      <a class="btn secondary" href="#/integrations">⌚ ${esc(t('integrations.manage'))}</a>
    </div>
  </div>

  <div class="card">
    <h3>${esc(t('settings.yourData'))}</h3>
    <div class="row">
      <button class="secondary" id="exportBtn">${esc(t('settings.exportCsv'))}</button>
    </div>
    <hr style="border-color:var(--border)">
    <h3 style="color:var(--bad)">${esc(t('settings.deleteAccount'))}</h3>
    <p class="muted small">Permanently removes your account, workouts, wellness data, team memberships, and your contributions to the research dataset. This cannot be undone.</p>
    <div class="row">
      <input id="delConfirm" placeholder='type "delete" to confirm' style="flex:1">
      <button class="danger" id="deleteBtn">Delete my account</button>
    </div>
  </div>

  <div class="center mb">
    <button class="ghost" id="logoutBtn">${esc(t('settings.signOut'))}</button>
    <p class="muted small mt">
      <a href="/legal/privacy.html" target="_blank" rel="noopener">${esc(t('settings.privacyPolicy'))}</a>
      · <a href="/legal/terms.html" target="_blank" rel="noopener">${esc(t('settings.termsOfService'))}</a>
    </p>
  </div>`;

  // Language switcher — persists + re-renders the whole app in the new locale.
  el.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => {
    if (getLocale() !== b.dataset.lang) setLocale(b.dataset.lang); // fires rp:locale → app re-renders
  });
  // Celebration sound preference (client-only, off by default).
  el.querySelector('#soundToggle').onchange = (e) => {
    setSoundEnabled(e.target.checked);
    toast(t('settings.saved'), 'success');
  };

  function toggle(id, label, on) {
    return `<div class="toggle"><div>${label}</div>
      <label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="sl"></span></label></div>`;
  }
  function sel(vals, labels, cur) {
    return vals.map((v, i) => `<option value="${esc(v)}" ${cur === v || (!cur && v === '') ? 'selected' : ''}>${esc(labels[i])}</option>`).join('');
  }
  const chk = (id) => el.querySelector(`#${id}`).checked;

  // Research profile → the training-profile endpoint (single source of truth).
  el.querySelector('#rf_save').onclick = async () => {
    try {
      await api('/training/profile', { method: 'PATCH', body: {
        sex: el.querySelector('#rf_sex').value || null,
        yearsRowing: el.querySelector('#rf_years').value ? Number(el.querySelector('#rf_years').value) : null,
        competitionLevel: el.querySelector('#rf_comp').value || null,
        clubType: el.querySelector('#rf_club').value || null,
        trainingEnvironment: el.querySelector('#rf_env').value || null,
        country: el.querySelector('#rf_country').value.trim() || null,
      } });
      toast('Research profile saved.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };

  async function patch(body, msg) {
    try {
      const { user } = await api('/users/me', { method: 'PATCH', body });
      state.user = user;
      toast(msg || 'Saved.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  el.querySelector('#saveProfile').onclick = () => patch({
    displayName: el.querySelector('#displayName').value,
    units: el.querySelector('#units').value,
    weightKg: Number(el.querySelector('#weightKg').value) || undefined,
    goalWeeklySessions: Number(el.querySelector('#goalWeeklySessions').value),
    goalType: el.querySelector('#goalType').value,
    goalTargetDate: el.querySelector('#goalTargetDate').value || null,
  }, 'Profile saved.');

  for (const id of ['shareWorkoutsTeam', 'share2kHistory', 'shareWellnessCoach', 'shareProfile']) {
    el.querySelector(`#${id}`).onchange = () => patch({ [id]: chk(id) }, 'Sharing updated.');
  }
  el.querySelector('#researchOptIn').onchange = () => patch(
    { researchOptIn: chk('researchOptIn') },
    chk('researchOptIn') ? 'Thank you — future workouts will contribute to research.' : 'Opted out — no future data will be contributed.',
  );
  el.querySelector('#researchShareDemographics').onchange = () => patch(
    { researchShareDemographics: chk('researchShareDemographics') },
    'Demographics preference saved.',
  );

  /* ---- experiments consent + lifecycle (separate consent from research) ---- */
  const wireExperiments = async () => {
    const consentSel = el.querySelector('#expConsent');
    const current = el.querySelector('#expCurrent');
    const proposeBtn = el.querySelector('#expPropose');
    try {
      const [{ status }, { experiments }] = await Promise.all([
        api('/experiments/consent'), api('/experiments/mine'),
      ]);
      consentSel.value = status;
      proposeBtn.style.display = status === 'active' ? '' : 'none';
      const active = experiments.find(x => x.status === 'active' || x.status === 'proposed');
      if (active) {
        const p = active.protocol;
        current.innerHTML = `<div class="notice mt">
          <strong>${esc(p.title || active.template)}</strong> <span class="badge blue">${esc(active.status)}</span>
          <p class="small" style="margin:6px 0">${esc(p.objective || '')}</p>
          ${active.status === 'proposed' ? `<p class="muted small">${esc(p.safetyNote || '')}</p>
            <div class="row" style="gap:6px"><button class="secondary sm" data-exp="accept">${esc(t('settings.expAccept'))}</button>
            <button class="ghost sm" data-exp="decline">${esc(t('settings.expDecline'))}</button></div>`
    : `<button class="ghost sm" data-exp="stop">${esc(t('settings.expStop'))}</button>`}
        </div>`;
        current.querySelectorAll('[data-exp]').forEach(b => b.onclick = async () => {
          try { await api(`/experiments/${active.id}/${b.dataset.exp}`, { method: 'POST' }); toast('Done.', 'success'); wireExperiments(); }
          catch (e) { toast(e.message, 'error'); }
        });
      } else {
        const last = experiments[0];
        current.innerHTML = last?.outcome
          ? `<p class="muted small mt">${esc(t('settings.expLastOutcome'))}: ${esc(last.outcome.conclusion)}${last.outcome.measure ? ` — ${esc(last.outcome.measure)}` : ''}</p>`
          : '';
      }
    } catch { current.textContent = ''; }
    consentSel.onchange = async () => {
      try {
        await api('/experiments/consent', { method: 'POST', body: { status: consentSel.value } });
        toast(t('settings.expSaved'), 'success');
        wireExperiments();
      } catch (e) { toast(e.message, 'error'); }
    };
    proposeBtn.onclick = async () => {
      try {
        const r = await api('/experiments/propose', { method: 'POST' });
        toast(r.proposed ? t('settings.expProposed') : (r.reason || ''), r.proposed ? 'success' : 'info');
        wireExperiments();
      } catch (e) { toast(e.message, 'error'); }
    };
    el.querySelector('#expDeleteData').onclick = async () => {
      try {
        const r = await api('/experiments/contributions', { method: 'DELETE' });
        toast(`${t('settings.expDeleted')} (${r.deleted})`, 'success');
        wireExperiments();
      } catch (e) { toast(e.message, 'error'); }
    };
  };
  wireExperiments();
  for (const cat of ['workout_reminder', 'wellness_reminder', 'team_activity', 'group_activity', 'announcement']) {
    el.querySelector(`#np_${cat}`).onchange = () => patch({
      notifPrefs: {
        workout_reminder: chk('np_workout_reminder'), wellness_reminder: chk('np_wellness_reminder'),
        team_activity: chk('np_team_activity'), group_activity: chk('np_group_activity'),
        announcement: chk('np_announcement'),
      },
    }, 'Notification preferences saved.');
  }

  el.querySelector('#exportBtn').onclick = async () => {
    const r = await api('/users/me/export.csv', { raw: true });
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'rowpoint-export.csv'; a.click();
    URL.revokeObjectURL(a.href);
  };

  el.querySelector('#deleteBtn').onclick = async () => {
    if (el.querySelector('#delConfirm').value.trim().toLowerCase() !== 'delete') {
      toast('Type "delete" in the box to confirm.', 'error'); return;
    }
    if (!confirm('Really delete your account and all data forever?')) return;
    try {
      await api('/users/me', { method: 'DELETE', body: { confirm: 'delete' } });
      localStorage.removeItem(`rp_queue_${u.id}`);
      setSession(null, null);
      toast('Your account and data have been deleted. Goodbye 👋', 'success', 6000);
      location.hash = '#/login';
      window.dispatchEvent(new Event('rp:navigate'));
    } catch (e) { toast(e.message, 'error'); }
  };

  el.querySelector('#logoutBtn').onclick = async () => {
    // Invalidate the session server-side (token_version bump), then clear the
    // local token. Best-effort: a network failure still logs out locally.
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* offline — local logout still applies */ }
    setSession(null, null);
    location.hash = '#/login';
    window.dispatchEvent(new Event('rp:navigate'));
  };
}
