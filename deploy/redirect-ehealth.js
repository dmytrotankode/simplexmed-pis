/**
 * SimplexMed — Єдиний шлюз обробки OAuth редиректів eHealth
 * Розміщується на https://simplex-med.com/js/redirect-ehealth.js
 * 
 * Працює як для МІС (лікарі, персонал, адміністратори),
 * так і для ПІС (пацієнти, Наказ НСЗУ № 978).
 * 
 * Параметр state приймає формат: "<env>|<customPath>"
 * Приклади state:
 *  - "app2-dev|/auth/callback"     -> https://app2-dev.simplex-med.com/auth/callback
 *  - "app2|/auth/callback"         -> https://app2.simplex-med.com/auth/callback
 *  - "my-dev|/"                    -> https://my-dev.simplex-med.com/
 *  - "my|/"                        -> https://my.simplex-med.com/
 *  - "pis|/"                       -> https://my.simplex-med.com/
 *  - "pis-app|/|<nonce>"           -> simplexpis://auth/callback (мобільний застосунок ПІС)
 *
 * Помилки сервісу авторизації (?error=...&error_description=...) повертаються за тими ж правилами.
 */
(function() {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');

    if (code || error) {
      // Базові значення за замовчуванням
      let targetDomain = 'https://app2-dev.simplex-med.com';
      let path = '/auth/callback';

      if (state) {
        const parts = state.split('|');
        const env = parts[0];
        // Шлях дописується одразу після домену, тому дозволяємо лише відносний шлях.
        // Інакше state на кшталт "my|.evil.com/" або "my|@evil.com/" відправив би
        // код авторизації пацієнта на сторонній хост.
        const rawPath = parts[1];
        const customPath = (rawPath && /^\/(?!\/)[A-Za-z0-9\-._~\/]*$/.test(rawPath)) ? rawPath : null;
        
        // 1. Локальна розробка
        if (env === 'localhost') {
          targetDomain = 'http://localhost:5173';
          path = customPath || '/dashboard';
        }
        // 2. Старий кабінет (legacy)
        else if (env === 'cabinet-dev') {
          targetDomain = 'https://cabinet-dev.simplex-med.com';
          path = customPath || '/dashboard';
        }
        else if (env === 'cabinet-test') {
          targetDomain = 'https://cabinet-test.simplex-med.com';
          path = customPath || '/dashboard';
        }
        else if (env === 'cabinet') {
          targetDomain = 'https://cabinet.simplex-med.com';
          path = customPath || '/dashboard';
        }
        // 3. МІС SimplexMed 2.0 (лікарі, реєстратура, адміністрація)
        else if (env === 'app2-dev') {
          targetDomain = 'https://app2-dev.simplex-med.com';
          path = customPath || '/auth/callback';
        }
        else if (env === 'app2-admin-dev') {
          targetDomain = 'https://app2-admin-dev.simplex-med.com';
          path = customPath || '/auth/callback';
        }
        else if (env === 'app2' || env === 'app2-prod') {
          targetDomain = 'https://app2.simplex-med.com';
          path = customPath || '/auth/callback';
        }
        // 4. ПІС SimplexMed 2.0 (Кабінет пацієнта)
        else if (env === 'pis-app') {
          // Мобільний застосунок: фіксована схема, шлях зі state не використовується
          targetDomain = 'simplexpis://auth';
          path = '/callback';
        }
        else if (env === 'my' || env === 'prod' || env === 'pis') {
          targetDomain = 'https://my.simplex-med.com';
          path = customPath || '/';
        }
        else if (env === 'my-dev' || env === 'pis-dev') {
          targetDomain = 'https://my-dev.simplex-med.com';
          path = customPath || '/';
        }
        else {
          path = customPath || (env.startsWith('my') ? '/' : '/dashboard');
        }
      }

      // Показуємо плашку редиректу для зручності користувача
      if (window.document && window.document.body) {
        window.document.body.innerHTML = 
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:80px auto;padding:30px;text-align:center;border-radius:12px;background:#ffffff;box-shadow:0 8px 24px rgba(0,0,0,0.06);border:1px solid #e2e8f0;">' +
            '<div style="font-size:36px;margin-bottom:12px;">🏥</div>' +
            '<h3 style="margin:0 0 8px;color:#0f172a;font-size:20px;">Авторизація в eHealth успішна</h3>' +
            '<p style="margin:0;color:#64748b;font-size:14px;">Переходимо до робочого кабінету SimplexMed...</p>' +
          '</div>';
      }

      // Миттєвий редирект до відповідного кабінету (код або помилка сервісу авторизації)
      const query = code
        ? 'code=' + encodeURIComponent(code)
        : 'error=' + encodeURIComponent(error) + '&error_description=' + encodeURIComponent(params.get('error_description') || '');
      const redirectUrl = targetDomain + path + '?' + query + (state ? '&state=' + encodeURIComponent(state) : '');
      window.location.href = redirectUrl;
    }
  } catch (exception) {
    console.error('SimplexMed redirect error:', exception);
  }
})();
