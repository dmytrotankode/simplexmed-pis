# Обмін і синхронізація з джерельною МІС: аналіз MedOne і пропозиція для «Плексі» (напрям №5)

Дата аналізу: 15.10.2026. Лише читання. Джерела MedOne (`C:\__MEDLINK___\PIS`): `medone\contracts\legacy-sync.openapi.yaml` і `legacy-sync.NOTES.md`, `legacy-portal.openapi.yaml`, `medlink-patient-data.openapi.yaml` і `.NOTES.md`, `specs\ТЗ_MedLink_PatientData_Extension.md`, `specs\ТЗ_MedOne_MedRecord_Aggregation.md`, `specs\ТЗ_MedOne_Pharmacy.md`, `medone\services\mis-agent\README.md`, `medone\services\medlink-emulator\*`, `medone\services\platform\src\MedOne.Modules.MisAdapters\IMisDriver.cs`. Наше: `C:\SIMPLEX_2.1\mis\simplex-api\src\*`, `mis\simplex-api\migrations\*`, `концепция_и_аналитика\00_АРХИТЕКТУРА_СИСТЕМЫ\{02,07}_*.md` і `simplexmed_2.0_full_schema.sql`.

Застереження: у MedOne значна частина описаного є ТЗ або контрактом, а не працюючим кодом (мис-агент порожній, розширення `medlink-patient-data` ще не реалізоване в MedLink, оцінка 37-49 людино-днів). Працює лише «старий» контур `/sync/*` (запис на прийом) і емулятор для нього.

---

## 1. Що є у MedOne

### 1.1 Три контури обміну з МІС MedLink

| Контур | Статус | Призначення | Напрям |
|---|---|---|---|
| A. `legacy-sync` (`/sync/*` на порталі, `/api/simplex/sync/*` у МІС) | працює в проді MedLink, 12 операцій | розклад, слоти, запис на прийом, послуги, довідка про пацієнта | двосторонній: МІС штовхає розклад і приймання на портал; портал викликає МІС для hold/create/cancel |
| B. `medlink-patient-data` (`/api/medone/v1/patient-data`) | тільки ТЗ і контракт (27 операцій), у МІС немає | медичні дані пацієнта для кабінету: візити, діагнози, рецепти, направлення, документи, звіти, щеплення, лікарняні, декларації | МІС -> MedOne, лише читання (+ стрічка змін) |
| C. `mis-agent` (Go) | заглушка, P2 | транспорт для МІС без публічного API: вихідний mTLS-канал, лише дозволені іменовані операції з підписаного маніфесту, без SQL/shell | MedOne <- агент у закладі |

Окремо: `legacy-portal` (старий PHP-портал, лише читання довідників і слотів, реверс-інжиніринг), `pharmapoint` (аптека, сторонній партнер, не МІС).

### 1.2 Сутності та напрям

| Сутність | Контур | Напрям | Ключі |
|---|---|---|---|
| Пацієнт | A: `getPatientById/{id}` (МІС викликає портал під час `create`); B: `match`, `GET /patients/{id}` | A: портал -> МІС; B: МІС -> MedOne | `person_id` (int, `cmn_person.external_id`); `misPatientId` = `mis_patient_card.id` |
| Розклад, слоти | A: `updateSchedules`, `deleteSchedules`, `display-schedule`, `setDataBySlot` (вимкнено) | МІС -> портал | `schedules_id`, `provider_id`, `employee uuid` |
| Послуги | A: `services` (повний каталог о 03:00 UTC) | МІС -> портал | `service id` (guid) |
| Записи на прийом | A: `reserve`, `reserve/cancellation`, `create`, `cancel` (-> МІС); `updateReserv` (МІС -> портал) | двосторонній | `visit_external_id` (int), `appointment_id` (guid) |
| Візити, діагнози | B: `/encounters`, `/episodes` | МІС -> MedOne | `misId` + `externalIds[]` (ehealth encounter/episode) |
| Рецепти | B: `/prescriptions` (код погашення лише в `/{id}`) | МІС -> MedOne | `ehealth_id`, номер рецепта |
| Направлення | B: `/referrals` | МІС -> MedOne | `ehealth_id`, requisition/`group_number` |
| Документи, звіти, лікарняні, щеплення | B: `/documents` (+`content` потоком), `/diagnostic-reports` + observations, `/sick-leaves`, `/immunizations` | МІС -> MedOne | складений id `<тип>:<guid>`; щеплення без ЄСОЗ-id |
| Декларації | B: лише читання (створення виключено з v1) | МІС -> MedOne | `ehd_declaration.ehealth_id`, `ehealth_request_id` |
| Рахунки | B: у v1 прибрано (моделі в МІС немає) | - | - |
| Фармація | не МІС: окремий модуль, провайдер PharmaPoint, за згодою `pharmacy_data_sharing` | MedOne <-> партнер | номер е-рецепта + код погашення з даних МІС |

