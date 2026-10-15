/**
 * SimplexMed — єдиний шлюз повернення з авторизації eHealth (ЕСОЗ).
 * Розміщується на https://simplex-med.com/js/redirect-ehealth.js (зареєстрований redirect_uri: https://simplex-med.com).
 *
 * Працює для МІС (лікарі, персонал, адміністратори) і для ПІС (пацієнти, наказ НСЗУ № 978).
 *
 * ЕСОЗ повертає користувача на https://simplex-med.com/?code=...&state=... або, у разі помилки,
 * ?error=...&error_description=...&state=... Скрипт читає state і переадресовує на потрібний сервіс,
 * передаючи туди code або error разом зі state.
 *
 * Формат state: "<середовище>|<шлях>|<одноразове значення>"
 *   my-dev|/|nonce            -> https://my-dev.simplex-med.com/?code=...
 *   my|/ehealth/return/my|n   -> https://my.simplex-med.com/ehealth/return/my?code=...
 *   app2-dev|/auth/callback|n -> https://app2-dev.simplex-med.com/auth/callback?code=...
 *   pis-app|/|n               -> simplexpis://auth/callback?code=... (мобільний застосунок ПІС)
 *
 * Безпека:
 *  - ціль визначається лише за списком TARGETS; невідоме середовище — зупинка без переадресації;
 *  - шлях зі state приймається тільки відносний ("/abc/def"): без "//", "@", "\", "..", ":" — інакше state
 *    на кшталт "my|.evil.com/" відправив би код авторизації пацієнта на сторонній хост (open redirect);
 *  - code і state передаються лише в запиті до цілі з цього списку.
 */
(function () {
  'use strict';

  // середовище -> [базова адреса, шлях за замовчуванням]
  var TARGETS = {
    // ПІС (кабінет пацієнта)
    'my': ['https://my.simplex-med.com', '/'],
    'pis': ['https://my.simplex-med.com', '/'],
    'prod': ['https://my.simplex-med.com', '/'],
    'my-dev': ['https://my-dev.simplex-med.com', '/'],
    'pis-dev': ['https://my-dev.simplex-med.com', '/'],
    // мобільний застосунок ПІС: фіксована адреса, шлях зі state не використовується
    'pis-app': ['simplexpis://auth', '/callback', true],
    // МІС SimplexMed 2.0
    'app2-dev': ['https://app2-dev.simplex-med.com', '/auth/callback'],
    'app2-admin-dev': ['https://app2-admin-dev.simplex-med.com', '/auth/callback'],
    'app2': ['https://app2.simplex-med.com', '/auth/callback'],
    'app2-prod': ['https://app2.simplex-med.com', '/auth/callback'],
    // попередній кабінет
    'cabinet-dev': ['https://cabinet-dev.simplex-med.com', '/dashboard'],
    'cabinet-test': ['https://cabinet-test.simplex-med.com', '/dashboard'],
    'cabinet': ['https://cabinet.simplex-med.com', '/dashboard']
  };
  var LEGACY_DEFAULT = ['https://app2-dev.simplex-med.com', '/auth/callback']; // виклики без state (старі МІС-потоки)
  var SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~\/]*$/;

  function show(title, text) {
    var document = window.document;
    if (!document || !document.body || !document.createElement) return;
    var box = document.createElement('div');
    box.style.cssText = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:80px auto;' +
      'padding:30px;text-align:center;border-radius:12px;background:#fff;border:1px solid #e2e8f0;';
    var h = document.createElement('h3');
    h.style.cssText = 'margin:0 0 8px;color:#0f172a;font-size:20px;';
    h.textContent = title;
    var p = document.createElement('p');
    p.style.cssText = 'margin:0;color:#64748b;font-size:14px;';
    p.textContent = text;
    box.appendChild(h);
    box.appendChild(p);
    document.body.textContent = '';
    document.body.appendChild(box);
  }

  try {
    var params = new URLSearchParams(window.location.search);
    var code = params.get('code');
    var error = params.get('error');
    var state = params.get('state');
    if (!code && !error) return;

    var target = LEGACY_DEFAULT;
    var fixed = false;
    var path = null;
    if (state) {
      var parts = state.split('|');
      target = TARGETS[Object.prototype.hasOwnProperty.call(TARGETS, parts[0]) ? parts[0] : ''];
      if (!target) {
        show('Невідоме середовище', 'Не вдалося визначити, куди повернути вас після авторизації. Поверніться до застосунку і почніть вхід ще раз.');
        return;
      }
      fixed = target[2] === true;
      if (!fixed && parts[1] && SAFE_PATH.test(parts[1]) && parts[1].indexOf('..') === -1) path = parts[1];
    }

    var query = code
      ? 'code=' + encodeURIComponent(code)
      : 'error=' + encodeURIComponent(error) + '&error_description=' + encodeURIComponent(params.get('error_description') || '');
    if (state) query += '&state=' + encodeURIComponent(state);
    if (!code && params.get('request_id')) query += '&request_id=' + encodeURIComponent(params.get('request_id'));

    if (code) show('Авторизацію в ЕСОЗ завершено', 'Переходимо до кабінету SimplexMed...');
    else show('Авторизацію в ЕСОЗ не завершено', 'Повертаємо вас назад, щоб показати причину і повторити вхід...');
    window.location.href = target[0] + (path || target[1]) + '?' + query;
  } catch (exception) {
    if (window.console) console.error('SimplexMed redirect error:', exception);
  }
})();
