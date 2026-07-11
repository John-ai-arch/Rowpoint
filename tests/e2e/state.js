// Shared Playwright storage state: pre-seeds the language choice so tests
// land on the login form instead of the first-run language chooser (a real
// user picks a language once; the specs assert everything past that point).
export const englishState = {
  cookies: [],
  origins: [{
    origin: 'http://localhost:4381',
    localStorage: [{ name: 'rp_locale', value: 'en' }],
  }],
};