### 1.3 Події, опитування, оновлення

- Контур A: події ініціює МІС (Hangfire): `updateReserv` при кожній зміні приймання (правка = скасування `C/CA`, потім `P/BO` з тим самим `id`), `parts/updateSchedules` при зміні розкладу, повна вигрузка раз на 10 хв (прапорець вимкнено). Відповідь МІС не перевіряється за HTTP-статусом: успіх = JSON-об'єкт; повторів немає (Polly відсутній, `Attempts=0`). Висновок NOTES: потрібні ідемпотентний upsert, власний журнал необроблених, reconcile.
- Контур B (проєкт): аутбокс у МІС без тригерів (воркер 30-60 с із вікном `watermark - 10 хв`, хеш подання сутності, нічна повна звірка), `GET /events?cursor&limit<=100` (pull) і push `POST /patient-data/events` з HMAC, ідемпотентність по `event_id`, повтори з наростаючою паузою, retention 14 діб, прострочений курсор -> 410 `cursor_expired`. Подія без ПД (id + тип зміни `created|updated|withdrawn` + `version`); MedOne після події робить точковий fetch (SLA ≤ 60 с). Додатково `GET /sync/snapshot` для довантаження.
- Агрегація (MedRecord): MedOne тримає незмінні знімки джерел (`SourceRecord`, append-only, `payloadHash`, `seq`) і вичислюване подання; ручне «Оновити»; статус свіжості «Актуально / Може бути застарілим / Не перевірено» (TTL по виду даних).

### 1.4 Ідентифікація пацієнта і зв'язок з ЄСОЗ

- Контур A: слабка ідентифікація. `person_id` порталу -> `Person.ExternalId` МІС. Матчинг карти на боці МІС: ПІБ (підрядок, чутливий до регістру) + дата народження, далі «зелені» карти з eHealth id; зміна ПІБ дає дубль картки; ЄСОЗ person_id не бере участі.
- Контур B: `ClinicLink` (профіль <-> картка МІС) з трьома станами `verified | pending_clinic | not_found`. Створюється через `POST /patients/match` (телефон + дата народження + прізвище, ліміти 60/хв на ключ, 5/год на телефон, відповідь лише `{patientId, maskedName, confidence}`), далі OTP на телефон з картки і `POST /patient-links` (`patient_link` з доказом, рівнем, часом, відкликанням). `misPatientId` клієнту ніколи не віддається.
- Зв'язка з ЄСОЗ: МІС віддає `externalIds[]` (system=ehealth, type=person/encounter/episode/medication_request/service_request/declaration...), `ehd_person.ehealth_id`. MedOne зіставляє записи з даними eHealth по рівнях: 1) `ehealthId`, 2) бізнес-номер (рецепт, направлення, декларація), 3) евристика (тип + дата ±1 день + організація + лікар + код) з порогами 0.85/0.6. Не зливати за ПІБ/датою народження; знімок eHealth приймається лише якщо `personId` збігається з профілем.

### 1.5 Права, згоди, видимість

- На стороні МІС сервер застосовує allowlist видимості (G1-G8): запис фіналізований (не чернетка, передано в ЄСОЗ або «не потребує передачі»), чутлива група (ВІЛ/психіатрія) за замовчуванням прихована (`hide | stepup | show`), denylist полів, «внесено помилково» -> tombstone, ручний `visibility_override` hold/release (результати з відкладеною видачею).
- На стороні MedOne: whitelist полів по виду до запису в БД, а не приховування в UI; доступ = профіль акаунта + `ClinicLink.verified` + згода `health_data_processing` + `EhealthLink.connected` для даних eHealth; чужий профіль -> 404 без розкриття існування.
- Типи згод платформи: `offer`, `privacy`, `health_data_processing`, `pharmacy_data_sharing`, `ehealth`, `marketing`. Правова підстава передачі МІС -> MedOne залишається відкритим питанням MedLink (№10).

### 1.6 Конфлікти та оновлення

- Правила на рівні поля (`field_rule`, дані, версіоновані): юридичні статуси (декларація, статус рецепта/направлення) за eHealth; клінічні деталі візиту, дозування, МНН, висновок за МІС; довідкові поля «останній виграє» лише якщо безпечно. Усе без явного правила = `never-merge`.
- Конфлікти типів `value | existence | identity | stale_authority`; нічого не перезаписується, показується «Розбіжність» лише для клінічних/юридичних розбіжностей; черга в адмінці.
- Для контуру A: `updateReserv` приходить багаторазово з тим самим `id` -> upsert; `updateSchedules` = заміна всього майбутнього набору для (`provider_id`, `schedules_id`); холд 11 хв веде MedOne (МІС його надійно не знімає); `period_*` без офсету, інакше `FATAL`.

### 1.7 Безпека каналу

