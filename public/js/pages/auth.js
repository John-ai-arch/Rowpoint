// §2.1 — Signup (account type, structured goals, team code), the §5.1
// research-consent screen, and MANDATORY email verification: there is no way
// into the app with an unverified address — no token is issued until the
// code is confirmed, and there is deliberately no "skip" path.
//
// Sign-in providers are discovered from the server: the Google button only
// exists when GOOGLE_CLIENT_ID is configured (real Google Identity Services
// flow); nothing renders for unconfigured providers.
import { api, setSession, toast, esc } from '../api.js';

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
        <div class="brand" style="justify-content:center;font-size:1.6rem"><span class="dot"></span> RowPoint</div>
        <p class="muted">Train. Connect. Contribute.</p>
      </div>
      <div class="card">${mode === 'login' ? loginHtml() : signupHtml()}</div>
      <p class="center muted small">
        ${mode === 'login'
    ? `New to RowPoint? <a href="#" id="swap">Create an account</a>`
    : `Already have an account? <a href="#" id="swap">Sign in</a>`}
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
    <h2>Sign in</h2>
    <label class="field"><span>Email</span><input id="email" type="email" autocomplete="email" value="${esc(data.email || '')}"></label>
    <label class="field"><span>Password</span><input id="password" type="password" autocomplete="current-password"></label>
    <button id="loginBtn" style="width:100%">Sign in</button>
    ${oauthButtonsHtml()}`;

  function signupHtml() {
    const dots = `<div class="step-dots">${[1, 2, 3].map(i => `<span class="d ${i <= step ? 'on' : ''}"></span>`).join('')}</div>`;
    if (step === 1) return `${dots}<h2>Create your account</h2>
      <label class="field"><span>I am a…</span>
        <div class="seg" role="radiogroup">
          <button type="button" data-type="rower" class="${data.accountType === 'rower' ? 'on' : ''}">Rower</button>
          <button type="button" data-type="coach" class="${data.accountType === 'coach' ? 'on' : ''}">Coach</button>
        </div>
        <p class="muted small">${data.accountType === 'coach'
    ? 'Coaches get a shareable team code the moment the account is created.'
    : 'Rowers can optionally join a coach\'s team with a team code — or train fully standalone.'}</p>
      </label>
      <label class="field"><span>Display name</span><input id="displayName" value="${esc(data.displayName || '')}"></label>
      <label class="field"><span>Email</span><input id="email" type="email" value="${esc(data.email || '')}"></label>
      <label class="field"><span>Password (min 8 characters)</span><input id="password" type="password" value="${esc(data.password || '')}"></label>
      ${data.accountType === 'rower' ? `<label class="field"><span>Team code (optional)</span><input id="teamCode" placeholder="e.g. KX7M2PQ" value="${esc(data.teamCode || '')}"></label>` : ''}
      <button id="next1" style="width:100%">Continue</button>
      ${oauthButtonsHtml()}`;

    if (step === 2) return `${dots}<h2>Profile & training goals</h2>
      <p class="muted small">All optional and editable later — but your goals are what power the AI training assistant, so the more real they are, the better its suggestions.</p>
      <div class="grid cols2">
        <label class="field"><span>Birth year</span><input id="birthYear" type="number" min="1920" max="2020" value="${data.birthYear || ''}"></label>
        <label class="field"><span>Weight (kg)</span><input id="weightKg" type="number" min="30" max="200" value="${data.weightKg || ''}"></label>
      </div>
      <label class="field"><span>Best known 2k time (mm:ss, self-reported)</span><input id="best2k" placeholder="7:45" value="${esc(data.best2k || '')}"></label>
      <label class="field"><span>Preferred units</span>
        <select id="units"><option value="metric" ${data.units === 'metric' ? 'selected' : ''}>Metric</option><option value="imperial" ${data.units === 'imperial' ? 'selected' : ''}>Imperial</option></select></label>
      <label class="field"><span>Primary goal</span>
        <select id="goalType">
          <option value="general_fitness" ${data.goalType === 'general_fitness' ? 'selected' : ''}>General fitness</option>
          <option value="race_prep" ${data.goalType === 'race_prep' ? 'selected' : ''}>Race preparation</option>
          <option value="weight_class" ${data.goalType === 'weight_class' ? 'selected' : ''}>Weight-class management</option>
          <option value="return_from_injury" ${data.goalType === 'return_from_injury' ? 'selected' : ''}>Return from injury</option>
          <option value="other" ${data.goalType === 'other' ? 'selected' : ''}>Other</option>
        </select></label>
      <div class="grid cols2">
        <label class="field"><span>Target event (optional)</span><input id="goalTargetEvent" placeholder="Spring head race" value="${esc(data.goalTargetEvent || '')}"></label>
        <label class="field"><span>Event date</span><input id="goalTargetDate" type="date" value="${data.goalTargetDate || ''}"></label>
      </div>
      <label class="field"><span>Desired sessions per week</span><input id="goalWeeklySessions" type="number" min="0" max="28" value="${data.goalWeeklySessions ?? 4}"></label>
      <div class="row"><button class="secondary" id="back2">Back</button><button id="next2" style="flex:1">Continue</button></div>`;

    return `${dots}<h2>Contributing to rowing research</h2>
      <div class="notice mb">
        <p><strong>By default, RowPoint contributes your workout and daily wellness data — pseudonymized, never with your name or email — to an ongoing rowing-performance research dataset</strong> used across multiple studies.</p>
        <p>You can opt out right here, or at any time later in Settings, with <strong>zero effect on any app feature</strong>. If you opt out later, no future data is contributed from that moment on; data contributed while you were opted in is retained in the research set (deleting your account removes it entirely).</p>
      </div>
      <div class="toggle"><div><strong>Contribute my workout and wellness data to research</strong></div>
        <label class="switch"><input type="checkbox" id="research" ${data.researchOptIn ? 'checked' : ''}><span class="sl"></span></label></div>
      <p class="muted small">This is separate from what you share with teammates — team and group sharing has its own controls in Settings.</p>
      <div class="row mt"><button class="secondary" id="back3">Back</button><button id="createBtn" style="flex:1">Create account</button></div>`;
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
      finish(res, `Welcome, ${res.user.displayName}!`);
    } catch (e) { toast(e.message, 'error', 6000); }
  }

  function showOauthProfile(idToken, suggestedName, email) {
    el.innerHTML = `<div class="auth-wrap"><div class="card">
      <h2>Almost there</h2>
      <p class="muted small">Signing up as <strong>${esc(email)}</strong> (verified by Google).</p>
      <label class="field"><span>I am a…</span>
        <div class="seg"><button type="button" data-otype="rower" class="on">Rower</button><button type="button" data-otype="coach">Coach</button></div></label>
      <label class="field"><span>Display name</span><input id="oName" value="${esc(suggestedName || '')}"></label>
      <div class="toggle"><div><strong>Contribute my workout and wellness data to research</strong>
        <p class="muted small">Pseudonymized; opt out anytime in Settings with zero effect on features.</p></div>
        <label class="switch"><input type="checkbox" id="oResearch" checked><span class="sl"></span></label></div>
      <button id="oCreate" style="width:100%">Create account</button>
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

  /* ---------------- wiring ---------------- */

  function wire() {
    el.querySelector('#swap')?.addEventListener('click', (e) => { e.preventDefault(); mode = mode === 'login' ? 'signup' : 'login'; step = 1; draw(); });
    el.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { data.accountType = b.dataset.type; draw(); });
    mountGoogleButton();

    el.querySelector('#appleBtn')?.addEventListener('click', async () => {
      try { await api('/auth/oauth/apple', { method: 'POST', body: { idToken: 'unavailable' } }); }
      catch (e) { toast(e.message, 'error', 6000); }
    });

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

    el.querySelector('#next1')?.addEventListener('click', () => {
      Object.assign(data, { displayName: val('#displayName'), email: val('#email'), password: val('#password'), teamCode: val('#teamCode') });
      if (!data.displayName || !data.email || (data.password || '').length < 8) { toast('Fill in name, email, and a password of at least 8 characters.', 'error'); return; }
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
        if (res.joinedTeam) toast(`You'll join ${res.joinedTeam.name} once verified.`, 'success');
        showVerify(res.email, res.devCode);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function showVerify(email, devCode) {
    el.innerHTML = `<div class="auth-wrap"><div class="card">
      <h2>Verify your email</h2>
      <p class="muted">We sent a 6-digit verification code to <strong>${esc(email)}</strong>. You'll need it to enter RowPoint — accounts can't be used until the email is confirmed.</p>
      ${devCode ? `<div class="notice mb"><strong>Development mode:</strong> no email service is configured on this server, so here's your code directly: <strong style="font-size:1.3rem;letter-spacing:3px">${esc(devCode)}</strong><br><span class="muted small">On a real deployment, set RESEND_API_KEY and this code arrives by email instead.</span></div>` : ''}
      <label class="field"><span>Verification code</span><input id="code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></label>
      <button id="verifyBtn" style="width:100%">Verify & enter</button>
      <div class="row mt center">
        <button class="ghost sm" id="resend">Resend code</button>
        <button class="ghost sm" id="backToLogin">Back to sign in</button>
      </div>
    </div></div>`;
    el.querySelector('#verifyBtn').onclick = async () => {
      try {
        const res = await api('/auth/verify', { method: 'POST', body: { email, code: val('#code') } });
        finish(res, 'Email verified — welcome to RowPoint!');
      } catch (e) { toast(e.message, 'error'); }
    };
    el.querySelector('#resend').onclick = async () => {
      const r = await api('/auth/resend-verification', { method: 'POST', body: { email } });
      toast('Code re-sent.');
      if (r.devCode) showVerify(email, r.devCode);
    };
    el.querySelector('#backToLogin').onclick = () => { mode = 'login'; step = 1; draw(); };
  }

  function finish(res, msg) {
    setSession(res.token, res.user);
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
