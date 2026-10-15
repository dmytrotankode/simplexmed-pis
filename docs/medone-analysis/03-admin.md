# Напрям №3 — адмін-портал: що є у MedOne і що потрібно «Плексі Admin»

Дата аналізу: 15.10.2026. Лише читання; у `C:\__MEDLINK___` нічого не змінювалось.
Джерела: `specs/ТЗ_MedOne_Admin.md` (v1 від 09.10.2026), `specs/ТЗ_MedOne_Tester_Mode.md`, `medone/contracts/medone-admin.openapi.yaml` (~10,2 тис. рядків, ~200 операцій), `medone/apps/admin/src/nav.ts`, `medone/services/platform/src/MedOne.Modules.Admin` (Secrets, Security, Domain/Entities, Seeding), `medone/docs/legal/README.md`, `medone/contracts/seed-ehealth-profile.*.json` (значення не відтворюються).
Облікові файли (`email-cred.txt`, `turbosms_cred.txt`) не відкривались.

---

## 1. Що є у MedOne

### 1.1 Призначення
Окремий веб-портал для співробітників (не пацієнтів) `admin.medone.ua`, окремий API `/admin/v1`. Керує платформою: інтеграції (eHealth, МІС, SMS/Viber, Push, пошта, аптеки, ЛІС, відео), організації/тенанти, підтримка пацієнтів, приватність і видалення даних, контент і шаблони, версії застосунків, аудит, KPI, здоров'я системи. Медичні дані пацієнтів в адмінці не показуються ніколи, ПД маскуються (розкриття лише через break-glass з причиною і записом в аудит).

### 1.2 Технології та каркас
- Фронт: React 19 + TypeScript + MUI (+ DataGrid), React Hook Form + Zod, TanStack Query, клієнт з OpenAPI; стиль «як MedLink» (тема з токенів, тёмне ліве меню, чипи статусу інтеграцій у шапці).
- Бекенд: .NET-модуль `MedOne.Modules.Admin` (EF Core, PostgreSQL, окрема схема `admin`), контракт-перший (OpenAPI 3.1, camelCase, помилки RFC 9457 зі стабільним `code`, курсорна пагінація, `Idempotency-Key` на POST, `X-CSRF-Token` на всі зміни).
- Розширення OpenAPI на кожній операції: `x-roles`, `x-scope` (platform | tenant | clinic), `x-priority` (Q1/Q2/Q3) — роль і черга впровадження описані прямо в контракті.

### 1.3 Ролі й права (8 ролей)
| Роль | Область | Суть |
|---|---|---|
| platform_superadmin | платформа | все, включно з секретами і prod-профілем eHealth |
| integration_engineer | платформа | інтеграції, тест-підключення, журнали, секрети; без даних пацієнтів |
| tenant_admin | тенант | брендинг, налаштування, співробітники тенанта |
| clinic_manager | клініка | правила запису, звернення клініки |
| support_operator | платформа/тенант | пошук акаунтів (маска), конфлікти прив'язки, звернення, сесії |
| dpo | платформа | запити суб'єктів даних, згоди, інциденти ПД, журнал доступу |
| finance | платформа/тенант | підписки, платежі (черга 2-3) |
| auditor | платформа | лише читання, включно з аудитом, CSV-експорт |

Групи прав у коді (`AdminRoles`): `IntegrationsRead` (аудитор, інженер, суперадмін) / `IntegrationsWrite` (інженер, суперадмін), `SupportRead/Write`, `MailSettingsRead/Write`, `TesterRead/TesterAdmin`, `AuditRead/AuditExport`. Правило: читання — ширше, запис — вужче; prod-eHealth лише суперадмін.

### 1.4 Вхід і безпека
- SSO Microsoft Entra ID (OIDC) → сесійна cookie `medone_admin_session` (HttpOnly, Secure; 8 год, простій 30 хв), 2FA обов'язкова (TOTP або passkey). Запасний локальний вхід: пароль PBKDF2-SHA256 (600k ітерацій) + TOTP з replay-захистом; локальний адмін вимкнений поза Development/Testing.
- Небезпечні дії вимагають `reason` (>= 10 символів) і пишуться в журнал; опційно allowlist IP для ролей із секретами.
- Порушення = problem+json з кодами на кшталт `ehealth_prod_requires_superadmin`, `test_kep_not_allowed`, `active_profile_delete_forbidden`.