- Контур A: у МІС `api/simplex/*` анонімний (`[AllowAnonymous]`); вихідна автентифікація: статичний Bearer + `X-API-TimeStamp` без підпису. Пропозиція NOTES: `X-Api-Key` + `X-Timestamp` + `X-Signature = v1=hex(HMAC_SHA256(secret, ts \n METHOD \n path \n sha256(body)))`, вікно 300 с, спершу log-only, IP allow-list.
- Контур B (ТЗ §4): HMAC-SHA256 з `X-Key-Id`, `X-Timestamp`, `X-Nonce` (кеш 10 хв), `X-Signature`, два активні секрети для ротації, ключ прив'язаний до allowlist організацій і scope (`read`, `events`); `X-Organization-Id`, `X-Person-Ref`, `X-Request-Id`; усі шляхи `/patients/{id}/...` (захист від IDOR); `Cache-Control: no-store`; аудит `access_log` без тіл; помилки RFC 9457 зі стабільним `code`; sidecar під роллю `medone_pd_ro` на реплiці.
- Агент: лише вихідний mTLS, підписаний маніфест іменованих операцій, ключі БД не залишають заклад, перевірка відбитків процедур при підключенні.

### 1.8 Емулятор

`services\medlink-emulator` (.NET, EF Core, схема `mlemu` або in-memory): стенд-ін МІС для контуру A. Реалізує 5 вхідних викликів `/api/simplex/sync/*` (reserve, reserve/cancellation, create, cancel, photo/get) зі справжньою логікою (холд 11 хв, конфлікти `FATAL`, матчинг картки); сам штовхає на портал 6 викликів (`updateReserv`, `parts/updateSchedules`, `deleteSchedules`, `display-schedule`, `services`, `setDataBySlot`) через аутбокс з диспетчером; режими автентифікації `Bearer` і `Hmac`; адмін-API під `X-Admin-Key` (404, якщо ключ не заданий): `seed`, `force-update`, створення/скасування приймань «як співробітник МІС», `republish/remove/display` розкладу, перегляд аутбокса. Детермінований синтетичний набір даних (`SeedStartDate`) і заготовка читання з тестової БД МІС (`MisDbDataSource`, не реалізовано). Є тести: контракт, вхідні виклики, push, seeder. Недоліки: контуру B (медичні дані) немає, відмов/затримок/дублів не моделює.

---

## 2. Наша МІС: що доступно

### 2.1 Загальна картина

SimplexMed 2.0 на сервері `mfx-dev` (Accuracy 3.0.1 + надбудова SIMPLEX): `simplex-api` (NestJS, порт 3120, лише 127.0.0.1 за nginx, префікс `/api`), `simplex-staff` (Next.js), `simplex-admin`. БД PostgreSQL віддалена (через `DbService`: `misPool`). Це по суті **шлюз до eHealth + локальний кеш**, а не повна клінічна МІС: ~7,9 тис. рядків коду, з них 4,9 тис. `ehealth.service.ts`. Основні дані пацієнта, візитів, рецептів, декларацій живуть в ЄСОЗ; локально є кеш і мінімальний реєстр пацієнтів.

Модулі API: `auth` (двофакторний вхід, сесії, eHealth OAuth, токени AES-256-GCM), `ehealth` (72 маршрути: словники, Event manager, пацієнти/епізоди/взаємодії/рецепти/направлення/плани лікування/декларації/approvals, async jobs 202), `clinical` (пошук пацієнтів, довідники МКХ-10/ICPC-2, статистика; створення локального пацієнта і взаємодії навмисно вимкнено 501), `health`.

### 2.2 Дані за реально знайденими в коді таблицями

| Схема.таблиця | Що зберігає | Важливі колонки |
|---|---|---|
| `patient.patients` | локальний реєстр пацієнтів закладу | `id`, `legal_entity_id`, `first_name/last_name/second_name`, `birth_date`, `gender`, `tax_id`, `unzr`, `phones` (jsonb), `email`, `ehealth_sync_status`, `dracsg_verification_status`, `drfo_verification_status` |
| `patient.declarations` | декларації | `patient_id`, `declaration_number`, `status`, `start_date` |
| `ehealth_cache.persons` | кеш особи ЄСОЗ | `id` (person_id), ПІБ, `birth_date`, `tax_id`, `raw_json` |
| `ehealth_cache.declarations` | кеш декларацій | `id`, `declaration_number`, `patient_id`, `employee_id`, `legal_entity_id`, `division_id`, `status`, `start_date`, `end_date`, `scope` |
| `ehealth_cache.encounters` | кеш взаємодій | `id`, `performer_employee_id`, `performer_legal_entity_id`, `encounter_date`, `encounter_type`, `status`, `raw_json` |
| `ehealth_cache.medication_requests` | кеш рецептів | `request_number`, `patient_id`, `employee_id`, `status`, `medication_code/name`, `dosage_instruction`, `program_id/name`, `raw_json` |
| `ehealth_cache.service_requests` | кеш направлень | `request_number`, `requester_employee_id`, `status`, `raw_json` |
| `ehealth_cache.care_plans`, `medical_events`, `event_subscriptions` | плани лікування; журнал Event manager (`entity_type`, `event_type`, `event_time`, `properties`); підписка Event manager (фоновий збирач раз на 60 с) | - |
| `audit.ehealth_logs`, `audit.ehealth_async_jobs` | журнал викликів, async jobs (202) | `legal_entity_id`, `patient_id`, `operation`, `status` |
| `org.legal_entities`, `staff.employees`, `auth.*`, `catalogs.*` | заклад, співробітники (+ eHealth id), користувачі, довідники | - |

