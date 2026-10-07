# SimplexMed ПІС — кабінет пацієнта (КПІС)

Кваліфікована пацієнтська інформаційна система за Технічними вимогами до ПІС
(наказ НСЗУ № 978 від 08.12.2025).

```
pis/
  backend/
    ehealth_pis/        переносимий клієнт eHealth PIS API (лише stdlib, без Flask і БД)
      client.py         усі методи специфікації
      config.py         PisConfig (хости, API-key, скоупи, таймаут ≥ 60 с)
      errors.py         EhealthApiError + повідомлення за Додатком 1
      annex1_errors.json  Таблиця обробки помилок (генерується pis/tools/build_annex1.py)
      signing.py        підготовка даних до ЕП, видалення BOM (п.1.6.3)
      registration.py   перевірка форми реєстрації (п.3.5.4) і контент для підпису
      declarations.py   підпис декларації, попередження і повідомлення за ТВ (п.3.11.1)
      registry.py       кеш реєстрів/довідників/адрес у SQLite (п.3.12), пошук лікаря
      transport.py      HTTP (urllib), можна підмінити
    app.py              BFF (Flask): сесії кабінету, /api/ehealth/*, проксі до ЦСК
    ca_proxy.py         проксі запитів бібліотеки підпису до ЦСК (лише хости з CAs.json)
    pis_service.py      PostgreSQL: облікові записи, сесії, зашифровані токени ЕСОЗ
    migrations/         SQL-міграції бази ПІС
  web/index.html        веб-кабінет
  web/kep.js            підпис КЕП у браузері (бібліотека ІІТ у web worker)
  web/lib/euscp/        бібліотека ІІТ і дані ЦСК — НЕ в git, ставиться tools/fetch_euscp.py
  docs/                 специфікація API (github.com/ehealth-ua/pis-api) і текст Додатку 1
  tests/                pytest + node-тест redirect-ehealth.js
  deploy/               nginx, systemd, deploy.sh, .env.example, redirect-ehealth.js
```

## Перенесення клієнта в інший продукт

Скопіювати `backend/ehealth_pis/` цілком (разом з `annex1_errors.json`).

```python
from ehealth_pis import PisClient, PisConfig, EhealthApiError

client = PisClient(PisConfig.from_env())        # або PisConfig(client_id=..., client_secret=..., redirect_uri=...)
nonce = client.get_nonce()                       # підписати ЕП на клієнті -> user_data (base64)
url = client.sign_in_url(state="...", user_data=signed_nonce_b64)
tokens = client.exchange_code(code)              # TokenSet: access_token, refresh_token, expires_at, person_id
person = client.get_person(tokens.access_token)
tokens = client.refresh(tokens.refresh_token)    # коли tokens.expires_within(120)
try:
    client.terminate_declaration(tokens.access_token, declaration_id, "Причина")
except EhealthApiError as e:
    show(e.user_message)                         # текст для користувача за Додатком 1
```

## Чинна редакція ТВ і перевірка актуальності

НСЗУ змінює технічні вимоги новими наказами, eHealth — специфікацію API. Перевірено 03.10.2026:
чинна — **ТВ до ПІС v2, наказ НСЗУ № 978 від 08.12.2025** (v1 — наказ № 494 від 11.07.2025, втратив чинність);
опублікований файл збігається з нашим, PIS API (`github.com/ehealth-ua/pis-api`, `apiary.apib`) не змінювався з 19.12.2025,
дашборд «Статуси тестування функціоналу ПІС» тестує за № 494 і № 978.

```bash
python pis/tools/check_tz_updates.py            # нові/змінені документи ПІС на ehealth.gov.ua і зміни PIS API
python pis/tools/check_tz_updates.py --update   # прийняти поточний стан після аудиту
```

Відомий стан — [`docs/tz-manifest.json`](docs/tz-manifest.json), текст чинної редакції — [`docs/tv_pis_978.txt`](docs/tv_pis_978.txt),
Додаток 1 — [`docs/tv_pis_978_dodatok1.txt`](docs/tv_pis_978_dodatok1.txt). Нова редакція: витягти текст (PyMuPDF — `pdftotext`
втрачає кирилицю), порівняти з попередньою за пунктами і перевірити веб, BFF і мобільний застосунок.

Що додала v2 порівняно з v1 (для КПІС): ширше визначення бездіяльності для блокування мобільного застосунку (п.2.9 — зокрема
введення з клавіатури, переміщення між екранами, прокручування), документ `BIRTH_CERTIFICATE_FOREIGN` у переліку для реєстрації,
напрями верифікації УНЗР і ДМС, правила показу ДРАЦСГ, завантаження копій документів при `DOCUMENTS_TRIGGERED` і за
`urgent.url`, попередження про відсутність договору МНП з НСЗУ, відновлення перерваного запиту на декларацію, форма декларації
у PDF, Contract Divisions (Bulk export).

## Покриття ТВ ПІС і API

