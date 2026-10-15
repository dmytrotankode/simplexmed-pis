# 06. Клієнтські застосунки MedOne vs «Плексі»

Дата аналізу: 15.10.2026. Джерела MedOne (лише читання): `apps/web`, `apps/mobile`, `packages/{i18n,core,ui-tokens,api-client,tester-dsl}`, `e2e`, `docs/dodatok1-coverage.md`, `docs/tv-texts.json`, `apps/web/TESTER-MODE.md`, `infra/server/build-android-apk.sh`. Плексі: `pis/web/index.html`, `pis/web/kep.js`, `pis/mobile/app/{app.json,eas.json,src}`, `pis/docs/compliance_matrix.md`, `pis/backend/app.py`.
Нічого не запускалося; файли з обліковими даними не відкривалися.

## 0. Головний висновок

1. MedOne не є «старшим братом» за повнотою клієнтів ПІС. Його **мобільний застосунок тонкий**: вхід лише за OTP, екрани «Сьогодні / Запис / Медкарта / Аптека / Профіль» читають дані платформи, а всі дії ЕСОЗ (вхід за КЕП, підпис, декларація, зміна даних, методи автентифікації, доступи застосунків) «завершуються в браузері» (`Linking.openURL(webUrl(...))`). README MedOne прямо каже: КЕП, step-up, видалення акаунта, `minAppVersion`, certificate pinning, push — не реалізовано. Плексі вже має це все нативно в Android (КЕП через WebView, декларації, методи входу, доступи, запити на зміну даних, видалення акаунта, deep link `+native-intent`).
2. MedOne сильніший у **веб-кабінеті** (Next.js: повний CSP, step-up L0/L1/L2, журнал доступів, версійовані юридичні документи, «оновити дозвіл», облік стану ключа КЕП, хмарні КЕП/Дія.Підпис, очищення друкованої форми) і в **інженерії навколо клієнтів** (Playwright e2e, локалізація uk/en з паритетом ключів, тест-збірка зі знімками екрана з перевіркою, режим тестувальника, золотий файл текстів ТВ).
3. За ТВ ПІС №978 (за `compliance_matrix.md` Плексі: усе ✅, окрім сервера п.1.3.4) **у MedOne немає пунктів, закритих у клієнтах, які не закриті в Плексі**. Є пункти, закриті глибше (див. розд. 6).
4. Найцінніше для перенесення: безпека локального сховища мобільного (PBKDF2, порядок виходу, мітка створення PIN), повний CSP у вебі, обробка «бракує скоупа в дозволі» (403 Missing allowances), автотести клієнтів (Playwright, golden-файл текстів ТВ).

## 1. Екрани і потоки MedOne

### 1.1 Веб (`apps/web`, Next.js, маршрути в `app/`)

