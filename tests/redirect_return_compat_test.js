// Повернення з ЕСОЗ через наш хост (/ehealth/return/<ціль>) має працювати з обома версіями
// redirect-ehealth.js: розгорнутою на simplex-med.com (знімок у fixtures, знає лише my-dev) і новою з deploy/.
// Запуск: node pis/tests/redirect_return_compat_test.js
const fs = require('fs');
const path = require('path');
const scripts = {
  live: path.join(__dirname, 'fixtures', 'redirect-ehealth.live-2026-09-13.js'),
  new: path.join(__dirname, '..', 'deploy', 'redirect-ehealth.js'),
};
// state, які формує BFF (app.py get_auth_url), і де має опинитися браузер
const cases = [
  ['my-dev|/|n1', 'https://my-dev.simplex-med.com/?code=C1&state='],
  ['my-dev|/ehealth/return/my|n1', 'https://my-dev.simplex-med.com/ehealth/return/my?code=C1&state='],
  ['my-dev|/ehealth/return/app|1791025714.Ab-_c.0123abcd', 'https://my-dev.simplex-med.com/ehealth/return/app?code=C1&state='],
];
let fail = 0;
for (const [name, file] of Object.entries(scripts)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const [state, expected] of cases) {
    const loc = { search: '?code=C1&state=' + encodeURIComponent(state), href: '' };
    new Function('window', 'URLSearchParams', 'console', src)({ location: loc, document: { body: {} } }, URLSearchParams, console);
    const back = new URL(loc.href).searchParams.get('state');
    const ok = loc.href.startsWith(expected) && back === state;
    if (!ok) fail++;
    console.log(ok ? 'OK  ' : 'FAIL', name.padEnd(4), state, '->', loc.href);
  }
}
process.exit(fail);