### 1.5 Розділи (навігація `nav.ts`)
- ПРОЦЕСИ: Дашборд KPI; Пацієнти (пошук, картка, сесії/пристрої, згоди, сповіщення, блок/розблок, скид OTP-ліміту, break-glass); Звернення (тікети, листування, призначення, маршрутизація, спам/блоклист, відмови доставки, DMARC); Приватність (запити видалення/експорт, інциденти ПД, публічна веб-форма видалення акаунта); Замовлення в аптеках.
- ІНТЕГРАЦІЇ: eHealth (ПІС); домени e-mail при реєстрації; МІС MedLink; Сповіщення (TurboSMS/Viber); Пошта; Push (APNs/FCM/HMS/WebPush); Підпис і вхід (КЕП/EUSign, Дія, ID.GOV.UA, політика ключа на пристрої, синхронізація eHealth за токенами); Запис до лікаря; PharmaPoint (+ Скарб, ЛІС, Jitsi); телемед-профілі; сховище файлів; PACS.
- ДОВІДНИКИ: Організації (тенанти/клініки/домени/брендинг/UI-тексти); Шаблони повідомлень (подія x канал x мова); Юридичні документи; Заблоковані адреси; Версії застосунків (+ банери, режим «лише читання»).
- СИСТЕМА: Сховище секретів; Журнал аудиту; Здоров'я системи (залежності, outbox, інциденти).
- ТЕСТУВАННЯ (лише якщо режим увімкнено на інсталяції і роль має `tester_read`): тестувальники, покриття дерева ТВ, сценарії, прогони.

### 1.6 Керування профілем інтеграції з ЕСОЗ (ADM-INT-01)
Список профілів, один активний на оточення; перемикання з підтвердженням і причиною, застосовується без рестарту (≤ 60 с).
Поля профілю: назва, оточення (preprod/prod), Auth UI host, API base URL, client_id (публічний), список redirect_uri (мають бути зареєстровані в ДП ЕЗ), scopes (мультивибір із довідника `/ehealth-profiles/reference`), назва ПІС і контакти підтримки (підставляються в тексти помилок Додатку 1), типи документів дієздатності, `local_accounts`, allowlist хостів АЦСК для `kep/proxy`, таймаути/ретраї/TTL кешу довідників (60 с, 3, 4 год/24 год), флаги модулів (авторизація, реєстрація, ПД, декларації, доступи), state-prefix.
Секрети профілю (client_secret/API key, PSK, тестовий ключ КЕП + пароль): `writeOnly`, у відповідях лише `SecretRef {isSet, updatedAt, updatedBy, expiresAt}`; у профілі зберігається лише посилання `vault://...`. Тестовий ключ КЕП недоступний для prod-профілю (422).
Дії: «Перевірити з'єднання» (запит довідника, ≤ 5 с), «Тестовий вхід» (nonce → підпис → Auth UI у новій вкладці, статус за `state`), «Активувати», «Журнал викликів» (500 останніх, без ПД), діагностичний трейс одного акаунта з експортом HAR 1.2 для підтримки eHealth, редактор мапінгу помилок Додатку 1 (метод + код + текст ЦБД → повідомлення uk/en + дія; версії, restore, імпорт/експорт). Пресет профілю партнерського preprod створюється seed-міграцією (публічні значення, без секретів).

### 1.7 Секрети (ADM-SEC-01)
- Єдиний реєстр: ключ (шлях), відображувана назва, вид (api_key, oauth_secret, password, token, hmac, certificate, private_key, file), область, де використовується (`usedBy`), хто/коли змінив, термін дії, нагадування про ротацію за 30 днів, `expiresSoon`.
- Операції: список/метадані, `PUT /secrets/{id}/value` (set), `POST /secrets/{id}/rotate` (власно згенеровані — значення показується один раз як `OneTimeSecret`), у журналі значення маскується. Прочитати значення через UI/API неможливо.
- Реалізація: інтерфейс `ISecretStore` (Set/GetValue для внутрішніх споживачів/GetRef/Delete); у Development — `DbSecretStore`: значення шифруються ASP.NET Data Protection, захисник прив'язаний до ключа секрету (шифртекст не перенести в інший рядок), ключове кільце на диску поза git; для production заплановано Vault/Azure Key Vault за тим самим інтерфейсом.