| ТВ ПІС | Метод API | `PisClient` | BFF | Стан |
|---|---|---|---|---|
| 1.3.2 | таймаут ≥ 60 с | `PisConfig.timeout` | — | ✅ |
| 1.4.1 | Renew access token | `refresh` | автоматично в `ehealth_route` | ✅ |
| 1.4.1.1, 1.5.4 | Додаток 1 | `EhealthApiError.user_message` | поле `error` у відповіді | ✅ |
| 1.6 | ЕП CAdES-X Long | `signing.py` | `web/kep.js`: внутрішній підпис CAdES-X Long, ДСТУ 4145 + ДСТУ 7564 (або RSA/ECDSA), без BOM | ✅ |
| 1.5.3 | Доступність (ДСТУ EN 301 549 / WCAG 2.1 AA) | — | підписи пов'язані з полями, контраст ≥ 4.5:1, діалоги з role=dialog, Esc, утриманням і поверненням фокуса, live-регіони для повідомлень, aria-current у меню, посилання «до вмісту», можливість виділяти текст; axe-core: 0 порушень на всіх екранах | ✅ (автоматична перевірка; ручний аудит з читачем екрана — окремо) |
| 3.9.2–3.9.3 | Запис про пацієнта, статуси верифікації | `verification.py` | усі атрибути п.3.9.2; лише визначені напрями верифікації з текстами ТВ, без загального статусу | ✅ |
| 2.3 | XSS | — | — | ✅ усі дані ЕСОЗ через `esc()` / `textContent` |
| 2.4 | SSRF | — | URL завантаження лише з відповіді ЕСОЗ | ✅ |
| 2.8 | токени в HttpOnly cookie | — | токени ЕСОЗ лише на сервері (Fernet), у браузері — cookie сесії | ✅ |
| 3.1 | API-key | заголовок `API-key` у кожному запиті | — | ✅ |
| 3.3.1 | політика конфіденційності, збереження .txt, явна згода | — | `/api/privacy-policy?download=1`, чекбокс перед входом | ✅ |
| 3.3.2–3.3.3 | Get nonce + підпис ЕП | `get_nonce` | `POST /api/auth/nonce`, вікно КЕП | ✅ |
| 3.3.4 | PIS. Patient sign-in | `sign_in_url` | `POST /api/auth-url` (`user_data` = підписаний nonce); без підпису — інші способи на сайті ЕСОЗ | ✅ |
| 3.3.5 | помилки сервісу авторизації | `annex.resolve` | `POST /api/auth/sign-in-error` | ✅ |
| 3.3.6 | Exchange code | `exchange_code` | `POST /api/auth/token` | ✅ |
| 3.5 | PIS. Patient sign-up | `sign_up_url`, `registration.py` | `POST /api/auth/sign-up/prepare`, `POST /api/auth-url` (`mode=sign-up`), форма реєстрації | ✅ |
| 3.6, 3.5.8.2 | Initialize / Complete documents upload | `init_documents_upload`, `upload_document`, `complete_documents_upload` | `/api/ehealth/documents*`, блок у профілі | ✅ |
| 3.7 | Logout | `logout` | `/api/auth/logout`, `/api/auth/ehealth/logout` | ✅ |
| 3.8 | Get/Delete approvals | `list_apps`, `get_app`, `delete_app` | `/api/ehealth/apps*` | ✅ |
| 3.9.2 | Get Person details | `get_person` | `/api/ehealth/person` | ✅ |
| 3.9.3 | Get Person verification details | `get_verification` | `/api/ehealth/person/verification` | ✅ |
| 3.9.4 | Get Person authentication methods | `get_authentication_methods` | `/api/ehealth/person/authentication-methods`, повідомлення п.3.9.4.2–3.9.4.3 | ✅ |
| 3.10.1 | Initialize / Complete Update Person details | `create_person_request`, `complete_person_request`, `registration.validate_person_update` | форма зміни даних (РНОКПП/УНЗР незмінні, перевірка й на сервері), документи за `urgent.documents`, попередження про запити на декларацію, підпис КЕП, відновлення запиту NEW | ✅ |
| 3.10.2 | Person requests list / details / reject | `list_person_requests`, `get_person_request`, `reject_person_request` | розділ «Зміна персональних даних», електронна форма в ізольованому фреймі | ✅ |
| 3.10.3–3.10.4 | Auth method requests (create/approve/resend OTP), update alias | `create/approve/resend_auth_method*`, `update_auth_method` | вікно додавання номера з кодом SMS, «Змінити назву» | ✅ |
| 3.11.1 | Пошук лікаря, Create / Sign Declaration request | `registry.search_doctors`, `declarations.py`, `create/sign_declaration_request` | `/api/registry/*` (8 фільтрів, спеціальність за віком), картка лікаря, попередження п.3.11.1.6/3.11.1.7/3.11.1.10, форма від Системи, підпис КЕП `data_to_be_signed`, повідомлення за статусом, відновлення NEW | ✅ |
| 3.11.2 | Declaration requests list / details / reject | `list/get/reject_declaration_request` | блок «Запити на подання декларації», форма і PDF, відхилення з попередженням | ✅ |
| 3.11.3–3.11.4 | Get/Terminate declarations | `list_declarations`, `get_declaration`, `terminate_declaration` | чинна декларація окремо від інших, форма і PDF, припинення з причиною і попередженням ТВ | ✅ |
| 3.12 | Bulk-реєстри, адреси, довідники | `bulk_*`, `address_*`, `dictionaries`, `RegistryStore` | фонове оновлення реєстрів (повне, далі `depth`), кеш довідників і адрес 4–24 год | ✅ |