| Група | Маршрут / компонент | Що робить |
|---|---|---|
| Вхід | `/login` (`LoginForm`, `KepLogin`, `KepWidget`, `LegalGate`) | Вкладки: OTP (SMS / Viber, `OtpInput`), КЕП, id.gov.ua. Перед входом екран згоди (`LegalGate`): політика, умови, обробка health-даних, окремий чекбокс і «Прийняти і продовжити», `SaveTxtButton` (.txt). Версії прийнятих документів пишуться в акаунт (`ConsentSync`, `POST /me/consents`) |
| Вхід за КЕП | `KepLogin`, `lib/kep/{engine,flow,keystore,signing-config}.ts` | Бібліотека ІІТ EUSign у воркері (`public/lib/euscp`), файловий ключ (.dat/.pfx/.p12/.zs2), JKS, хмарні КЕП (KSP), Дія.Підпис (QR і посилання підтвердження), альтернативний рушій `iit-widget`; nonce -> підпис -> Auth UI ЕСОЗ з PKCE (`verifier` у sessionStorage, 15 хв); `mode: sign_in / sign_up` |
| Повернення з ЕСОЗ | `/login/ehealth` (`EhealthReturn`) | `POST /auth/ehealth/complete`; статуси `ok / pending / not_registered / error`; точний текст Додатка 1 з `dodatok1` + посилання підтримки НСЗУ |
| Прив'язка телефону | `/login/link-phone` | Вхід за сертифікатом без телефону акаунта |
| Реєстрація в ЕСОЗ | `/ehealth/register` (`RegisterForm`, `lib/ehealth/signup*.ts`, `email-domains.ts`) | Форма, серверна валідація (`/ehealth/sign-up/prepare`), підпис КЕП, `validate` (sign-up_validation) до переходу в Auth UI; помилки біля полів; блок поштових доменів |
| Профіль / дані ЕСОЗ | `/profile` (`EhealthStatusCard`, `EhealthDetails`, `EhealthPerson`, `EhealthVerificationLine`, `EhealthSmsHint`, `EhealthOffer`) | Статус підключення, особа, верифікація, відкриті запити |
| Дії ЕСОЗ | `EhealthActions.tsx` (1507 рядків) | `DeclarationChoose`, `DeclarationRequestActions` (продовжити/скасувати), `DeclarationTerminate`, `AppRevoke`, `EhealthDisconnect`, `AuthPhoneChange` (створення OTP-методу, повторна відправка коду), `AuthMethodActions` (перейменування, вимкнення THIRD_PERSON), `PersonDataChange`, `PersonRequestActions`, `ReapprovalNotice` |
| Підпис | `KepSignPanel`, `StepUp` | Підпис КЕП / Дія; step-up (`/auth/step-up/otp/*`, рівні L0/L1/L2, «сильний» step-up лише КЕП/Дія для записів у ЕСОЗ), `markResume/takeResume` повертає на дію після КЕП |
| Друкована форма | `EhealthPrintout`, `lib/ehealth-printout.ts` | Очищення HTML ЕСОЗ за allowlist (див. 3.4), показ у sandbox, друк «Зберегти як PDF» у браузері |
| Довіра і згоди | `TrustSection`, `ConsentsSection`, `AccessLogSection`, `FamilyList` | Рівень довіри, згоди, журнал доступів до даних, профілі родини |
| Інше | `/booking`, `/pharmacy/*`, `/visits`, `/record` | Запис, аптека, візити, медкарта: **поза ПІС-вимогами**, переносу не потребують |
| Політика | `/legal`, `/legal/[type]` | Версійовані документи uk/en; доступні до входу (matcher у `proxy.ts`) |
| Режим тестувальника | `/tester` (`page.tester.tsx`) | Лише за `NEXT_PUBLIC_TESTER_MODE=1` (див. розд. 5) |

Захист маршрутів: `proxy.ts` (Next 16) перевіряє сесію через `GET /api/v1/me` на кожен захищений маршрут, таймаут 4 с, недоступність платформи = на вхід.

### 1.2 Мобільний (`apps/mobile`, Expo SDK 57, expo-router)

| Екран | Файл | Що робить |
|---|---|---|
| Вхід | `app/login.tsx` | Телефон + OTP (кабінет MedOne), створення PIN (6 цифр), біометрія за бажанням |
| Вкладки | `app/(tabs)/{index,booking,record,pharmacy,profile}.tsx` | Читання даних платформи; вибір лікаря, скасування, КЕП, підключення eHealth, згоди — відкривають веб-кабінет у браузері |
| Блокування | `src/security/{AppLock,LockScreens,lockPolicy,pinVault,secureScreen}` | PIN / біометрія, 5 хв, холодний старт, 5 помилок |
| Токени | `src/auth/{tokenStore,sessionFlow,session,unauthorizedPolicy}` | SecureStore, refresh, відкликання сесії |

Не має: КЕП, реєстрації, декларацій, методів автентифікації, доступів застосунків, зміни даних, політики конфіденційності як окремого екрана, видалення акаунта.

## 2. Безпека: як зроблено в MedOne і що в Плексі

