// Settings: profile & goals, units (§14), social-sharing privacy (§4/§5 —
// deliberately separate from research), research toggle (§5.1), per-category
// notifications (§14), CSV export (§14), full account deletion (§10.1(v)).
import { api, state, setSession, toast, esc } from '../api.js';

export function renderSettings(el) {
  const u = state.user;
  const np = u.notifPrefs || {};
  el.innerHTML = `<h1>Settings</h1>

  <div class="card">
    <h3>Profile & goals</h3>
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
    <h3>Sharing with teams & groups</h3>
    <p class="muted small">Controls what teammates, coaches, and groups can see. Completely separate from research below.</p>
    ${toggle('shareWorkoutsTeam', 'Share my workouts with my teams & groups', u.shareWorkoutsTeam)}
    ${toggle('share2kHistory', 'Share my 2k PB and attempt history', u.share2kHistory)}
    ${toggle('shareWellnessCoach', 'Share wellness trends with my coach', u.shareWellnessCoach)}
    ${toggle('shareProfile', 'Show profile details (photo, weight class, goal)', u.shareProfile)}
  </div>

  <div class="card">
    <h3>Research contribution</h3>
    ${toggle('researchOptIn', 'Contribute my workout and wellness data to research', u.researchOptIn)}
    ${toggle('researchShareDemographics', 'Include demographics (age decade, weight class) in contributions', u.researchShareDemographics)}
    <p class="muted small">Pseudonymized — your name and email never enter the research dataset. Contributions include workout metrics and, when recorded, full heart-rate data. Demographics are a separate consent: with it off, your workouts contribute without any age or weight information. Opting out stops all future contribution immediately and never affects any feature. Data contributed while opted in stays in the research set; deleting your account removes it entirely.</p>
  </div>

  <div class="card">
    <h3>Notifications</h3>
    <p class="muted small">Each category is separate — no blanket switch.</p>
    ${toggle('np_workout_reminder', 'Workout reminders', np.workout_reminder)}
    ${toggle('np_wellness_reminder', 'Daily wellness check-in reminder', np.wellness_reminder)}
    ${toggle('np_team_activity', 'Team activity', np.team_activity)}
    ${toggle('np_group_activity', 'Group & connection activity', np.group_activity)}
    ${toggle('np_announcement', 'RowPoint announcements', np.announcement)}
  </div>

  <div class="card">
    <h3>Your data</h3>
    <div class="row">
      <button class="secondary" id="exportBtn">Export my history (CSV)</button>
    </div>
    <hr style="border-color:var(--border)">
    <h3 style="color:var(--bad)">Delete account</h3>
    <p class="muted small">Permanently removes your account, workouts, wellness data, team memberships, and your contributions to the research dataset. This cannot be undone.</p>
    <div class="row">
      <input id="delConfirm" placeholder='type "delete" to confirm' style="flex:1">
      <button class="danger" id="deleteBtn">Delete my account</button>
    </div>
  </div>

  <div class="center mb"><button class="ghost" id="logoutBtn">Sign out</button></div>`;

  function toggle(id, label, on) {
    return `<div class="toggle"><div>${label}</div>
      <label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="sl"></span></label></div>`;
  }
  const chk = (id) => el.querySelector(`#${id}`).checked;

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

  el.querySelector('#logoutBtn').onclick = () => {
    setSession(null, null);
    location.hash = '#/login';
    window.dispatchEvent(new Event('rp:navigate'));
  };
}