## Облікові записи SimplexMed і ЕСОЗ

Власний обліковий запис — це кабінет SimplexMed (можуть бути й інші сервіси). Доступ до даних
ЕСОЗ надається лише через сервіс авторизації Системи (п.1.5.2): токени ЕСОЗ прив'язані до
конкретної сесії, тож вхід за паролем SimplexMed сам по собі даних ЕСОЗ не відкриває.
Обліковий запис пов'язується з персоною ЕСОЗ лише за `person.id` з токена, не за телефоном чи РНОКПП.

## Підпис КЕП

Бібліотека АТ «ІІТ» (npm `@it-enterprise/digital-signature` 1.4.7, закріплена за SHA-256) працює у
web worker браузера: файл ключа і пароль не залишають комп'ютер пацієнта. Запити бібліотеки до ЦСК
(сертифікати, OCSP, TSP) йдуть напряму або через `/api/kep/proxy`, який пропускає лише хости з
`CAs.json`, без редиректів, з обмеженням розміру і частоти.

```bash
python pis/tools/fetch_euscp.py           # встановити бібліотеку і дані ЦСК (також у deploy.sh)
python pis/tools/fetch_euscp.py --check
```

Бібліотека пропрієтарна — у git не зберігається. Дані ЦСК (`CAs.json`, `CACertificates.p7b`)
періодично оновлюються: повторний запуск скрипта підтягує свіжі.

Зміна персональних даних: підписується об'єкт запиту з відповіді Initialize / Get Person Request Details
з `patient_signed = true`.

Вхід: підписується сам nonce (JWT з `aud = mithril-login`), ЕСОЗ знаходить пацієнта за РНОКПП
із сертифіката. Реєстрація: підписується JSON `{person, patient_signed, process_disclosure_data_consent, jwt}`.

## Кеш реєстрів (п.3.12)

`RegistryStore` (SQLite, `PIS_REGISTRY_DB`) тримає лікарів, працівників, ролі, МНП, СГуСОЗ, медичні послуги,
договори з НСЗУ і ліміти декларацій. Фоновий потік (`PIS_REGISTRY_REFRESH=1`, запускається з `app.py`)
щогодини перевіряє набори: оновлює ті, яким ≥ 4 год (отже не рідше доби), перший раз — повністю, далі — зміни
за `depth` днів. Довідники й адреси кешуються на 4 год (при недоступності ЕСОЗ віддається збережене).
Перше повне завантаження на проді може тривати довго й займати багато пам'яті — розмір вивантажень
треба оцінити на preprod.

PDF форм: кнопка «Завантажити PDF» відкриває діалог друку браузера (збереження у PDF) для форми,
отриманої від ЕСОЗ; форма друкується в окремому фреймі з унікальним походженням.

## Тести

```bash
python -m pytest pis/tests -q
node pis/tests/redirect_ehealth_test.js
```

## Викатка

Dev-сервер (поточна схема): `bash pis/deploy/deploy-pm2.sh` — accuracy-mfx-dev, `/root/simplex-patient-dev`,
pm2 `simplex-dev-patient` = `venv/bin/gunicorn -c backend/gunicorn.conf.py` (1 воркер, 8 потоків, таймаут 120 с),
nginx (my-dev і my) → `127.0.0.1:3122`; IP клієнта — з `X-Forwarded-For` (ProxyFix). Скрипт робить резервну копію, перевіряє
запуск у staging, застосовує міграції, оновлює код і бібліотеку підпису, перезапускає процес.
`.env` лежить у корені розгортання і читається самим `app.py`.

На preprod API ПІС обслуговує шлюз `https://pis-preprod.ehealth.gov.ua` (bulk, довідники, адреси, `/api/pis/*`);
`oauth/tokens`, `auth/logout` — `https://auth-preprod.ehealth.gov.ua`; сторінка входу — `https://pis-auth-preprod.ehealth.gov.ua`.

Загальна схема:

1. `.env` за `deploy/.env.example` (обов'язково `PG_PASSWORD`, `PIS_TOKEN_KEY`).
2. Міграції `backend/migrations/*.sql` до бази ПІС.
3. Код (`backend/` з `ehealth_pis/`, `web/`), перезапуск сервісу.
4. `deploy/redirect-ehealth.js` на `https://simplex-med.com/js/redirect-ehealth.js`.