| Тема | MedOne | Плексі (стан) | Висновок |
|---|---|---|---|
| Токени (web) | HttpOnly cookie `medone_session`, same-origin BFF через rewrites | HttpOnly+Secure+SameSite=Strict, токени ЕСОЗ лише на BFF | Паритет |
| Токени (mobile) | SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, `allowBackup=false`; refresh стирає сесію лише на 401/403, мережа/5xx/429 сесію не стирають (`isAuthRejection`) | Те саме сховище й опції (`lib/secure.ts`); один токен сесії кабінету, без refresh на пристрої | Паритет; нюанс помилок мережі в Плексі вже врахований у `handleApiError` лише для `unauthorized` |
| Хеш PIN | PBKDF2-SHA256, 30 000 ітерацій, сіль 16 байт, кількість ітерацій у записі (міграція), `@noble/hashes` | 1000 послідовних SHA-256 через `digestStringAsync` (`lib/pin.ts`), PIN 4–6 цифр | **MedOne краще** |
| Лічильник спроб | Пишеться ДО перевірки; 5-та спроба стирає токени, потім PIN | Те саме (`verifyPin`), плюс добудова стирання при перерваному стиранні | Паритет |
| Порядок виходу | Локально першим: знімок токенів -> стерти токени -> стерти PIN -> фонове відкликання на сервері (10 с на запит, refresh якщо access прострочено) | `signOut` спершу `await logoutOnServer` (до 90 с), потім `wipeLocal` | **MedOne краще**: примусове закриття у вікні очікування лишає сесію |
| Створення PIN | Мітка «setupPending» лише в пам'яті процесу; токени без PIN і без мітки = нова автентифікація (`reauth`) | `statusOnStart`: сесія без PIN -> `needsPin` (можна поставити власний PIN під чужою сесією після переривання) | **MedOne краще** |
| Слабкий PIN | Відхиляє 111111 / 123456 / 654321 | Відхиляє лише невалідний формат | MedOne краще (поза ТВ) |
| Годинник назад | `isLockDue`: різниця < 0 = блокувати | `isInactive`: різниця < 0 = не блокувати | MedOne краще (S) |
| 5 хв бездіяльності | Мітка часу останньої взаємодії, перевірка кожні 5 с і при поверненні з фону | Те саме, тік 15 с, `onTouchStart` | Паритет |
| FLAG_SECURE | `expo-screen-capture`, лічильник утримувачів, захист весь час сесії; екрану-заставки на iOS; `blockedPermissions` містить `DETECT_SCREEN_CAPTURE` | `usePreventScreenCapture` у `_layout` (завжди, крім збірки зі скріншотами), `SecureModal` | Паритет |
| Вміст під блокуванням | `contentGate`: екрани не монтуються, поки заблоковано; у фоні сховані від TalkBack/VoiceOver | Екрани змонтовані під `LockOverlay`, сховані (`no-hide-descendants`, `accessibilityElementsHidden`) | MedOne трохи краще (дані не в дереві) |
| Збірка зі скріншотами | `EXPO_PUBLIC_ALLOW_SCREENSHOTS=1`; літерал-мітка згортається Hermes і шукається скриптом збірки у JS-пакеті публічного APK | Та сама змінна (`config.ts`), перевірки пакета немає | **MedOne краще** (автоконтроль) |
| Root / jailbreak | Не реалізовано | Не реалізовано | Нічого переносити; ТВ не вимагає |
| Certificate pinning | Не реалізовано (README) | Не реалізовано | Паритет |
| Deep links | Схема `medone`, відкриває лише веб-URL; власних маршрутів авторизації немає | `simplexpis://auth/callback` через `+native-intent` + PKCE+HMAC state, жоден екран до PIN | **Плексі краще** |
| Cleartext | `expo-build-properties` -> `usesCleartextTraffic: false` | Не задано в `app.json` | MedOne краще (S) |
| CSP / заголовки (web) | Повний CSP (script/connect/img/frame/worker-src, `frame-ancestors`, `object-src`, `base-uri`, `form-action`), COOP, HSTS preload, Permissions-Policy | `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'` (`app.py:148`), matrix сама визнає відсутність CSP за скриптами | **MedOne краще** |
| Ключ КЕП | Лише в пам'яті вкладки (модульна змінна), `pagehide` і вихід знищують воркер; можна підписати реєстрацію без повторного введення ключа | Читається на кожен підпис (`Kep.sign`), нічого не тримається | Інший компроміс (див. P2) |
| Step-up | L0/L1/L2, OTP step-up, «сильний» тільки КЕП/Дія для записів у ЕСОЗ, 403 `step_up_required` розбирається клієнтом | Не потрібно: запис у ЕСОЗ у Плексі завжди через КЕП-підпис | Не переносити |

## 3. Інше: доступність, i18n, тест-режим, збірки, e2e

### 3.1 Доступність (WCAG)

| Що | MedOne | Плексі |
|---|---|---|
| `prefers-reduced-motion` | Так (`globals.css`: аврора, скелетон) | Немає в `index.html` / `app.css` |
| `:focus-visible` | Глобально 2 px accent, окремо для radio/check/legal-text | Є (`index.html:57`) |
| Діалоги | `Sheet`: `role=dialog`, `aria-modal`, `aria-labelledby`, `tabIndex=-1` | `initA11y`: `aria-modal`, пастка фокуса, Esc |
| Живі області | `role=status`/`alert` у `LegalGate`, `aria-busy` | `role=status aria-live=polite` на сповіщеннях |
| Skip-link «до змісту» | Немає (grep не знайшов) | Немає |
| Мобільний | 447 `aria-*`/`role` у web; mobile: `accessibilityViewIsModal`, hide під блокуванням | 80 `accessibilityRole/Label`, `accessibilityViewIsModal` в `LockOverlay`, цілі ≥ 44 |
| Тема | `ThemeToggle`, `prefers-color-scheme` | Системна тема + `theme-color` |