Таблиці з повної схеми-проєкту (`simplexmed_2.0_full_schema.sql`: `clinical.episodes/encounters/conditions/immunizations`, `orders.referrals/prescriptions/care_plans`, `diagnostic.*`, `conclusions.medical_conclusions`, `patient.access_consents`) у коді API **не знайдені як використовувані** (запитів немає, окрім `patient.patients`). Вважати їх планом, а не наявним станом; реальний стан БД перевірити на сервері окремо.

### 2.3 Чого в нашій МІС немає (з погляду пацієнтського кабінету)

| Потреба кабінету | Стан у МІС |
|---|---|
| Розклад, слоти, запис на прийом, послуги/прайс | немає (у концепції §2.2 «Модуль розкладу» заплановано, у коді жодного) |
| Рахунки, оплати | немає (план: `billing`) |
| ЛІС, результати аналізів поза ЄСОЗ | немає (diagnostic report лише як ЄСОЗ-сутність) |
| Друковані форми, PDF документів | немає (printout-form рецепта береться з ЄСОЗ) |
| Власний аутбокс/вебхуки, API для зовнішніх споживачів | немає; є лише Event manager ЄСОЗ як вхід |
| Рівні видимості «що бачить пацієнт» | немає, `patient.access_consents` — про доступ лікарів |
| Нормалізований телефон, індекс для match | `phones` jsonb без індексу |

Висновок: більшість того, що MedOne бере з МІС по контуру B, для нас **дублює те, що кабінет уже вміє отримувати напряму з ЄСОЗ** під токеном пацієнта (PIS API: person, декларації, запити). Додаткову цінність МІС дає лише те, чого в ЄСОЗ для пацієнта немає чи немає в ПІС API: розклад і запис на прийом, заклад-специфічні документи/висновки, результати та вкладення поза ЄСОЗ, рахунки, нагадування.

---

## 3. Інтерфейс адаптера джерельної МІС для «Плексі»

Мета: нейтральний контракт `patient-source/v1`, незалежний від нашої МІС, MedLink чи FHIR; «Плексі» і майбутній MFX залежать лише від нього. Усе МІС-специфічне живе в драйвері. Використано ідеї MedOne: `IMisDriver` + `Capabilities`, нейтральний контракт без назв таблиць, єдиний блок на запис, tombstone, pull + push, ідемпотентність.

### 3.1 Принципи

1. Лише читання медичних даних і довідкових розкладів; єдині записи в МІС: запис на прийом (hold/create/cancel) і згоди/зв'язок.
2. Пацієнт бачить лише те, що МІС явно позначила видимим (allowlist на боці джерела), кабінет додатково тримає whitelist полів.
3. Дані ЄСОЗ не беруться з МІС для юридичних статусів: авторитетний — eHealth (ПІС API), МІС — клінічні деталі (правила MedRecord §5 можна взяти за основу).
4. Недоступність МІС не ламає кабінет (штамп свіжості замість помилки).
5. Інтерфейс підключаємий: драйвер обирається конфігурацією тенанта (`source_driver`), без змін коду кабінету.

### 3.2 Абстракція в коді (Python, у стилі `backend/ehealth_pis/`, лише stdlib)

```
backend/source_mis/
  contract.py     dataclass-и: SourcePatientRef, Appointment, Encounter, Referral, Prescription, Document,
                  DiagnosticReport, Immunization, SickLeave, Declaration, ChangeEvent, Page
  base.py         class SourceMisDriver(Protocol): key, capabilities, методи нижче
  registry.py     вибір драйвера за тенантом (config)
  drivers/
    simplexmis.py     драйвер нашої МІС (HTTP до patient-source/v1)
    noop.py           MIS не підключено: capabilities = 0
    fixture.py        читання з JSON-файлів (для тестів і емулятора)
    (пізніше) medlink_patient_data.py, medlink_legacy_sync.py, fhir.py
  signing.py      HMAC-підпис запитів і перевірка push-подій
  sync.py         ingest: знімки, upsert, курсор, свіжість, tombstone
```

