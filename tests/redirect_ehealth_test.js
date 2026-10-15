// Перевірка pis/deploy/redirect-ehealth.js: код авторизації не може піти на чужий хост.
// Запуск: node pis/tests/redirect_ehealth_test.js [шлях до скрипта]
const fs=require('fs');
const path=require('path');
const src=fs.readFileSync(process.argv[2]||path.join(__dirname,'..','deploy','redirect-ehealth.js'),'utf8');
const cases=[
 ['my-dev|/|abc','https://my-dev.simplex-med.com/?'],
 ['my|/|abc','https://my.simplex-med.com/?'],
 ['app2-dev|/auth/callback','https://app2-dev.simplex-med.com/auth/callback?'],
 ['my|.evil.com/','https://my.simplex-med.com/?'],
 ['my|@evil.com/','https://my.simplex-med.com/?'],
 ['my|//evil.com','https://my.simplex-med.com/?'],
 ['zzz|.evil.com',''],            // невідоме середовище: переадресації немає
 ['my|/a/../b|n','https://my.simplex-med.com/?'],
 ['localhost|/|n',''],             // локальну адресу в робочому скрипті не підтримуємо
 ['pis-app|/|n1','simplexpis://auth/callback?'],
 ['pis-app|//evil.com|n1','simplexpis://auth/callback?'],
];
let fail=0;
for (const [st,exp] of cases){
  const loc={search:'?code=C1&state='+encodeURIComponent(st), href:''};
  const window={location:loc,document:{body:{}}};
  new Function('window','URLSearchParams','console',src)(window,URLSearchParams,console);
  const ok=exp===''?loc.href==='':(loc.href.startsWith(exp) && (new URL(loc.href).protocol==='simplexpis:' || new URL(loc.href).host.endsWith('simplex-med.com')));
  if(!ok) fail++;
  console.log(ok?'OK  ':'FAIL',st,'->',loc.href);
}
// помилка сервісу авторизації повертається до клієнта
{
  const loc={search:'?error=access_denied&error_description=User%20denied&state='+encodeURIComponent('pis-app|/|n1'), href:''};
  new Function('window','URLSearchParams','console',src)({location:loc,document:{body:{}}},URLSearchParams,console);
  const ok=loc.href.startsWith('simplexpis://auth/callback?error=access_denied&error_description=User%20denied');
  if(!ok) fail++;
  console.log(ok?'OK  ':'FAIL','error ->',loc.href);
}
process.exit(fail);