Висновок: суттєвих переваг у MedOne немає, крім `prefers-reduced-motion` (S). Обидва без skip-link. Окремого аудиту WCAG чи автотестів доступності (axe) у MedOne теж немає.

### 3.2 i18n

`packages/i18n`: `uk.json` і `en.json` по 1175 ключів (паритет), `t(locale, key, params)` з фолбеком uk, тип `MessageKey` не дає звернутися до неіснуючого ключа, `errorMessage` за `Problem.code` (`error.<code>`), окремі словники `tester.*`, `admin-tester.*` НЕ зливаються із загальним. Контекст локалі `lib/locale-context.tsx`, мова з cookie/заголовка на сервері. У мобільному `locale: "uk"` зашито.
Плексі: усі рядки українською в розмітці (`index.html`, `.tsx`). ТВ 1.5.1 вимагає українську, англійська не обов'язкова.

### 3.3 Режим тестувальника

Не клієнтська функція ТВ №978, а власна вимога MedOne (ТЗ розд. 9, FR-TST): вікно «Тестування» з деревом вимог ТВ (`docs/tv-pis-tree.json`), дослівним текстом, «Як перевірити», прив'язаними автотестами, ручними доказами, зауваженнями комісії, ролями `owner / internal_qa / dp_commission / auditor`, демонстраціями (фейковий світ, оверлей).
Ізоляція від production: розширення сторінки `tester.tsx` додається в `pageExtensions` лише при `NEXT_PUBLIC_TESTER_MODE=1`; без прапорця `TesterNavItem` і `TesterDemoMount` підмінюються заглушками на етапі збірки, `data-demo*` прибираються компілятором, `scripts/check-no-tester.mjs` після збірки шукає сліди (`me/tester`, `mo-tst`) і зупиняє деплой; `lib/tester/isolation.test.ts` тримає межу в коді. У мобільному режиму тестувальника немає.
Плексі: окремого режиму немає, тестувальнику даються `compliance_matrix.md` («Навігація для тестувальника») і `docs/submission/user_guide`.

### 3.4 Друкована форма ЕСОЗ

`lib/ehealth-printout.ts`: allowlist елементів і атрибутів замість blacklist, відкидає скрипти/форми/фрейми/svg/зовнішні ресурси/`position: fixed`, `data:image` лише растрові, ліміт 1 000 000 знаків, звіт про прибране (`PrintoutReport`), політика CSP у самому файлі (`default-src 'none'; img-src data:`), PDF — друк браузера без передачі на сервер. Тести `ehealth-printout.test.ts`, `e2e/tests/printout.spec.ts` + `e2e/fixtures/ehealth-declaration-printout.html`.
Плексі: iframe `sandbox` + `html2canvas`/`jsPDF` з CDN (SRI), на мобільному `WebView` з `javaScriptEnabled={false}`. Працює, але форму ЕСОЗ не фільтрують, контент може підтягнути зовнішні картинки/стилі.

### 3.5 Збірки та публікація

| Що | MedOne | Плексі |
|---|---|---|
| Профілі EAS | `development / preview / production / huawei` (`MEDONE_ENV`, `MEDONE_PUSH_PROVIDER=hms`), `submit.production` порожній | `development / preview / production / production-huawei` (`PIS_STORE=huawei`) |
| iOS | `bundleIdentifier`, `supportsTablet`, `ITSAppUsesNonExemptEncryption: false`, Face ID текст | `bundleIdentifier`, iOS не подається на тестування; `ITSAppUsesNonExemptEncryption` не задано |
| Android | `package`, `versionCode`, `allowBackup=false`, `blockedPermissions` (READ/WRITE_EXTERNAL_STORAGE, SYSTEM_ALERT_WINDOW, READ_MEDIA_IMAGES, DETECT_SCREEN_CAPTURE) | `package`, `allowBackup=false`, `blockedPermissions` (SYSTEM_ALERT_WINDOW, READ/WRITE_EXTERNAL_STORAGE, VIBRATE) |
| Підпис | Config-plugin `withReleaseSigning.js` (ключ із env Gradle, у проєкті не лежить), STAGING-ключ окремо від ключа магазину, роздача `*.apk` + `.sha256` | EAS-керований ключ (без плагіна) |
| Huawei | Лише flavor: `MEDONE_PUSH_PROVIDER=hms`, HMS-плагін «не зроблено» | `production-huawei` (APK, `PIS_STORE=huawei`); push не потрібен |
| Іконка/splash | Placeholder (README) | Є (`assets`, adaptive icon, dark splash) |
| EAS projectId | Заглушка `0000…` | У `app.json` відсутній (треба `eas init`) |
| Папка `docs/store` | Відсутня (є `docs/legal`, `docs/ehealth-verification-guide.md`, `docs/ehealth-signing-checklist.md`) | `docs/submission` (user_guide.pdf, README) |
| Автодеплой | `infra/server/{deploy,autodeploy,build-android-apk}.sh`, перевірка опублікованого APK (`verify`), блокування публічного імені для збірки зі скріншотами | `deploy/deploy.sh`, `deploy-pm2.sh`, nginx-конфіги |