`Capabilities` (бітові прапорці): `PATIENT_LINK`, `APPOINTMENTS_READ`, `BOOKING` (hold/create/cancel), `SLOTS`, `ENCOUNTERS`, `PRESCRIPTIONS`, `REFERRALS`, `DOCUMENTS`, `DOCUMENT_CONTENT`, `DIAGNOSTIC_REPORTS`, `IMMUNIZATIONS`, `SICK_LEAVES`, `DECLARATIONS`, `EVENTS_PULL`, `EVENTS_PUSH`, `INVOICES`. Інтерфейс користувача показує лише підтримане.

Методи драйвера (усі приймають `link` = непрозорий `source_patient_ref`, що виданий драйвером):

| Метод | Призначення |
|---|---|
| `capabilities() -> flags` / `ping()` | можливості, перевірка доступності |
| `find_candidates(phone, birth_date, last_name, ehealth_person_id?, tax_id?) -> [candidate]` | пошук картки, за замовчуванням сильний ключ `ehealth_person_id` |
| `create_link(account_ref, candidate_id, proof) -> link`, `revoke_link(link)` | зв'язка акаунт/профіль <-> картка, із доказом (OTP) |
| `get_patient(link)` | мінімальна демографія, `externalIds` |
| `list_*` (appointments, encounters, prescriptions, referrals, documents, diagnostic_reports, immunizations, sick_leaves, declarations) | keyset-пагінація `cursor+limit<=100`, `If-None-Match` по `version` |
| `get_*_detail(link, id)`, `get_document_content(link, id, format)` | деталі, потік вмісту |
| `list_slots(...)`, `hold(...)`, `release(...)`, `book(...)`, `cancel(...)` | запис на прийом, коли є `BOOKING` |
| `poll_events(cursor, limit) -> (events, next_cursor)` | pull-стрічка |
| `verify_push(headers, body) -> events` | перевірка підпису вхідного push |
| `snapshot(link, entity_type, cursor)` | повне довантаження |

### 3.3 Єдиний блок запису (для злиття з ЄСОЗ і тестів)

```json
{ "sourceId": "...", "entityType": "encounter",
  "externalIds": [{"system":"ehealth","type":"encounter","value":"<uuid>"}],
  "status": {"code":"completed","raw":"...","changedAt":"2026-10-01T10:00:00+03:00"},
  "sync": {"system":"ehealth","status":"transferred","syncedAt":"...","complete":true},
  "version": "<hash>", "modifiedAt": "...", "finalized": true,
  "origin": "clinic|external", "visibility": "patient" }
```

Tombstone: `{sourceId, entityType, status:"withdrawn", changedAt}` без вмісту. Дати з офсетом Europe/Kyiv. Помилки RFC 9457 зі стабільним `code`.

### 3.4 Ендпоінти джерела (`/api/patient-source/v1`) і події

| Метод і шлях | Примітка |
|---|---|
| `GET /capabilities` | версія, розділи, режим чутливих даних |
| `POST /patients/match` | `{phone, birthDate, lastName, firstName, ehealthPersonId?}` -> `[{candidateId, maskedName, confidence}]`; ліміти |
| `POST /patient-links`, `DELETE /patient-links/{id}` | зв'язок із доказом; відкликання шле подію `link.revoked` |
| `GET /patients/{id}` | мінімум демографії + `externalIds` |
| `GET /patients/{id}/{appointments|encounters|prescriptions|referrals|documents|diagnostic-reports|immunizations|sick-leaves|declarations}` | списки, keyset |
| `GET /patients/{id}/documents/{docId}/content?format=pdf|html` | потік |
| `GET /schedule/slots`, `POST /appointments/hold`, `/book`, `/cancel` | лише для `BOOKING` (аналог контуру A, без його вад: офсет у часі, ідемпотентність) |
| `GET /events?cursor&limit` | pull; курсор непрозорий; 410 `cursor_expired` |
| `GET /sync/snapshot` | довантаження |
| push `POST {cabinet-base-url}/source-events` | HMAC, `event_id` для дедуплікації |

Типи подій (мінімум): `entity.changed` із полями `entityType`, `entityId`, `change` (`created|updated|withdrawn`), `version`, `patientRef`; `link.revoked`. Без персональних даних у тілі.

### 3.5 Модель згод

Окремо від входу в ЄСОЗ. Рекомендована модель (по мотивах MedOne, але простіша):

| Згода | Зміст | Де фіксується |
|---|---|---|
| `source_mis_link:<tenant>` | пацієнт дозволяє кабінету зв'язати профіль з карткою в закладі X і читати дані | кабінет (`pis_core`), версія тексту, час, IP-хеш; у МІС `patient_link` з доказом (OTP) |
| `source_mis_scope` | категорії (прийоми, візити/діагнози, рецепти, направлення, документи, результати, щеплення, лікарняні) | кабінет; передається в запиті як `scope` і фільтрується в МІС |
| `sensitive_step_up` | показ чутливої групи лише після додаткового підтвердження | кабінет -> `X-Stepup-Token` |
| `marketing`/`reminders` | окремо, за замовчуванням вимкнено | кабінет |

