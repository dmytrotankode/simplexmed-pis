# «Плексі» поруч із MFX: інтеграція без впливу на MFX

Версія 1.0 · 15.10.2026

«Плексі» (КПІС «SimplexMed») збудований як **автономний блок**. Його можна розгорнути поруч із MFX, а пізніше
підключити як білу марку застосунку пацієнта, не змінюючи код MFX. Нижче: що саме ізольовано, три способи
підключення і чек-ліст безконфліктності.

## 1. Що є

| Компонент | Де | Призначення | Залежності |
|---|---|---|---|
| `ehealth_pis` (пакет `plexi-ehealth`) | `pis/backend/ehealth_pis`, `pyproject.toml` | Клієнт PIS API ЕСОЗ: токени, підпис-контент, помилки за Додатком 1, реєстрація/зміна даних, кеш реєстрів | Лише стандартна бібліотека Python 3.10+ |
| BFF-сервіс | `pis/backend/app.py`, `pis_service.py` | HTTP API кабінету (`/api/*`), сесії, зберігання токенів ЕСОЗ (шифровані) | Flask, psycopg2, cryptography |
| Веб-кабінет | `pis/web/index.html`, `kep.js`, `tester.js` | Інтерфейс пацієнта, підпис КЕП, розділ «Тестування» | Без збирання; CSS — `app.css` |
| Plexi SDK | `pis/web/sdk/plexi-sdk.js` (віддається сервісом за `/sdk/plexi-sdk.js`) | ES-модуль для сторінок-хостів (MFX): сесія, вхід з КЕП, виклики API | Без залежностей |
| Мобільний застосунок | `pis/mobile/app` | Android/iOS/Huawei (Expo) | Власний `package`/bundle id |
| Тестова програма | `pis/tools/conformance/check.py` | Перевірка розгорнутого екземпляра ззовні | Лише стандартна бібліотека |

## 2. Межі ізоляції (чому MFX не ламається)

- **Окремий процес і порт** (за замовчуванням `127.0.0.1:3122`), окремий pm2/systemd-юніт. Спільного коду з MFX немає.
- **Окрема схема БД** `pis_core` (власні таблиці `users`, `sessions`, `patient_details`, `tester_*`). MFX-таблиць не торкається.
- **Власні cookie** `pis_session_token` і `pis_oauth_state` (HttpOnly, Secure, SameSite=Strict, без `Domain`: діють лише на хості «Плексі»).
- **Власні секрети** `PIS_TOKEN_KEY`, `PIS_STATE_KEY`, облікові дані ЕСОЗ — у `.env` сервісу «Плексі», не у MFX.
- **Власний `redirect_uri`** у ЕСОЗ (`https://simplex-med.com` → `redirect-ehealth.js` за `state`): повернення з ЕСОЗ маршрутизується окремим середовищем `my`/`my-dev`/`pis-app`, не втручаючись у потоки МІС (`app2*`).
- **Відсутність глобальних ефектів:** SDK не чіпає DOM хоста, не пише в `localStorage` MFX; веб-кабінет відкривається окремою сторінкою.
- **Розділ «Тестування»** вимкнено за замовчуванням (`PIS_TESTER_MODE`) і доступний лише на тестових хостах.

## 3. Способи підключення (від найменш до найбільш інтрузивного)

### A. Окремий піддомен (рекомендовано)
`plexi.<домен MFX>` → reverse proxy на `127.0.0.1:3122` (nginx: `proxy_pass`, `X-Forwarded-Proto https`, `client_max_body_size 21m`).
MFX посилається на кабінет або відкриває його у вкладці/вбудованому веб-вікні. Код MFX не змінюється.
Cookie з `SameSite=Strict` працюють, бо піддомени одного сайту.

### B. Вбудовування в сторінку MFX через SDK
```js
import { PlexiClient } from 'https://plexi.example.com/sdk/plexi-sdk.js';
const plexi = new PlexiClient({ baseUrl: 'https://plexi.example.com', env: 'my' });
if (!(await plexi.me())) await plexi.startKepSignIn({ keyFile, password, consent: true });
```
На сервісі «Плексі» додайте origin MFX у `PIS_CORS_ORIGINS` (через кому). MFX і «Плексі» мають бути одного сайту
(`SameSite=Strict`). Якщо сайти різні — використовуйте варіант A (перехід на кабінет).

### C. Бібліотека `plexi-ehealth` у власному бекенді
`pip install ./pis/backend` і прямі виклики `PisClient` (токени, помилки, валідація). Підходить, якщо бекенд MFX
на Python; для Node/NestJS використовуйте HTTP API (варіант A/B). Бібліотека не залежить від Flask і БД.

## 4. Конфігурація (`.env`, ключові змінні)

| Змінна | Призначення |
|---|---|
| `PIS_CLIENT_ID`, `PIS_CLIENT_SECRET` (або файл `PIS_CRED_FILE`), `PIS_EHEALTH_PSK` | Доступи ПІС в ЕСОЗ (секрети не в git) |
| `PIS_AUTH_HOST`, `PIS_API_HOST`, `PIS_LOGIN_HOST` | Хости ЕСОЗ (PreProd/Prod) |
| `PIS_REDIRECT_URI` | Зареєстрований у ЕСОЗ (`https://simplex-med.com`) |
| `PIS_EXTRA_SCOPES` | Додаткові скоупи, виділені НСЗУ (напр. `person_request:sign_pis`) |
| `PIS_TOKEN_KEY`, `PIS_STATE_KEY` | Ключі шифрування токенів / підпису state |
| `PIS_CORS_ORIGINS` | Дозволені origin (за замовчуванням лише власні) |
| `PIS_TESTER_MODE`, `PIS_TESTER_HOSTS`, `PIS_TESTER_TAX_IDS` | Розділ «Тестування» (лише тест) |
| `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `DB_PIS_NAME` | БД PostgreSQL |
| `PIS_SUPPORT_CONTACTS`, `PIS_NAME` | Тексти помилок за Додатком 1 |

## 5. Чек-ліст безконфліктності при розгортанні поруч із MFX

1. Порт `3122` вільний (або змініть `PIS_PORT`).
2. Окремий юніт pm2/systemd з одним воркером (стан входів у пам'яті): не додавати воркерів.
3. Окрема БД або схема `pis_core`; користувачу БД дозволено `CREATE` у схемі (міграції `backend/migrations/*.sql`).
4. nginx: власний `server_name`, TLS 1.2+, заголовки безпеки не дублюються (їх ставить сервіс).
5. У ЕСОЗ зареєстровані лише `client_id`/`redirect_uri` «Плексі»; не використовувати їх в MFX.
6. Нічого з `.env` «Плексі» не потрапляє в репозиторій MFX; `PIS_TESTER_MODE` не вмикати на продакшені.
7. Після розгортання: `python pis/tools/conformance/check.py https://plexi.<домен>` → усі пункти PASS.

## 6. Як передати проекту MFX у майбутньому

1. Зафіксувати версію: `plexi-ehealth` (SemVer) і тег репозиторію.
2. MFX викликає «Плексі» через HTTP API (контракт — `pis/docs/spec/ТЗ_Плексі.md`, розд. «Інтеграція»), SDK — для веб.
3. Біла марка: назва/логотип/кольори — токени в `web/index.html` (`:root`) і `app.json` застосунку; юридичні тексти — `docs/legal/`.
4. Джерельна МІС підключається адаптером `source_mis` (див. `docs/medone-analysis/05-sync-source-mis.md`), без змін ядра ЕСОЗ.