### 3.6 e2e та автотести

| Що | MedOne | Плексі |
|---|---|---|
| Browser e2e | Playwright (`e2e/`): `smoke.spec.ts` (лендинг, логін, OTP на staging без помилок консолі), `printout.spec.ts` (проти заглушки платформи `stub-platform.mjs`), `screenshots*.spec.ts` (скріншоти для ТЗ з вигаданих даних, `run-screenshots.sh`) | Немає для веб-кабінету |
| Юніт web | `node:test` по `lib/*` (тесту `lib/tv-texts.test.ts`, `ehealth-*.test.ts`, `kep/signing.test.ts`, `tester/*`) | Немає для `index.html` |
| Юніт mobile | `node --test`: `lockPolicy`, `pinVault`, `secureScreenCounter`, `session`, `unauthorizedPolicy`, `format` | Jest: `lock`, `pin`, `auth`, `authMethods`, `declarationFlow`, `personForm`, `personRequests`, `tzCompliance` |
| Backend | .NET тести шлюзу, `Dodatok1CoverageReportTests` | `pytest`: `test_annex1`, `test_bff`, `test_phase1..3`, `test_registry`, `test_verification` |
| Звірка ТВ | `docs/tv-texts.json` (golden: дослівні тексти ТВ, плейсхолдери, directives `mustContain`) + `tv-texts.test.ts` проти `uk.json/en.json/ehealth-support.ts` | `tzCompliance.test.ts` (мобільний), `tools/check_tz_updates.py` (стан редакції ТВ) |

## 4. Що в MedOne зроблено краще і варто перенести в Плексі

Оцінка складності: S — до 1 дня, M — 2–4 дні, L — понад тиждень.

### P0

Власних блокерів ТВ ПІС у цій області не знайдено: Плексі за матрицею закриває 1.x–3.12. Нижче P1 — те, що я б зробив до подачі на тестування.

### P1