### 1.8 Довідники й реєстри
Тенанти/клініки/кабінети (кабінети з МІС лише для читання), домени white-label з перевіркою DNS і TLS, брендинг з перевіркою контрасту AA, мови, увімкнені функції, правила запису; довідник scopes і типів документів дієздатності; мапінг помилок Додатку 1 (версіоноване); шаблони подій; блоклист адрес/доменів; домени e-mail при реєстрації (заборонені — `ehealth-banned-email-domains.md`); версії застосунків.

### 1.9 Журнали й аудит (ADM-AUD-01)
`AuditEvent`: id, час, актор (id, ім'я, роль), `action` (крапкова назва, напр. `ehealth_profile.activate`), `entityType/entityId/entityLabel`, `before/after` (секрети замасковані), `reason`, IP. Немає ендпоінтів запису; зберігання 3 роки; фільтри за користувачем/сутністю/дією/періодом; CSV-експорт лише аудитор і суперадмін. Для тестового режиму додатково хеш-ланцюг подій демонстрацій.

### 1.10 Користувачі пацієнтів і доступ тестувальників
- Акаунти пацієнтів: пошук (маска), блок/розблок з причиною, сесії/пристрої, скид OTP-ліміту, згоди, історія сповіщень, статус eHealth (без токенів), break-glass reveal з причиною + номером звернення. Черга конфліктів прив'язки (`pending_clinic`).
- Співробітники: `/staff`; ролі з Entra ID (групи → ролі).
- Тестувальники (розділ «ТЕСТУВАННЯ», ТЗ Tester Mode): обліковий запис = звичайний акаунт з прапорцем `tester_account`; види `owner | internal_qa | dp_commission | auditor`; статус active/revoked/expired, термін (за замовч. 30 діб, не більше 180), `data_sources` (emulator/preprod/sandbox), `can_accept`, `allowed_envs`; запрошення одноразовим посиланням на 7 діб; відкликання/продовження однією кнопкою; режим вимкнений у production (`Tester:Enabled=false`, allowlist середовищ); працює лише з тестовими профілями; усі дії в аудиті. Дерево вимог ТВ ПІС (297 вузлів, 211 листів), атоми «літера в літеру», приймання «виконано» (append-only), автотести, демонстрації, протоколи з хеш-ланцюгом.

### 1.11 Політики й юридичні документи (ADM-LEG-01)
Типи: `privacy`, `offer`, `health_data_processing`, `ehealth`, `pharmacy_data_sharing`, `marketing` (обов'язковість і місце показу описано в `docs/legal/README.md`). Файли `<тип>.<версія>.<мова>.md` у репозиторії + `sync.sh`; в адмінці: документ → версії (чернетка, дата набрання чинності, мови, по тенантах) → `publish` → повторна згода при наступному вході → звіт «скільки прийняло версію». Юридичні тексти в репозиторії позначені як «не висновок юриста».

### 1.12 Моніторинг (ADM-HLT-01, ADM-KPI-01)
`/health` — статуси залежностей (ЕСОЗ, МІС по тенантах, ЛІС, MessageGateway, APNs/FCM/HMS, БД, Redis, outbox) із чипами в шапці; недоставлений outbox із «Повторити»; `system/incidents` (останні збої, підтвердження, ingest). KPI: плитки і ряди (реєстрації, MAU/DAU, записи, no-show, eHealth-підключення, помилки ЕСОЗ за кодами, SLA підтримки, доставка SMS/Push, crash-free).

### 1.13 Пошта/SMS і синхронізація з МІС (MedLink)
- SMS/Viber: TurboSMS (налаштування, alpha-name, шаблон OTP, ліміти, баланс, тестове відправлення, журнал повідомлень, ручне оновлення статусу, ротація токена вебхука доставки). Email: SMTP/Graph/IMAP, DKIM-перевірка, тест-відправлення, поштові скриньки (Graph/IMAP) і курсори папок, звіти DMARC, відмови доставки.
- МІС: `mis-connections` на тенант — драйвер `medlink-legacy-sync`/`medlink-native`, вхідний Bearer для `/sync/*` (генерація й ротація, показ один раз), вихідні облікові дані, HMAC вебхуків, мапінг провайдер → клініка; статус, `test-connection`, `force-update` (повне вивантаження), `reconcile` (звірка), jobs, dead-letters із retry; режим «тінь» на час міграції.

### 1.14 Висновки щодо MedOne (що відрізняє від нас)
MedOne — багатотенантна платформа з 8 ролями, SSO, окремим фронтом на React, ~200 операцій; значна частина не стосується КПІС (мультитенантність клінік, МІС, аптеки, PACS, підписки, SEO, телемед). Для «Плексі» релевантні: профіль ЕСОЗ, секрети, мапінг помилок, довідники/юр. документи, згоди/запити видалення, аудит, здоров'я, тестувальники, версії застосунків.

---

## 2. Що потрібно «Плексі»

Принципи: один оператор (SimplexMed), одне середовище на інсталяцію (preprod, потім prod), немає тенантів і МІС; кабінет уже має Flask-BFF і `pis_core`; без Vault; адмінка має бути маленькою, безпечною і такою, що не заважає проходженню тестування ДП ЕЗ.

### 2.1 Мінімальний, але повний за призначенням набір
| № | Функція | Навіщо | Черга |
|---|---|---|---|
| A1 | Вхід адміністратора: пароль + TOTP, сесія, CSRF, блокування після помилок | доступ до секретів | P0 |
| A2 | Профіль інтеграції з ЕСОЗ: client_id, redirect_uri, scopes, хости, таймаути, назва ПІС і контакти, прапорці модулів; активний — один | зараз усе в `.env`/файлі і потребує деплою | P0 |
| A3 | Секрети write-only: client_secret/API-key, PSK, TURBOSMS/SMTP-пароль, ключ шифрування токенів не в UI; set/rotate, `isSet`, дата, термін, нагадування | прибрати секрети з `.env`/cred-файлів | P0 |
| A4 | Перевірка підключення (довідник), діагностика (версія API, затримка), перегляд журналу викликів ЕСОЗ без ПД | швидко знаходити проблеми preprod/WAF | P0 |
| A5 | Журнал аудиту дій адміна (append-only, секрети замасковані) | вимога КСЗІ (п. 2.15 ТВ) | P0 |
| A6 | Редактор мапінгу помилок Додатку 1 (перегляд + override повідомлення/дії, версії) | `annex1_errors.json` без деплою | P1 |
| A7 | Юридичні документи: версії, публікація, повторна згода, звіт про прийняття | п. 3.3.1, 3.5.1 ТВ | P1 |
| A8 | Тестувальники: список, статус/термін, відкликання, запрошення | доступ комісії/QA на staging | P1 |
| A9 | Пацієнти (підтримка): пошук за маскою, блок, сесії/пристрої, скид; запити на видалення/експорт (SLA 30 діб) | privacy, сторі | P1 |
| A10 | Здоров'я системи: ЕСОЗ, БД, SMS/e-mail, ЦСК-проксі, диск; дашборд «останні збої» | моніторинг | P1 |
| A11 | Шаблони повідомлень (SMS/e-mail/push) uk | зараз у коді | P2 |
| A12 | Версії застосунків і банери обслуговування | Expo-застосунок | P2 |
| A13 | KPI (реєстрації, входи, помилки ЕСОЗ за кодами) | аналітика | P2 |
| A14 | Звернення/підтримка (тікети) | поки одна скринька | P2 |

Не робимо: тенанти/клініки/домени, МІС-синхронізація, аптеки, PACS, телемед, підписки, SEO, SSO Entra (залишаємо опцією).

### 2.2 Інтеграції
- Пошта і SMS: не окремі розділи, а пара «профіль + секрет» у загальній моделі `integration_settings` (kind = `sms_turbosms`, `email_smtp`); дії «тестове відправлення на номер адміна», баланс (SMS).
- Синхронізація з джерельною системою (MedLink) — відкладена; в схемі лише місце: `integration_settings.kind = 'mis_medlink'` без реалізації.

---

## 3. Ролі / права

Роль у MedOne — 8; нам достатньо 5 (область завжди «платформа»):

| Роль | Права |
|---|---|
| `owner` (суперадмін) | все, включно з prod-профілем ЕСОЗ, секретами, ролями адмінів, `reason` обов'язковий |
| `integration` (інженер інтеграцій) | профіль ЕСОЗ (preprod), секрети (set/rotate), тести підключення, мапінг помилок, шаблони, версії застосунків; без даних пацієнтів; prod лише `owner` |
| `support` (оператор підтримки) | пацієнти (маскований перегляд, блок, сесії), запити видалення, звернення; без секретів |
| `legal` (DPO/юрист) | юр. документи, запити суб'єктів, згоди, інциденти ПД, читання аудиту |
| `auditor` | лише читання, у т. ч. аудит і метадані секретів; CSV-експорт |

Правила (перенесені з MedOne):
1. Читання ширше за запис; секрети тільки `integration`/`owner`; значення не читається нікому.
2. Небезпечна дія (активація профілю, ротація, блок, видалення, prod) — `reason` ≥ 10 символів.
3. prod-профіль ЕСОЗ — лише `owner`; поле тестових ключів КЕП у prod-профілі відсутнє.
4. Розкриття ПД (break-glass) — тільки `support`/`legal`, з причиною і записом; медичні дані не показуються взагалі.
5. Тестувальники керуються `owner`/`integration`; режим тестування вимкнений у prod.
6. Двофакторність обов'язкова для всіх; сесія 8 год, простій 30 хв.

Матриця (R — читання, W — запис, S — тільки set/rotate без читання):

| Розділ | owner | integration | support | legal | auditor |
|---|---|---|---|---|---|
| Профіль ЕСОЗ | RW | RW (preprod) | — | — | R |
| Секрети | S + мета | S + мета | — | — | мета |
| Мапінг помилок | RW | RW | — | R | R |
| Юр. документи | RW | R | R | RW | R |
| Пацієнти / запити видалення | RW | — | RW | RW | R (маска) |
| Тестувальники | RW | RW | R | — | R |
| Аудит | R + CSV | R | — | R | R + CSV |
| Користувачі адмінки | RW | — | — | — | R |

---

## 4. API і дані

### 4.1 Розміщення і стек (сумісний з нашим)
- Окремий Flask-blueprint `admin_api` у `pis/backend/admin/` (префікс `/admin/api/v1`), що працює в тому самому процесі/гілці коду, але **за окремим server-блоком nginx** `admin.simplex-med.com` (і allowlist IP/VPN на `/admin`); своя cookie `plexi_admin_session` (HttpOnly, Secure, SameSite=Strict), без спільних сесій з кабінетом пацієнта.
- Фронт: проста статична сторінка `pis/web-admin/index.html` + `admin.js` (vanilla JS, без збірки; ніяких CDN — локальні файли), стиль «Плексі» з токенів кабінету. Ліве меню груп, таблиці, форми, діалог «причина» для небезпечних дій. Один файл-модуль на розділ.
- Бібліотеки: `pyotp` (TOTP), `argon2-cffi` або `hashlib.scrypt` (хеш пароля), `cryptography` (AES-GCM; вже є для Fernet), `psycopg` (вже). Нових сервісів немає: PostgreSQL `pis_core` + файл майстер-ключа.
- Контракт: `pis/docs/admin-api.openapi.yaml` (контракт-перший, як у MedOne), помилки у вигляді problem+json зі стабільним `code`, cursor-пагінація, `X-CSRF-Token` на змінюючих запитах, `Idempotency-Key` на POST.

### 4.2 Ендпоінти BFF (`/admin/api/v1`)
Автентифікація і сесія
- `POST /auth/login` (email, пароль) → крок 2FA; `POST /auth/2fa/verify`; `POST /auth/logout`; `GET /session`; `POST /auth/totp/enroll`, `/auth/password/change`.
- `GET/POST/PATCH /admins` (owner), `POST /admins/{id}/reset-2fa`, `/disable`.

Профіль ЕСОЗ
- `GET /ehealth-profiles`, `POST`, `GET/PATCH/DELETE /{id}`, `GET /ehealth-profiles/reference` (scopes, типи документів).
- `POST /{id}/test-connection`, `POST /{id}/activate` (reason), `GET /{id}/call-log`.
- `GET/PUT /ehealth-error-mappings`, `GET .../versions`, `POST .../versions/{v}/restore`, `GET .../export`, `POST .../import`.

Секрети
- `GET /secrets`, `GET /secrets/{id}` (метадані).
- `PUT /secrets/{id}/value` {value, expiresAt?, reason}; `POST /secrets/{id}/rotate`; `DELETE /secrets/{id}` (reason).

Інтеграції (пошта/SMS)
- `GET/PUT /integrations/{kind}` (sms_turbosms, email_smtp), `POST /integrations/{kind}/test-send`, `GET /integrations/sms_turbosms/balance`.

Довідники/політики
- `GET/POST /legal-documents`, `GET/POST /legal-documents/{id}/versions`, `POST .../versions/{v}/publish`, `GET .../acceptance-report`.
- `GET/POST/PATCH /notification-templates`, `POST .../preview`.
- `GET/PUT /app-versions/{platform}`, `GET/POST/PATCH /banners`.

Користувачі пацієнтів і тестувальники
- `GET /accounts/search`, `GET /accounts/{id}`, `POST /accounts/{id}/block|unblock`, `GET/POST .../sessions/revoke`, `POST .../break-glass/reveal`.
- `GET /privacy-requests`, `GET /{id}`, `POST /{id}/verify|cancel|execute`.
- `GET/POST /tester-accounts`, `PATCH /{id}` (продовжити/відкликати), `POST /tester-invites`.

Моніторинг/журнал
- `GET /audit-log`, `GET /audit-log/{id}`, `GET /audit-log/export` (CSV; аудитор/owner).
- `GET /health` (залежності), `GET /health/incidents`, `POST /health/incidents/{id}/ack`.
- `GET /kpi/dashboard` (P2).

Публічна частина (не в адмінці, але керується нею): `GET /api/config`, `GET /api/legal/{type}` — беруть значення з БД, а не з `.env`; кеш ≤ 60 с, інвалідація при `activate`/`publish`.

### 4.3 Таблиці PostgreSQL (схема `pis_core`, префікс `adm_`)
Окремі таблиці, SQL-міграція `002_admin.sql`; роль БД `pis_admin` має права лише на `adm_*` і читання потрібних `users/sessions` (через представлення).

| Таблиця | Ключові поля |
|---|---|
| `adm_users` | id, email unique, display_name, role (`owner/integration/support/legal/auditor`), password_hash, totp_secret_enc, totp_enrolled_at, failed_attempts, locked_until, is_active, last_login_at, created_at |
| `adm_sessions` | id, admin_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at |
| `adm_ehealth_profiles` | id, name, environment (`preprod/prod`), auth_ui_host, api_host, login_host, client_id, redirect_uris jsonb, scopes jsonb, pis_name, support_contacts, legal_capacity_doc_types jsonb, local_accounts bool, state_prefix, timeouts jsonb, modules jsonb, kep_proxy_hosts jsonb, is_active (частковий unique: один активний), version, updated_by, updated_at; поля секретів — лише `secret_refs jsonb` (ім'я → ключ секрету) |
| `adm_secrets` | id, key unique (`ehealth/<profile>/client_secret`), display_name, kind, ciphertext bytea, nonce bytea, key_version int, version int, expires_at, rotation_reminder_at, used_by jsonb, set_by, set_at; (значення лише шифртекст) |
| `adm_secret_versions` | secret_id, version, ciphertext, nonce, key_version, replaced_at, replaced_by — зберігати останні 2 для відкату; старі затираються |
| `adm_error_mappings` | id, method, code, source_text, message_uk, message_en, pis_action, is_override, version, updated_by |
| `adm_error_mapping_versions` | version, snapshot jsonb, created_by, created_at, reason |
| `adm_integration_settings` | kind (`sms_turbosms`, `email_smtp`), settings jsonb (без секретів), secret_refs jsonb, is_enabled, updated_by, updated_at |
| `adm_legal_documents` | id, type, title_by_lang, is_required, show_at (`before_login/profile/...`) |
| `adm_legal_versions` | id, document_id, lang, version (дата), body text, effective_at, status (`draft/published/retired`), published_by, published_at, text_sha256 |
| `adm_consent_acceptances` | user_id, document_id, version_id, accepted_at, ip |
| `adm_privacy_requests` | id, user_id, kind (`delete/export/revoke/...`), status (`received/verified/grace/executing/done/cancelled`), due_at, verified_at, executed_at, handled_by |
| `adm_tester_accounts` | user_id pk, kind (`owner/internal_qa/dp_commission/auditor`), status, expires_at, data_sources text[], can_accept, note, invited_at, created_by, revoked_at |
| `adm_notification_templates` | event, channel, lang, subject, body, vars jsonb, version, updated_by |
| `adm_app_versions` | platform, min_version, force_update, store_url, updated_by |
| `adm_banners` | id, message, platforms[], starts_at, ends_at, severity |
| `adm_audit_log` | id bigserial, at, actor_id, actor_role, action, entity_type, entity_id, entity_label, before jsonb, after jsonb, reason, ip, prev_hash, hash |
| `adm_health_checks` | key, status, checked_at, latency_ms, detail |
| `adm_ehealth_call_log` | id, at, profile_id, method, path, status, duration_ms, error_code, trace_id (без ПД і токенів; зберігання 30 діб) |

Інваріанти: `adm_audit_log` — тільки INSERT (REVOKE UPDATE/DELETE у БД + хеш-ланцюг `prev_hash→hash`), строк 3 роки; `adm_secrets.ciphertext` не вибирається жодним SELECT, окрім внутрішньої функції `secrets.get_value()`.

### 4.4 Що тримати в БД `pis_core`, а що ні
У БД: профілі, мапінг помилок, налаштування інтеграцій (без значень секретів), зашифровані секрети, юр. тексти і версії, згоди, запити, тестувальники, шаблони, версії застосунків, аудит, користувачі адмінки.
Не в БД (лишається на сервері): майстер-ключ шифрування секретів, `PIS_TOKEN_KEY` (Fernet токенів ЕСОЗ — можна також перевести під майстер-ключ), параметри підключення до БД (`PG_*`), файл ключа КЕП для тестів (у файловому сховищі з правами 600; в БД лише шлях/відбиток), TLS-ключі.

### 4.5 Схема внесення секретів без Vault
1. **Майстер-ключ**: 32 випадкові байти у файлі `/etc/simplex-pis/master.key`, власник — користувач сервісу `simplex-pis`, права `0400`; каталог `0700`. Генерується один раз скриптом `tools/admin_init_master_key.py` (не друкує ключ); резервна копія — зашифрована офлайн, окремо від БД. Шлях задається `PIS_MASTER_KEY_FILE`; ключ ніколи не в `.env`/git/БД.
2. **Шифрування**: AES-256-GCM; ключ секрету = HKDF(master_key, info = `plexi-secret/v1/` + secret_key); випадковий nonce 96 біт на кожен запис; AAD = ключ секрету + версія (шифртекст не можна перекласти в інший запис); `key_version` для перезапису під новим майстер-ключем (скрипт `tools/admin_rewrap_secrets.py`, MultiFernet-подібний: приймає старий і новий ключі).
3. **Внесення**: тільки через UI/`PUT /secrets/{id}/value` по HTTPS від ролі `integration/owner` після 2FA; значення проходить у тілі POST (не в URL), не логуються (фільтр у логері; заборонено `request.get_data` у логах); відповідь — лише `SecretRef`. Для файлів (ключ КЕП) — multipart-завантаження, шифрується так само, пароль — окремий секрет.
4. **Споживання**: `secrets.get_value(key)` у процесі BFF; розшифроване значення живе в пам'яті ≤ 60 с (TTL-кеш), у `PisConfig` потрапляє через новий конструктор `PisConfig.from_store(store)`; за відсутності значення в БД — запасний шлях з `.env` (міграційний період, потім вимикається прапорцем `PIS_ALLOW_ENV_SECRETS=0`).
5. **Ротація**: `POST /rotate` з `reason`; нова версія активна одразу, попередня зберігається 24 год для відкату, потім затирається; нагадування за 30 діб до `expires_at`; журнал: хто/коли/чому, значення не пишеться.
6. **Захист**: окрема роль БД `pis_admin`; `REVOKE` прямого читання `adm_secrets.ciphertext` для ролі застосунку, крім процедури `adm_get_secret(key)` (журналюється); дамп БД містить лише шифртекст, тож без файлу майстер-ключа даремний; ротація майстер-ключа щоквартально або при зміні складу адмінів.
7. **Початкове наповнення**: одноразовий скрипт читає наявні `PIS_CRED_FILE`/`PIS_EHEALTH_PSK` з оточення, імпортує в `adm_secrets`, потім файли видаляються (скрипт не друкує значень).

### 4.6 Вхід адміністратора
Хеш пароля — argon2id (або scrypt), мінімум 12 символів; обов'язковий TOTP (secret шифрується майстер-ключем); 5 помилок → блокування 15 хв; нові адміни створюються лише `owner` (одноразовий лінк запрошення, 24 год); перший `owner` створюється командою `python tools/admin_bootstrap.py` на сервері (пароль вводиться інтерактивно); SSO Entra — опція P2. Allowlist IP/VPN на рівні nginx для `/admin`.

---

## 5. План реалізації

### P0 (мінімум, ~1,5–2 тижні) — «вимкнути секрети з .env і керувати профілем ЕСОЗ»
1. Міграція `002_admin.sql`: `adm_users`, `adm_sessions`, `adm_ehealth_profiles`, `adm_secrets`(+versions), `adm_audit_log`, `adm_ehealth_call_log`; роль БД `pis_admin`.
2. Модуль `secrets` (AES-GCM + HKDF, master.key, TTL-кеш) + `tools/admin_init_master_key.py`, `admin_bootstrap.py`, `admin_import_env_secrets.py`.
3. Blueprint `admin_api`: auth (пароль + TOTP + CSRF), ehealth-profiles (CRUD, activate, test-connection, call-log), secrets (set/rotate/meta), audit-log.
4. `PisConfig.from_store()`; публічний `/api/config` береться з активного профілю; середовища preprod/prod.
5. Фронт: `web-admin` — вхід, профіль ЕСОЗ (форма + scopes), секрети, аудит.
6. Nginx: `admin.simplex-med.com`, allowlist IP, окремі rate-limit; тести pytest (права ролей, секрет не повертається ні в якій відповіді, аудит маскує значення, один активний профіль).
Критерії: секретів немає в `.env` і дампі БД у відкритому вигляді; зміна активного профілю діє ≤ 60 с без рестарту; кожна зміна — запис в аудит.

### P1 (~2–3 тижні)
- Мапінг помилок Додатку 1 (override + версії + імпорт/експорт), юридичні документи (версії, публікація, повторна згода, звіт), тестувальники (акаунти, термін, відкликання, запрошення), пацієнти/запити видалення (SLA 30 діб, експорт), здоров'я системи (ЕСОЗ/БД/SMS/ЦСК-проксі + «останні збої»), інтеграції SMS/e-mail з тестовим відправленням, ролі `support/legal/auditor`, CSV-експорт аудиту, нагадування про ротацію/сертифікати.

### P2
- Шаблони повідомлень, версії застосунків і банери, KPI, звернення (тікети), SSO Entra/passkey, хеш-ланцюг аудиту з перевіркою, перенесення `PIS_TOKEN_KEY` під майстер-ключ із ротацією, синхронізація з МІС (за появи джерела), перегляд реєстру тестового дерева вимог ТВ (з боку тестувальників: можна взяти з MedOne `tv-pis-tree.json`).

### Ризики/рішення, які потрібні від власника
1. Домен/доступ до адмінки (окремий піддомен + VPN/IP) і наявність резервного носія для майстер-ключа.
2. Чи потрібен prod-профіль до сертифікації (рекомендація: у UI заборонено до явного прапорця `owner`).
3. Чи переносимо вже наявні cred-файли в `adm_secrets` одразу (рекомендація: так, у P0, зі зворотним fallback).
4. Узгодити з ПІС-сесією: адмін-код у `pis/backend/admin/` (ПІС-код належить сесії ПІС; МІС-сесія не торкається `pis/`).