Правила: відкликання діє негайно (МІС перестає віддавати, кабінет видаляє знімки payload протягом 24 год, лишаючи метадані аудиту); чужий профіль -> 404; кожне читання логується в обох системах без тіл; згода за дитину/опікуна — лише при підтвердженому зв'язку довіреної особи (як у ПІС).

### 3.6 Ідентифікація

- Сильний ключ: `ehealth person_id` (ми його отримуємо від ЄСОЗ після входу в ПІС) = `patient.patients.ehealth_id` / `ehealth_cache.persons.id` у МІС. Це точний збіг без нечіткого матчингу.
- Слабкий резерв: `tax_id` (РНОКПП), `unzr`, далі телефон + дата народження + прізвище (як `match` у MedOne) з обов'язковим OTP на телефон картки. Нечіткий збіг ніколи не лінкується мовчки: `pending_clinic`.
- Пара `source_patient_ref` генерується драйвером, клієнту не віддається.

### 3.7 Конфлікти

Перенести модель MedRecord: знімки незмінні, поле має правило `authority | union | latest-safe | never-merge`, розбіжність зберігається, лише для клінічних/юридичних показується; метрика `stale_authority` (МІС каже «активний», ЄСОЗ вже «погашений»). Для МВП достатньо двох правил: статус рецепта/направлення/декларації від ЄСОЗ, клінічні поля від МІС.

### 3.8 Безпека каналу

1. HMAC-SHA256 на кожен запит і на push: `X-Key-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature: v1=hex(HMAC(secret, METHOD\nPATH?QUERY\nTs\nNonce\nSHA256(body)))`, вікно ±300 с, захист від повтору через кеш nonce 10 хв, порівняння сталого часу, два активні секрети для ротації. Секрети лише у змінних середовища (за правилами репозиторію).
2. TLS 1.2+, HSTS, `no-store`; опційно mTLS і IP allow-list (канал сервер-сервер: кабінет -> МІС і навпаки).
3. Ключ прив'язаний до тенанта і scope; `X-Person-Ref` обов'язковий, усі шляхи в межах пацієнта, чужий запис -> 404.
4. Мережа: МІС і ПІС у різних сегментах (концепція `02_Разделение_баз`: прямий SQL заборонено), ліміти 120 запитів/хв на ключ, `match` 60/хв, 5/год на телефон.
5. Аудит у кожній системі (ключ, тенант, особа, пацієнт, операція, код, час, хеш IP), логи без ПД.
6. Для закладів без публічного входу пізніше — агент з вихідним каналом (ідея MedOne `mis-agent`), але не в P0-P1.
7. Для нашої МІС: `simplex-api` слухає лише 127.0.0.1 за nginx; нове API ставити під окремим префіксом і окремим сервер-блоком із allow-list, не під сесійними гардами співробітників (`session.guard`).

---

## 4. Мапінг сутностей `patient-source/v1` -> наша МІС

Позначки: [Є] уже є в БД/API; [КЕШ] є кеш ЄСОЗ, `raw_json`; [ПРО] у схемі-проєкті, у коді не використано; [НЕМА] нема.

| Сутність | Джерело в нашій МІС | Стан | Примітка |
|---|---|---|---|
| Пацієнт, `externalIds.person` | `patient.patients` (+`ehealth_id` у проєкті), `ehealth_cache.persons.id` | [Є]/[КЕШ] | `ehealth_id` у `patient.patients` треба підтвердити в живій БД; телефон у jsonb `phones` |
| Зв'язок/згода (`patient_link`) | нова таблиця в МІС, схема `patient_source` | [НЕМА] | `patient.access_consents` не підходить (доступ лікарів) |
| Декларація | `patient.declarations`, `ehealth_cache.declarations` | [Є]/[КЕШ] | авторитет — ЄСОЗ |
| Візит (encounter) | `ehealth_cache.encounters` (`raw_json`), `clinical.encounters` [ПРО] | [КЕШ] | діагнози тільки в `raw_json`; виписувати в плоску проєкцію |
| Діагноз | `raw_json` взаємодії; `clinical.conditions` [ПРО] | [КЕШ]/[ПРО] | `plainName` (простою мовою) немає |
| Епізод | `ehealth` маршрути `patients/:id/episodes`, `clinical.episodes` [ПРО] | [ПРО] | в основному на лету з ЄСОЗ |
| Рецепт | `ehealth_cache.medication_requests` | [КЕШ] | код погашення брати через `printout-form`/`resend-sms` маршрути; у списках не віддавати |
| Направлення | `ehealth_cache.service_requests` | [КЕШ] | номер для пацієнта = `request_number` |
| Плани лікування | `ehealth_cache.care_plans` | [КЕШ] | поза v1 контракту MedOne, додати як розширення |
| Звіти, спостереження | немає окремого кешу; `diagnostic.*` [ПРО] | [НЕМА] | P2 |
| Щеплення | `clinical.immunizations` [ПРО]; на лету з ЄСОЗ | [ПРО] | |
| Документи/висновки/PDF | немає; `conclusions.medical_conclusions` [ПРО] | [НЕМА] | потрібен рендер PDF |
| Лікарняні | немає | [НЕМА] | P2 |
| Прийоми, розклад, слоти | немає (`org.divisions`, `staff.employees` є) | [НЕМА] | новий модуль розкладу в МІС (`schedule.*`), без нього `BOOKING` вимкнено |
| Рахунки | `billing` [ПРО] | [НЕМА] | поза межами |
| Події | `ehealth_cache.medical_events` (Event manager ЄСОЗ), `audit.ehealth_async_jobs` | [Є] | джерело тригерів зміни, але не нашого аутбокса |
| Аудит | `audit.ehealth_logs`, `audit.access_logs` [ПРО] | [Є]/[ПРО] | потрібен `patient_source.access_log` |