| № | Що перенести | Де в MedOne | Куди в Плексі | Чому | Склад. |
|---|---|---|---|---|---|
| P1-1 | **Обробка «бракує скоупа в дозволі застосунку»**: 403 «Missing allowances» (код `approval_scope_missing`) і `client_scope_not_allowed` розрізняються; перший веде до «Оновити дозвіл» (відкликання власного доступу -> вхід за КЕП -> повернення до профілю), другий лише пояснення «зверніться до підтримки eHealth» без марних кроків. Прочитати дозвіл застосунку (`needsReapproval`, `approvalMissingScopes`, `reapprovalFlows` по потоках) і показати попередження в картці та у вікні дії | `apps/web/lib/ehealth-reapproval.ts` (+test), `EhealthActions.tsx` `ReapprovalNotice`, `useEhealthApproval` | BFF: розбір 403 у `errors.py`/`app.py` + прапор у відповіді; `index.html`; Android `apps.tsx`, `auth-methods.tsx` | Ми вже додавали скоупи (`authentication_method:deactivate_pis`): пацієнт із старим дозволом отримає загальну помилку без шляху виправлення. Сценарій реальний на preprod/prod | M |
| P1-2 | **Повний CSP для веб-кабінету**: `default-src 'self'`, `script-src` (self + `'wasm-unsafe-eval'` + хост бібліотеки КЕП, `unsafe-inline` поки inline-код), `worker-src 'self' blob:`, `connect-src`, `img-src 'self' data: blob:`, `frame-src`, `font-src`, `style-src`; COOP `same-origin`; HSTS `preload`; `X-Content-Type-Options`; Permissions-Policy | `apps/web/next.config.ts` | `backend/app.py:146–148` (список заголовків), узгодити з `deploy/nginx_*` | Матриця п.2.3 сама пише, що CSP за скриптами немає. `index.html` має inline-обробники й CDN (Font Awesome, html2canvas, jsPDF), тож `unsafe-inline` лишається, але `connect-src`/`img-src`/`frame-src`/`object-src` вже ріжуть витік даних. Потім винести inline-код і перейти на nonce | S–M |
| P1-3 | **Порядок виходу: локальний стан першим**, відкликання на сервері у фоні з таймаутом 10 с на запит. Токен читається до стирання | `apps/mobile/src/auth/sessionFlow.ts` `endLocally`, `unauthorizedPolicy.ts` | `mobile/app/src/lib/session.tsx` `signOut` / `unlockWithPin` (wiped) / `lib/auth.ts` `logoutOnServer` | Зараз «Вийти» чекає до 90 с (`REQUEST_TIMEOUT_MS`), у цьому вікні сесія жива. ТВ 3.7.1.1 вимагає показати попередження ЕСОЗ про непрепинення токенів: його можна показати після завершення фонового запиту (ненав'язливий банер / `Alert` при повторному відкритті) | S |
| P1-4 | **Мітка «створення PIN очікується» лише в пам'яті**; сесія без PIN і без мітки = повторний вхід через ЕСОЗ | `pinVault.ts` `markSetupPending`, `lockPolicy.ts` `phaseForSession` | `lib/session.tsx` `statusOnStart`/`signIn`, `lib/lock.ts` | Закриває сценарій: застосунок убито між входом і створенням PIN -> наступний власник пристрою ставить свій PIN під чужою сесією | S |
| P1-5 | **PBKDF2-SHA256 30 000 ітерацій + запис `iter` у запису PIN** (міграція зі старих 1000 SHA-256) | `pinVault.ts` (`@noble/hashes`, `derive`, `DEFAULT_ITERATIONS`) | `mobile/app/src/lib/pin.ts` | Зараз PIN захищений 1000 послідовними SHA-256: слабкіше за PBKDF2, якщо хеш вилучать (root, бекап). Лічильник у Keystore лишається основним захистом. Додати залежність через `npx expo install` лише якщо сумісна; виміряти час на Hermes | S |
| P1-6 | **Автотести браузерного клієнта**: Playwright smoke (лендинг/логін без помилок консолі, відкриття політики, згода -> форма входу, реєстрація до підпису, друкована форма) проти заглушки BFF, + окремий `printout.spec` з фікстурою | `e2e/tests/smoke.spec.ts`, `printout.spec.ts`, `support/stub-platform.mjs`, `run-printout.sh` | Новий `pis/tests/e2e` (мова: Node) | У `index.html` на ~3200 рядків немає жодного автотесту; регрес на «редизайн Плексі» піймається тільки руками | M |
| P1-7 | **Golden-файл фіксованих текстів ТВ** (`tv-texts.json`: `verbatim`, `placeholders`, `directives.mustContain`, `support`) і тест, що звіряє з клієнтськими текстами й з `docs/tv_pis_978.txt` | `docs/tv-texts.json`, `apps/web/lib/tv-texts.test.ts` | `pis/docs` + `pis/tests` (pytest читає `index.html` і `mobile/app/src`), ДО `tzCompliance.test.ts` | Тексти ТВ у Плексі розкидані по `index.html` та `.tsx`; при нових редакціях ТВ (`check_tz_updates.py` лише ловить зміну) немає автоперевірки дослівності | M |
| P1-8 | **Конфіг магазинів**: `ITSAppUsesNonExemptEncryption: false`, `usesCleartextTraffic: false` (`expo-build-properties`), `versionCode`, `blockedPermissions` + `READ_MEDIA_IMAGES`, `DETECT_SCREEN_CAPTURE`, `extra.eas.projectId` після `eas init` | `apps/mobile/app.json` | `mobile/app/app.json` | Іще один крок до публікації без листування з рев'ю Apple/Google; cleartext закріплюється явно | S |

### P2

| № | Що | Звідки / куди | Чому | Склад. |
|---|---|---|---|---|
| P2-1 | Перевірка пакета публічного APK на мітку збірки зі скріншотами; літерал у умові, а не в константі (Hermes згортає) | `security/screenshotsBuild.ts` + `build-android-apk.sh` -> `lib/config.ts`, `deploy`-скрипт | Тестова збірка без FLAG_SECURE не потрапить у магазин | S |
| P2-2 | Allowlist-очищення друкованої форми ЕСОЗ замість «iframe як є»; політика CSP у файлі, який завантажується; звіт `PrintoutReport` | `lib/ehealth-printout.ts` -> `index.html` `openDeclarationModal`/`showFormContent` | Захист від зовнішніх ресурсів і «накладок» у документі, який пацієнт підписує; чиста функція, легко тестується | M |
| P2-3 | Слабкі PIN (повтори/послідовності) і блокування при годиннику, що пішов назад | `lockPolicy.ts` `isWeakPin`, `isLockDue` -> `lib/pin.ts`, `lib/lock.ts` | Дешево; ТВ не вимагає | S |
| P2-4 | `prefers-reduced-motion` для анімацій (вхід, скелетони) | `globals.css` -> `index.html`/`app.css` | WCAG 2.3.3, EN 301 549 | S |
| P2-5 | `contentGate`: не монтувати екрани, поки заблоковано | `lockPolicy.contentGate`, `Protected.tsx` -> `app/_layout.tsx` `Shell` | Дані пацієнта не лишаються в React-дереві під оверлеєм (heap/accessibility dump) | M |
| P2-6 | Тримати прочитаний ключ КЕП у пам'яті вкладки до виходу/`pagehide`, підписувати реєстрацію й декларацію без повторного введення пароля | `lib/kep/keystore.ts` -> `kep.js`, `mobile-sign.html` | Менше повторних введень пароля. Компроміс: ключ довше в пам'яті; погодити з вимогою 1.6.1 і зі стратегією безпеки | M |
| P2-7 | Хмарні КЕП (KSP) і Дія.Підпис (QR, посилання) як способи підпису; `iit-widget` як запасний рушій | `lib/kep/engine.ts`, `signing-config.ts`, `KepWidget` -> `kep.js` | Багато пацієнтів не мають файлового ключа. Потребує проксі до KSP у BFF і узгодження зі ЦСК | L |
| P2-8 | Локалізація uk/en зі словником і типом ключів; помилки за кодом `error.<code>` | `packages/i18n`, `lib/i18n.ts` | Не вимога ТВ; вигідно, якщо планується англомовний інтерфейс. Спершу винести рядки з `index.html` | L |
| P2-9 | Скріншот-тести/інструкція: `e2e/tests/screenshots-*.spec.ts` на вигаданих даних, `run-screenshots.sh` | -> оновлення `docs/submission/img` | Зображення для `user_guide.pdf` відтворюються автоматично після редизайну | M |
| P2-10 | Журнал доступів (хто й коли читав дані) і сторінка «Довіра/згоди» в профілі | `AccessLogSection`, `TrustSection`, `ConsentsSection` | Не вимога ТВ №978; лише якщо з'явиться на платформі SimplexMed | M–L |
| P2-11 | Check-no-tester (скрипт, що шукає сліди технічного режиму в production-збірці) і підміна модулів на етапі збірки | `scripts/check-no-tester.mjs`, `next.config.ts` | Корисний патерн, якщо в Плексі з'явиться демо/тест-режим | S |
| P2-12 | Повний «режим тестувальника» (дерево ТВ, докази, зауваження) | `components/tester/*`, `lib/tester/*` | Не переносити: це велика платформна функція MedOne (ролі, серверне сховище). Достатньо P1-7 та матриці з посиланнями на екрани | L (не рекомендовано) |

## 5. Чого в MedOne немає, тож не переносити

- Нативні потоки ЕСОЗ у мобільному (КЕП, декларації, зміна даних, методи входу, доступи): у Плексі вони вже є, це перевага Плексі.
- Root/jailbreak-перевірки, certificate pinning, minAppVersion, push, Wallet, HealthKit, видалення акаунта (FR-AUTH-05): MedOne їх не має (README). Видалення акаунта в Плексі є (вимога App Store 5.1.1(v)).
- Step-up L0/L1/L2, рівні довіри: потрібні MedOne через власний акаунт на платформі.
- Модулі запису, візитів, аптеки.

## 6. Екрани й тексти ТВ-ПІС: MedOne vs Плексі

Матриця Плексі позначає ✅ усі пункти розд. 1–3 для веб і Android, окрім 1.3.4 (сервер). Порівняння по суті:

| Пункт / тема | MedOne | Плексі | Різниця |
|---|---|---|---|
| 1.4.2 токени в захищеному сховищі, 2.8 cookie | Є | Є | Паритет |
| 2.9 PIN/біометрія, 5 хв, холодний старт, вихід | Є (мобільний), але мітка PIN і порядок виходу суворіші | Є | У Плексі слабші деталі (P1-3..P1-5), вимога закрита |
| FR-AUTH-04 (5 помилок PIN, хеш із сіллю, FLAG_SECURE) | PBKDF2 30k | SHA-256 x1000, `usePreventScreenCapture` | Закрито в обох |
| 3.3.1–3.3.1.2 політика до входу, .txt, окрема згода | `LegalGate`: документи за версіями, чекбокс на кожен | Чекбокс `gate-eh-agree`, `.txt` | Паритет; MedOne зберігає прийняті версії в акаунті |
| 3.3.2–3.3.6, 3.5.x вхід/реєстрація за КЕП | Є у веб; в мобільному відсутнє | Є у веб і Android | Плексі повніше |
| 3.5.4.x поля реєстрації | `RegisterForm`, `signup-errors.ts`, перевірка `sign-up_validation` ДО Auth UI | Є, серверна перевірка + помилки біля полів | Паритет. У MedOne додатково `validate` (422 `sign-up_validation`) до переходу в Auth UI; Плексі має це в `registration.py`/`personForm.ts`, отже закрито |
| 3.6 копії документів (PG-09) | Не реалізовано (`dodatok1-coverage`: метод не розпочато) | Реалізовано | Плексі закриває, MedOne ні |
| 3.7 вихід + попередження ЕСОЗ | `EhealthDisconnect` (окремий «Вийти з eHealth») + вихід з кабінету | `signOut` + `showLogoutWarning` | Паритет |
| 3.8 доступи застосунків, відкликання, 3.8.2.1 попередження про власний доступ | `AppRevoke` з окремим попередженням про власний доступ | Є (`apps.tsx`, `AppRevoke`-аналог у вебі) | Паритет |
| 3.10 метод OTP створення/перейменування/вимкнення, повторна відправка коду | `AuthPhoneChange`, `AuthMethodActions`, `EhealthSmsHint` | `auth-methods.tsx`, `resendAuthMethodOtp` | Паритет |
| 3.11.1.6–3.11.1.10 попередження лікаря (ліміт, договір) | `lib/ehealth-tv.ts` (`limitNoticeKey`, `doctorNotices`) | `MSG_OVERLIMIT`, `MSG_NO_CONTRACT`, `limit_warning` | Паритет; MedOne винесло правила в чисту функцію з тестом |
| 3.11.3, 3.11.4 декларації, припинення | Є | Є | Паритет |
| 3.12.2 Bulk-export реєстрів (PG-06) | Не реалізовано (`dodatok1-coverage`: 40 рядків «метод не реалізовано») | Реалізовано (`client.bulk_*`) | Плексі закриває, MedOne ні |
| Додаток 1: 373 рядки | Таблиця `dodatok1.table.json` + резолвер + звіт покриття по методах; 251 рядок перевірено через HTTP-маршрути з фейковим ЕСОЗ; тексти двома мовами; посилання підтримки НСЗУ за категоріями | `annex1_errors.json` (373), `Annex1.resolve`, 7 тестів (`test_annex1.py`) | Кількість та сам текст — паритет. MedOne має **звіт покриття по методах і прив'язку кожного рядка до HTTP-маршруту та сценарію**; у Плексі такого звіту немає (P1-7 / P2: створити `annex1_coverage.md` генератором) |

Підсумок розділу: ТВ-екрани й тексти, закриті в MedOne і НЕ закриті в Плексі, не знайдено. Закриті глибше в MedOne: (а) версійовані документи й запис прийнятих версій у акаунт; (б) відокремлення «не вдалося визначити перешкоду» для 403 (P1-1); (в) звіт покриття Додатка 1 по методах; (г) golden-файл дослівних текстів ТВ. Закриті у Плексі, але не в MedOne: 3.6 (PG-09), 3.12.2 (PG-06), весь нативний мобільний потік.

## 7. Рекомендований порядок робіт

1. Швидкі за 1–2 дні (S): P1-3, P1-4, P1-5, P1-8, P2-4, P2-3.
2. Тиждень: P1-1 (потрібні зміни на BFF) і P1-2 (CSP, узгодити з nginx).
3. Далі автотести: P1-7, потім P1-6.
4. Ідеї P2 — після редизайну «Плексі» (гілка `feature/plexi-design`), щоб не змішувати зміни розмітки.

Ризики: P1-5 (час PBKDF2 на Hermes без JIT, MedOne сам пише, що час «ще не виміряно на пристрої»), P1-2 (inline-обробники: CSP без `unsafe-inline` потребує рефакторингу `index.html`), P2-6 (довше життя ключа в пам'яті).
