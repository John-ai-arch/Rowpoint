// §2.1 — Signup (account type, structured goals, team code), the §5.1
// research-consent screen, and MANDATORY email verification: there is no way
// into the app with an unverified address — no token is issued until the
// code is confirmed, and there is deliberately no "skip" path.
//
// Sign-in providers are discovered from the server: the Google button only
// exists when GOOGLE_CLIENT_ID is configured (real Google Identity Services
// flow); nothing renders for unconfigured providers.
import { api, setSession, toast, esc } from '../api.js';
import { t } from '../i18n.js';

let providers = null; // { google, googleClientId, apple, devMail }

export async function renderAuth(el) {
  let mode = 'login';
  let step = 1;
  const data = {
    accountType: 'rower', units: 'metric', researchOptIn: true,
    goalType: 'general_fitness',
  };
  if (!providers) {
    try { providers = await api('/auth/providers'); } catch { providers = { google: false, apple: false, devMail: true }; }
  }

  function draw() {
    el.innerHTML = `<div class="auth-wrap">
      <div class="center mb">
        <div class="brand" style="justify-content:center;font-size:1.7rem"><span class="dot"></span> RowPoint</div>
        <p class="muted">${esc(t('common.tagline'))}</p>
      </div>
      <div class="card">${mode === 'login' ? loginHtml() : signupHtml()}</div>
      <p class="center muted small">
        ${mode === 'login'
    ? `${esc(t('auth.newHere'))} <a href="#" id="swap">${esc(t('auth.createAccount'))}</a>`
    : `${esc(t('auth.haveAccount'))} <a href="#" id="swap">${esc(t('auth.signIn'))}</a>`}
      </p>
    </div>`;
    wire();
  }

  const oauthButtonsHtml = () => {
    if (!providers.google && !providers.apple) return '';
    return `<div class="row mt" style="gap:8px">
      ${providers.google ? `<div id="googleBtnHost" style="flex:1;display:flex;justify-content:center"></div>` : ''}
      ${providers.apple ? `<button class="secondary" style="flex:1" id="appleBtn"> Sign in with Apple</button>` : ''}
    </div>`;
  };

  const loginHtml = () => `
    <h2>${esc(t('auth.signIn'))}</h2>
    <label class="field"><span>${esc(t('auth.email'))}</span><input id="email" type="email" autocomplete="email" value="${esc(data.email || '')}"></label>
    <label class="field"><span>${esc(t('auth.password'))}</span><input id="password" type="password" autocomplete="current-password"></label>
    <button id="loginBtn" style="width:100%">${esc(t('auth.signInCta'))}</button>
    <div class="center mt"><a href="#" id="forgotLink" class="small muted">${esc(t('auth.forgotPassword'))}</a></div>
    ${oauthButtonsHtml()}`;

  function signupHtml() {
    const dots = `<div class="step-dots">${[1, 2, 3].map(i => `<span class="d ${i <= step ? 'on' : ''}"></span>`).join('')}</div>`;
    if (step === 1) return `${dots}<h2>${esc(t('auth.createAccount'))}</h2>
      <label class="field"><span>${esc(t('auth.iAmA'))}</span>
        <div class="seg" role="radiogroup">
          <button type="button" data-type="rower" class="${data.accountType === 'rower' ? 'on' : ''}">${esc(t('auth.rower'))}</button>
          <button type="button" data-type="coach" class="${data.accountType === 'coach' ? 'on' : ''}">${esc(t('auth.coach'))}</button>
        </div>
        <p class="muted small">${data.accountType === 'coach' ? esc(t('auth.coachHint')) : esc(t('auth.rowerHint'))}</p>
      </label>
      <label class="field"><span>${esc(t('auth.displayName'))}</span><input id="displayName" value="${esc(data.displayName || '')}"></label>
      <label class="field"><span>${esc(t('auth.email'))}</span><input id="email" type="email" value="${esc(data.email || '')}"></label>
      <label class="field"><span>${esc(t('auth.passwordMin'))}</span><input id="password" type="password" value="${esc(data.password || '')}"></label>
      ${data.accountType === 'rower' ? `<label class="field"><span>${esc(t('auth.teamCodeOptional'))}</span><input id="teamCode" placeholder="e.g. KX7M2PQ" value="${esc(data.teamCode || '')}"></label>` : ''}
      <button id="next1" style="width:100%">${esc(t('common.continue'))}</button>
      ${oauthButtonsHtml()}`;

    if (step === 2) return `${dots}<h2>${esc(t('onboarding.profileTitle'))}</h2>
      <p class="muted small">${esc(t('onboarding.profileSub'))}</p>
      <div class="grid cols2">
        <label class="field"><span>${esc(t('onboarding.birthYear'))}</span><input id="birthYear" type="number" min="1920" max="2020" value="${data.birthYear || ''}"></label>
        <label class="field"><span>${esc(t('onboarding.weightKg'))}</span><input id="weightKg" type="number" min="30" max="200" value="${data.weightKg || ''}"></label>
      </div>
      <label class="field"><span>${esc(t('onboarding.best2k'))}</span><input id="best2k" placeholder="7:45" value="${esc(data.best2k || '')}"></label>
      <label class="field"><span>${esc(t('onboarding.units'))}</span>
        <select id="units"><option value="metric" ${data.units === 'metric' ? 'selected' : ''}>${esc(t('onboarding.metric'))}</option><option value="imperial" ${data.units === 'imperial' ? 'selected' : ''}>${esc(t('onboarding.imperial'))}</option></select></label>
      <label class="field"><span>${esc(t('onboarding.primaryGoal'))}</span>
        <select id="goalType">
          <option value="general_fitness" ${data.goalType === 'general_fitness' ? 'selected' : ''}>${esc(t('onboarding.goalGeneral'))}</option>
          <option value="race_prep" ${data.goalType === 'race_prep' ? 'selected' : ''}>${esc(t('onboarding.goalRace'))}</option>
          <option value="weight_class" ${data.goalType === 'weight_class' ? 'selected' : ''}>${esc(t('onboarding.goalWeight'))}</option>
          <option value="return_from_injury" ${data.goalType === 'return_from_injury' ? 'selected' : ''}>${esc(t('onboarding.goalInjury'))}</option>
          <option value="other" ${data.goalType === 'other' ? 'selected' : ''}>${esc(t('onboarding.goalOther'))}</option>
        </select></label>
      <div class="grid cols2">
        <label class="field"><span>${esc(t('onboarding.targetEvent'))}</span><input id="goalTargetEvent" placeholder="Spring head race" value="${esc(data.goalTargetEvent || '')}"></label>
        <label class="field"><span>${esc(t('onboarding.eventDate'))}</span><input id="goalTargetDate" type="date" value="${data.goalTargetDate || ''}"></label>
      </div>
      <label class="field"><span>${esc(t('onboarding.weeklySessions'))}</span><input id="goalWeeklySessions" type="number" min="0" max="28" value="${data.goalWeeklySessions ?? 4}"></label>
      <div class="row"><button class="secondary" id="back2">${esc(t('common.back'))}</button><button id="next2" style="flex:1">${esc(t('common.continue'))}</button></div>`;

    return `${dots}<h2>${esc(t('onboarding.researchTitle'))}</h2>
      <div class="notice mb">
        <p><strong>${esc(t('onboarding.researchBody'))}</strong></p>
        <p>${esc(t('onboarding.researchBody2'))}</p>
      </div>
      <div class="toggle"><div><strong>${esc(t('onboarding.researchToggle'))}</strong></div>
        <label class="switch"><input type="checkbox" id="research" ${data.researchOptIn ? 'checked' : ''}><span class="sl"></span></label></div>
      <p class="muted small">${esc(t('onboarding.researchSeparate'))}</p>
      <div class="row mt"><button class="secondary" id="back3">${esc(t('common.back'))}</button><button id="createBtn" style="flex:1">${esc(t('auth.createAccountCta'))}</button></div>`;
  }

  /* ---------------- Google Identity Services ---------------- */

  function mountGoogleButton() {
    const host = el.querySelector('#googleBtnHost');
    if (!host || !providers.google) return;
    const render = () => {
      window.google.accounts.id.initialize({
        client_id: providers.googleClientId,
        callback: (resp) => handleGoogleCredential(resp.credential),
      });
      window.google.accounts.id.renderButton(host, { theme: 'filled_black', size: 'large', width: 260 });
    };
    if (window.google?.accounts?.id) { render(); return; }
    if (!document.getElementById('gsiScript')) {
      const s = document.createElement('script');
      s.id = 'gsiScript';
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = render;
      s.onerror = () => { host.innerHTML = '<p class="muted small">Google sign-in could not load — check your connection.</p>'; };
      document.head.appendChild(s);
    } else {
      document.getElementById('gsiScript').addEventListener('load', render);
    }
  }

  async function handleGoogleCredential(idToken, extra = {}) {
    try {
      const res = await api('/auth/oauth/google', { method: 'POST', body: { idToken, ...extra } });
      if (res.needsProfile) {
        // First Google sign-in still needs the account-type choice + consent.
        showOauthProfile(idToken, res.suggestedName, res.email);
        return;
      }
      finish(res, t('auth.welcome', { name: res.user.displayName }));
    } catch (e) { toast(e.message, 'error', 6000); }
  }

  function showOauthProfile(idToken, suggestedName, email) {
    el.innerHTML = `<div class="auth-wrap"><div class="card">
      <h2>${esc(t('onboarding.oauthAlmost'))}</h2>
      <p class="muted small">${esc(t('onboarding.oauthSigningUp', { email }))}</p>
      <label class="field"><span>${esc(t('auth.iAmA'))}</span>
        <div class="seg"><button type="button" data-otype="rower" class="on">${esc(t('auth.rower'))}</button><button type="button" data-otype="coach">${esc(t('auth.coach'))}</button></div></label>
      <label class="field"><span>${esc(t('auth.displayName'))}</span><input id="oName" value="${esc(suggestedName || '')}"></label>
      <div class="toggle"><div><strong>${esc(t('onboarding.researchToggle'))}</strong>
        <p class="muted small">${esc(t('onboarding.researchSeparate'))}</p></div>
        <label class="switch"><input type="checkbox" id="oResearch" checked><span class="sl"></span></label></div>
      <button id="oCreate" style="width:100%">${esc(t('auth.createAccountCta'))}</button>
    </div></div>`;
    let otype = 'rower';
    el.querySelectorAll('[data-otype]').forEach(b => b.onclick = () => {
      el.querySelectorAll('[data-otype]').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); otype = b.dataset.otype;
    });
    el.querySelector('#oCreate').onclick = () => handleGoogleCredential(idToken, {
      accountType: otype,
      displayName: el.querySelector('#oName').value.trim(),
      researchOptIn: el.querySelector('#oResearch').checked,
    });
  }

  /* ---------------- Sign in with Apple ---------------- */

  function loadAppleSdk() {
    return new Promise((resolve, reject) => {
      if (window.AppleID?.auth) return resolve();
      const existing = document.getElementById('appleSdk');
      if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', () => reject(new Error('load failed'))); return; }
      const s = document.createElement('script');
      s.id = 'appleSdk';
      s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Apple sign-in could not load — check your connection.'));
      document.head.appendChild(s);
    });
  }

  async function handleAppleSignIn() {
    if (!providers.apple || !providers.appleClientId) { toast(t('auth.appleUnavailable'), 'error', 6000); return; }
    try {
      await loadAppleSdk();
      window.AppleID.auth.init({ clientId: providers.appleClientId, scope: 'name email', redirectURI: location.origin, usePopup: true });
      const resp = await window.AppleID.auth.signIn();
      const idToken = resp?.authorization?.id_token;
      if (!idToken) throw new Error('No Apple identity token was returned.');
      // Apple only provides the name on the very first authorization.
      const nm = resp?.user?.name;
      const displayName = nm ? [nm.firstName, nm.lastName].filter(Boolean).join(' ') : undefined;
      const res = await api('/auth/oauth/apple', { method: 'POST', body: { idToken, displayName } });
      if (res.needsProfile) { showAppleProfile(idToken, res.suggestedName, res.email); return; }
      finish(res, t('auth.welcome', { name: res.user.displayName }));
    } catch (e) {
      if (e?.error === 'popup_closed_by_user' || e?.error === 'user_cancelled_authorize') return;
      toast(e.message || 'Apple sign-in failed.', 'error', 6000);
    }
  }

  function showAppleProfile(idToken, suggestedName, email) {
    el.innerHTML = `<div class="auth-wrap"><div class="card">
      <h2>${esc(t('onboarding.oauthAlmost'))}</h2>
      <p class="muted small">${esc(t('onboarding.oauthSigningUp', { email: email || 'your Apple ID' }))}</p>
      <label class="field"><span>${esc(t('auth.iAmA'))}</span>
        <div class="seg"><button type="button" data-atype="rower" class="on">${esc(t('auth.rower'))}</button><button type="button" data-atype="coach">${esc(t('auth.coach'))}</button></div></label>
      <label class="field"><span>${esc(t('auth.displayName'))}</span><input id="aName" value="${esc(suggestedName || '')}"></label>
      <div class="toggle"><div><strong>${esc(t('onboarding.researchToggle'))}</strong>
        <p class="muted small">${esc(t('onboarding.researchSeparate'))}</p></div>
        <label class="switch"><input type="checkbox" id="aResearch" checked><span class="sl"></span></label></div>
      <button id="aCreate" style="width:100%">${esc(t('auth.createAccountCta'))}</button>
    </div></div>`;
    let atype = 'rower';
    el.querySelectorAll('[data-atype]').forEach(b => b.onclick = () => {
      el.querySelectorAll('[data-atype]').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); atype = b.dataset.atype;
    });
    el.querySelector('#aCreate').onclick = async () => {
      try {
        const res = await api('/auth/oauth/apple', { method: 'POST', body: {
          idToken, accountType: atype,
          displayName: el.querySelector('#aName').value.trim(),
          researchOptIn: el.querySelector('#aResearch').checked,
        } });
        finish(res, t('auth.welcome', { name: res.user.displayName }));
      } catch (e) { toast(e.message, 'error', 6000); }
    };
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    el.querySelector('#swap')?.addEventListener('click', (e) => { e.preventDefault(); mode = mode === 'login' ? 'signup' : 'login'; step = 1; draw(); });
    el.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { data.accountType = b.dataset.type; draw(); });
    mountGoogleButton();

    el.querySelector('#appleBtn')?.addEventListener('click', () => handleAppleSignIn());

    el.querySelector('#loginBtn')?.addEventListener('click', async () => {
      try {
        const res = await api('/auth/login', { method: 'POST', body: { email: val('#email'), password: val('#password') } });
        if (res.needsVerification) {
          // No session until verified — straight to the code screen.
          showVerify(res.email, res.devCode);
          return;
        }
        finish(res);
      } catch (e) { toast(e.message, 'error'); }
    });

    el.querySelector('#forgotLink')?.addEventListener('click', (e) => { e.preventDefault(); showForgot(val('#email')); });

    el.querySelector('#next1')?.addEventListener('click', () => {
      Object.assign(data, { displayName: val('#displayName'), email: val('#email'), password: val('#password'), teamCode: val('#teamCode') });
      if (!data.displayName || !data.email || (data.password || '').length < 8) { toast(t('auth.fillNamePassword'), 'error'); return; }
      step = 2; draw();
    });
    el.querySelector('#back2')?.addEventListener('click', () => { step = 1; draw(); });
    el.querySelector('#next2')?.addEventListener('click', () => {
      Object.assign(data, {
        birthYear: val('#birthYear'), weightKg: val('#weightKg'), best2k: val('#best2k'),
        units: val('#units'), goalType: val('#goalType'), goalTargetEvent: val('#goalTargetEvent'),
        goalTargetDate: val('#goalTargetDate'), goalWeeklySessions: val('#goalWeeklySessions'),
      });
      step = 3; draw();
    });
    el.querySelector('#back3')?.addEventListener('click', () => { step = 2; draw(); });
    el.querySelector('#createBtn')?.addEventListener('click', async () => {
      data.researchOptIn = el.querySelector('#research').checked;
      const best2kSeconds = parse2k(data.best2k);
      try {
        const res = await api('/auth/signup', {
          method: 'POST',
          body: {
            email: data.email, password: data.password, displayName: data.displayName,
            accountType: data.accountType, teamCode: data.teamCode || undefined,
            birthYear: data.birthYear || undefined, weightKg: data.weightKg || undefined,
            best2kSeconds, units: data.units, goalType: data.goalType,
            goalTargetEvent: data.goalTargetEvent || undefined, goalTargetDate: data.goalTargetDate || undefined,
            goalWeeklySessions: data.goalWeeklySessions, researchOptIn: data.researchOptIn,
          },
        });
        if (res.joinedTeam) toast(t('auth.joinTeamOnceVerified', { team: res.joinedTeam.name }), 'success');
        showVerify(res.email, res.devCode);
      } catch (e) {
        if (e.code === 'email_taken') {
          // The account already exists — never create a duplicate. Send the
          // user to sign in with their email prefilled instead.
          mode = 'login'; step = 1; draw();
          toast(t('auth.emailTakenPrompt'), 'info', 7000);
          const emailInput = el.querySelector('#email');
          if (emailInput) { emailInput.value = data.email; el.querySelector('#password')?.focus(); }
          return;
        }
        toast(e.message, 'error');
      }
    });
  }

  function showVerify(email, devCode) {
    el.innerHTML = `<div class="auth-wrap"><div class="card">
      <h2>${esc(t('verify.title'))}</h2>
      <p class="muted">${esc(t('verify.sentTo', { email }))}</p>
      ${devCode ? `<div class="notice mb"><strong>${esc(t('verify.devMode'))}</strong> ${esc(t('verify.devModeBody'))} <strong style="font-size:1.3rem;letter-spacing:3px">${esc(devCode)}</strong><br><span class="muted small">${esc(t('verify.devModeHint'))}</span></div>` : ''}
      <label class="field"><span>${esc(t('verify.codeLabel'))}</span><input id="code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></label>
      <button id="verifyBtn" style="width:100%">${esc(t('verify.verifyEnter'))}</button>
      <div class="row mt center">
        <button class="ghost sm" id="resend">${esc(t('verify.resend'))}</button>
        <button class="ghost sm" id="backToLogin">${esc(t('verify.backToSignIn'))}</button>
      </div>
    </div></div>`;
    el.querySelector('#verifyBtn').onclick = async () => {
      try {
        const res = await api('/auth/verify', { method: 'POST', body: { email, code: val('#code') } });
        finish(res, t('auth.verifiedWelcome'));
      } catch (e) { toast(e.message, 'error'); }
    };
    el.querySelector('#resend').onclick = async () => {
      const r = await api('/auth/resend-verification', { method: 'POST', body: { email } });
      toast(t('verify.resent'));
      if (r.devCode) showVerify(email, r.devCode);
    };
    el.querySelector('#backToLogin').onclick = () => { mode = 'login'; step = 1; draw(); };
  }

  /* ---------------- password recovery ---------------- */

  function showForgot(prefillEmail) {
    el.innerHTML = `<div class="auth-wrap"><div class="card">
      <h2>${esc(t('auth.forgotTitle'))}</h2>
      <p class="muted">${esc(t('auth.forgotSub'))}</p>
      <label class="field"><span>${esc(t('auth.email'))}</span><input id="fEmail" type="email" autocomplete="email" value="${esc(prefillEmail || '')}"></label>
      <button id="fSend" style="width:100%">${esc(t('auth.forgotSend'))}</button>
      <div class="center mt"><button class="ghost sm" id="fBack">${esc(t('verify.backToSignIn'))}</button></div>
    </div></div>`;
    el.querySelector('#fBack').onclick = () => { mode = 'login'; step = 1; draw(); };
    el.querySelector('#fSend').onclick = async () => {
      const email = el.querySelector('#fEmail').value.trim();
      if (!email) { toast(t('auth.forgotNeedEmail'), 'error'); return; }
      try {
        const r = await api('/auth/forgot-password', { method: 'POST', body: { email } });
        toast(t('auth.forgotSent'), 'success', 6000);
        showReset(email, r.devCode);
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  function showReset(email, devCode) {
    el.innerHTML = `<div class="auth-wrap"><div class="card">
      <h2>${esc(t('auth.resetTitle'))}</h2>
      <p class="muted">${esc(t('auth.resetSub', { email }))}</p>
      ${devCode ? `<div class="notice mb"><strong>${esc(t('verify.devMode'))}</strong> ${esc(t('auth.resetDevBody'))} <strong style="font-size:1.2rem;letter-spacing:3px">${esc(devCode)}</strong></div>` : ''}
      <label class="field"><span>${esc(t('auth.resetCodeLabel'))}</span><input id="rCode" maxlength="8" placeholder="ABCD2345" autocomplete="one-time-code" style="text-transform:uppercase"></label>
      <label class="field"><span>${esc(t('auth.resetNewPassword'))}</span><input id="rPass" type="password" autocomplete="new-password"></label>
      <button id="rSubmit" style="width:100%">${esc(t('auth.resetSubmit'))}</button>
      <div class="center mt"><button class="ghost sm" id="rBack">${esc(t('verify.backToSignIn'))}</button></div>
    </div></div>`;
    el.querySelector('#rBack').onclick = () => { mode = 'login'; step = 1; draw(); };
    el.querySelector('#rSubmit').onclick = async () => {
      const code = el.querySelector('#rCode').value.trim();
      const newPassword = el.querySelector('#rPass').value;
      if ((newPassword || '').length < 8) { toast(t('auth.resetWeak'), 'error'); return; }
      try {
        const res = await api('/auth/reset-password', { method: 'POST', body: { email, code, newPassword } });
        finish(res, t('auth.resetDone'));
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  function finish(res, msg) {
    // The server set the HttpOnly session + CSRF cookies on this response, so
    // the browser is authenticated via cookie — we deliberately keep no token
    // in JS (pass null) rather than holding a Bearer token in memory.
    setSession(null, res.user);
    if (msg) toast(msg, 'success');
    window.dispatchEvent(new Event('rp:session'));
    location.hash = '#/';
  }

  const val = (sel) => el.querySelector(sel)?.value?.trim();
  draw();
}

function parse2k(s) {
  if (!s) return undefined;
  const m = String(s).match(/^(\d{1,2}):(\d{2}(?:\.\d)?)$/);
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}
