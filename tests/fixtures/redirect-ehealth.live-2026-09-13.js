(function() {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (code) {
      // За замовчуванням завжди перенаправляємо на наш портал SimplexMed 2.0
      let targetDomain = 'https://app2-dev.simplex-med.com';
      let path = '/auth/callback';

      if (state) {
        const parts = state.split('|');
        const env = parts[0]; 
        const customPath = parts[1] || '/dashboard';
        
        if (env === 'localhost') targetDomain = 'http://localhost:5173';
        else if (env === 'cabinet-dev') targetDomain = 'https://cabinet-dev.simplex-med.com';
        else if (env === 'cabinet-test') targetDomain = 'https://cabinet-test.simplex-med.com';
        else if (env === 'cabinet') targetDomain = 'https://cabinet.simplex-med.com';
        else if (env === 'app2-dev') targetDomain = 'https://app2-dev.simplex-med.com';
        else if (env === 'app2-admin-dev') targetDomain = 'https://app2-admin-dev.simplex-med.com';
        else if (env === 'my-dev') targetDomain = 'https://my-dev.simplex-med.com';

        path = customPath;
      }

      // Показуємо індикатор переходу на випадок повільного з'єднання
      if (window.document && window.document.body) {
        window.document.body.innerHTML = 
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:80px auto;padding:30px;text-align:center;border-radius:12px;background:#ffffff;box-shadow:0 8px 24px rgba(0,0,0,0.06);border:1px solid #e2e8f0;">' +
            '<div style="font-size:36px;margin-bottom:12px;">🏥</div>' +
            '<h3 style="margin:0 0 8px;color:#0f172a;font-size:20px;">Авторизація в eHealth успішна</h3>' +
            '<p style="margin:0;color:#64748b;font-size:14px;">Переходимо до робочого кабінету SimplexMed...</p>' +
          '</div>';
      }

      // Миттєвий редирект до кабінету
      const redirectUrl = targetDomain + path + '?code=' + encodeURIComponent(code) + (state ? '&state=' + encodeURIComponent(state) : '');
      window.location.href = redirectUrl;
    }
  } catch (exception) {
    console.error('SimplexMed redirect error:', exception);
  }
})();