Практичні наслідки: (1) аутбокс будувати на `ehealth_cache.*` з `updated_at` і на подіях Event manager, а не на тригерах по всіх таблицях; (2) кеш містить `raw_json` — для API потрібна нормалізована проєкція за whitelist, а не віддача сирих тіл (PHI, чужі поля); (3) ізоляція закладів уже є (`legal_entity_id`), використати як `X-Organization-Id`; (4) у `audit.ehealth_logs` тіла містять PHI (відомий відкладений пункт).

---

## 5. Емулятор джерельної МІС для автономного тестування «Плексі»

Мета: тестувати «Плексі» повністю без реальної МІС і без доступу до нашого сервера. Береться від MedOne: детермінований синтетичний набір, адмін-API, аутбокс, режими автентифікації, тести контракту. Додається: контур медичних даних, моделювання відмов, правила видимості.

### 5.1 Склад

Каталог `pis/tools/source_mis_emulator/` (не в коді кабінету), Python stdlib (`http.server`) або Flask, без зовнішніх залежностей понад вже наявні; сховище: SQLite-файл або in-memory; генерація з `seed`.

| Частина | Що робить |
|---|---|
| Публічне API | усі ендпоінти §3.4, ті самі підпис і заголовки, помилки RFC 9457 |
| Дані | організація, відділення, лікарі, 5-8 пацієнтів-персонажів (дорослий з декларацією, дитина з представником, пацієнт без `ehealth_id`, двійники для `pending_clinic`, пацієнт із чутливою групою), візити з діагнозами, рецепти в усіх статусах, направлення, документи (малі PDF/HTML), звіти зі спостереженнями, щеплення, лікарняні, декларації, розклад на 14 днів |
| Аутбокс/події | `GET /events` з курсором, push з підписом, повтори, дублікати, відставання |
| Адмін-API (`X-Admin-Key`) | `seed`, `reset`, `clock` (зсув часу), `patients/{id}/mutate` (змінити статус рецепта, підписати візит, відкликати запис -> tombstone), `outbox`, `force-push`, `faults` |
| Моделювання відмов | затримка, 500/503, обрив з'єднання, неправильний JSON, повторна подія, подія поза порядком, прострочений курсор (410), протермінований підпис, повторений nonce, 404 для чужого пацієнта, великий документ |
| Режими | `mode=full|appointments_only|none` (різні `capabilities`); `sensitive=hide|stepup|show` |
| Двосторонній ЄСОЗ-вузол | у тестових даних ті самі `ehealth` id, що й у sandbox/моках ПІС API, щоб перевіряти злиття за рівнями 1-3 |

### 5.2 Тести

- Контрактні: JSON Schema на кожну відповідь (з `patient-source.openapi.yaml`, який стане єдиним джерелом правди), золоті файли, семантичне порівняння.
- Підпис: невірний підпис, вікно часу, повтор nonce, ротація ключа.
- Пошук/зв'язок: збіг за `ehealth_person_id`, `tax_id`, телефон+ДН, неоднозначність, відкликання.
- Видимість: чернетка, «внесено помилково» -> tombstone, чутлива група, відкладений результат, чужий пацієнт.
- Свіжість і конфлікти: МІС «активний» vs ЄСОЗ «погашений», відсутній `ehealth_id`, пізніше з'явився.
- Стійкість: падіння МІС, відновлення з курсору, повне довантаження `snapshot`.
- Наскрізні (Playwright): прив'язка закладу, стрічка, документ, відкликання згоди.

### 5.3 Використання нашої реальної МІС

Той самий набір тестів проганяється проти драйвера `simplexmis` на тестовому тенанті `mfx-dev` (прапорець `SOURCE_DRIVER=simplexmis`), що доводить еквівалентність емулятора і реальності. `MisDbDataSource`-варіант MedOne (імпорт з реальної БД) не перенімаємо: ПІС не повинна читати БД МІС.

---

## 6. Що потрібно для подачі на тестування НСЗУ, а що розширення

| Питання | Висновок |
|---|---|
| Чи вимагає ТВ ПІС (наказ № 978, v2) зв'язку з МІС? | **Ні.** Усі розділи ТВ ПІС виконуються напряму з ЄСОЗ (PIS API) під токеном пацієнта. Для подачі на тестування нічого з цього документа не потрібно. |
| Що з цього документа входить у подачу | нічого; не включати в Додаток 1 і сценарії тестування |
| Що є розширенням | усе: адаптер `patient-source`, емулятор, згоди `source_mis_*`, стрічка подій, документи/звіти з МІС, запис на прийом |
| Ризики для подачі | (1) дані МІС поза ЄСОЗ можуть бути вилучені з показу під час тестування: прапорець `SOURCE_MIS_ENABLED=false` за замовчуванням і в сценарії НСЗУ; (2) окремий текст згоди й політика конфіденційності для даних МІС (за ЗУ про захист ПД, ТВ про згоду пацієнта); (3) не змішувати в одному екрані дані ЄСОЗ і МІС без позначки джерела; (4) застосунок без підключеної МІС має працювати як повноцінна ПІС |
| Для MFX/white-label | контракт `patient-source/v1` і драйвер — той самий шар, який MFX зможе підключити до будь-якої МІС |

---

## 7. Поетапний план

### P0 — основа (без залежності від реальної МІС; не блокує подачу НСЗУ)

1. Затвердити `patient-source/v1` як OpenAPI-файл у `pis/docs/` і формат запису (§3.3), правила видимості, модель згод. Рішення про прапорець `SOURCE_MIS_ENABLED` (за замовчуванням вимкнено).
2. `backend/source_mis/` з `contract.py`, `base.py`, `registry.py`, драйвер `noop` і `fixture`; тести.
3. Емулятор (§5): підпис, `capabilities`, `match`, `patient-links`, `patients`, `encounters`, `prescriptions`, `referrals`, `documents` (малі), `events` (pull), `seed/reset/mutate`, відмови базових типів.
4. Міграція `pis_core`: `source_link`, `source_snapshot`, `source_sync_state`, `source_consent` (append-only, зашифрований payload, свіжість).
5. Мінімальна поверхня кабінету за прапорцем: блок «Мої заклади» (зв'язок + згода), стрічка візитів з позначкою джерела і свіжості.
6. Перевірка: вся ПІС-функціональність працює при `noop`/вимкненому прапорці; документація в Додатку.

### P1 — реальна МІС і повнота

1. У МІС (за погодженням, окрема сесія): модуль `patient-source` у `simplex-api` (окремий префікс, HMAC-гард, аудит), проєкція з `ehealth_cache.*` і `patient.*`, таблиці `patient_source.{link,outbox,access_log,visibility_override}`, нормалізований телефон і індекси для match.
2. Драйвер `simplexmis`, push + pull, ідемпотентний upsert, reconcile, свіжість.
3. Злиття з ЄСОЗ за рівнями 1-3 і правила поля (§3.7), «Розбіжність» у UI, черга в адмінці.
4. Документи (HTML/PDF), звіти, щеплення, лікарняні (коли з'являться в МІС).
5. Прогін контрактних тестів на `mfx-dev` через емулятор і реальність.

### P2 — розширення

1. Розклад і запис на прийом: модуль розкладу в МІС, `BOOKING` (hold/book/cancel), нагадування; можливе повторне використання схеми `legacy-sync` лише для мапінгу полів (час із офсетом, ідемпотентність).
2. Рахунки/оплати, ЛІС, прикріплені зображення, чутливі групи зі step-up.
3. Агент у закладі для МІС без публічного API; драйвери `medlink_patient_data`, `fhir`.
4. Передача шару MFX: винести `source_mis` у бібліотеку, наступний рівень white-label (теми й конфіг тенанта).

---

## 8. Відкриті питання

1. Фактичний стан таблиць у живій БД `mfx-dev` (чи є `clinical.*`, `orders.*`, `patient.access_consents`, колонка `ehealth_id` у `patient.patients`).
2. Чи буде розклад/запис на прийом у нашій МІС і коли (визначає `BOOKING`).
3. Правова підстава та текст згоди на передачу з МІС в кабінет; хто відповідає за видимість (`visibility_override`).
4. Визначення «візит підписано» для закладів без ЄСОЗ (аналог відкритого питання MedLink №1).
5. Місце розгортання нового API (в `simplex-api` чи окремий sidecar із роллю тільки читання).
6. Політика чутливих груп (ВІЛ/психіатрія) для нас.
7. Чи залишати клієнту MFX власне сховище знімків, чи читати з джерела наживо.
