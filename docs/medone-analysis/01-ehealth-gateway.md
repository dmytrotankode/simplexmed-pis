# 01. Шлюз до ЕСОЗ: MedOne `pis-gateway` vs «Плексі» `ehealth_pis`

Дата аналізу: 15.10.2026. Лише читання коду й документів (нічого не запускалося, `dotnet`/`pnpm` не викликались).
Облікових даних не відкривалося: у `seed-ehealth-profile.*.json` переглянуто лише **імена** ключів. Значень секретів у звіті немає.

Шляхи MedOne вказані відносно кореня `C:\__MEDLINK___\PIS\medone\` (далі `GW` = `services/pis-gateway/src/MedOne.PisGateway/`).
Шляхи Плексі — відносно `C:\SIMPLEX_2.1\pis\`.

Прочитані джерела MedOne: весь `GW` (Auth, Upstream, Signing, SignUp, Data, Dodatok1, Profiles, Configuration), `docs/ehealth-signing-checklist.md`,
`docs/ehealth-verification-guide.md`, `docs/dodatok1-coverage.md`, `docs/ehealth-banned-email-domains.md`,
`services/platform/src/MedOne.Modules.Admin/{Secrets/SecretStore.cs,Services/EhealthProfileService.cs}`, `services/platform/src/MedOne.BuildingBlocks/Ehealth/PisScopeMatrix.cs`,
а також `..\analysis\raw\{13_ehealth_pis_preprod,17_prev_vendor_pis_signup,25_live_test_2026-10-12,16_esoz_signup_shape}`.
`services/mis-agent`, `services/medlink-emulator`, `contracts/medone-platform.openapi.yaml` до шлюзу ЕСОЗ не стосуються (не аналізувались).

---

## 0. Головне (для тих, хто читає лише це)

1. **P0, у Плексі немає скоупа `person_request:sign_pis`** (`backend/ehealth_pis/config.py`, `DEFAULT_SCOPES`). На живому preprod MedOne 12.10.2026 `PATCH /api/pis/person_requests/{id}/actions/complete` без нього дає
   `403 Missing allowances: person_request:sign_pis`. Тобто «Зміна персональних даних з підписом» у Плексі за замовчуванням не завершується.
   Додати скоуп мало: є ще пастка з **approval** (див. 3.2): повторний вхід із розширеним `scope` існуючий approval не розширює, пацієнту треба відкликати доступ Плексі і увійти знову.
2. **P0, код підтвердження SMS `int()`** (`client.py:approve_auth_method_request`): код із ведучим нулем (`0123`) стає `123`. MedOne надсилає рядок, якщо код починається з `0`, інакше число.
3. **P1, `sign-up_validation` до переходу в Auth UI** у Плексі немає (веб `index.html:submitSignUp` і `mobile/.../sign-up.tsx` після підпису одразу йдуть на Auth UI). У `docs/medone-analysis/06-clients.md`
   твердження «Плексі має це в `registration.py`» **хибне**: в `registration.py` лише коментар, виклику `POST /api/pis/sign-up_validation` немає ніде. Це 422 лише після редіректу з «Validation failed» без полів.
4. Інші знахідки MedOne, яких у нас немає, зібрані в розд. 4 (розбіжності) і 5 (що переносити).
5. Плексі **попереду** MedOne в: копіях документів (Initialize/Complete upload, валідація файлів), bulk-реєстрах і пошуку лікаря (PG-06 у MedOne не зроблено), «довірених особах» (URL), повному зборі всіх сторінок переліків.
   Переносити звідти нічого не потрібно.

---

## 1. Що є

### 1.1. Склад `GW`

| Підсистема | Файли | Призначення |
|---|---|---|
| OAuth, nonce, state, токени | `EhealthEndpoints.cs`, `Auth/AuthServices.cs`, `Upstream/EhealthClients.cs` | nonce від ЕСОЗ, одноразовий state, обмін code, refresh, logout, сховище токенів |
| Підписання | `Signing/{SigningCore,DeclarationRequestFlow,PersonRequestFlow,PisAccountActions,OwnApproval,SignatureFormat,SigningEndpoints}.cs` | потоки декларації, зміни даних, методів автентифікації, розірвання, відкликання доступу |
| Реєстрація | `SignUp/{SignUpContent,SignUpValidator,RegistrationRules,SignUpEndpoints}.cs`, `Upstream/SignUpClients.cs` | форма, контент для підпису, `sign-up_validation`, адреси, заборонені домени |
| Читання ПІС | `Data/{PisReadService,PisMappers,PisJson,DeclarationService,DictionaryLabels,DictionaryWarmup}.cs` | перегляд даних, довідники, маски |
| Помилки | `Dodatok1/*` (+`dodatok1.table.json`, 373 рядки / 43 методи), `Auth/ErrorMapper.cs`, `Upstream/UpstreamErrors.cs` | тексти Додатка 1, санітизація помилок |
| КЕП-проксі | `KepProxy.cs`, `EhealthEndpoints.cs:KepProxy`, `Upstream/EhealthClients.cs:PublicAddressConnector` | проксі OCSP/TSP/CMP для бібліотеки ІІТ |
| Діагностика | `Data/{EhealthTrace,EhealthTraceHandler,TraceHar,TraceRedactor,TraceEndpoints,DiagCapture}.cs` | запис викликів до ЕСОЗ, експорт HAR для Support |
| Профіль і секрети | `EhealthProfile.cs`, `Profiles/AdminData.cs`, `Configuration/GatewayOptions.cs`, `Seed/*` | профіль із БД адмінки, `vault://` |

### 1.2. Методи ЕСОЗ, які реалізовані (за кодом і `Dodatok1Methods`/`dodatok1-coverage.md`)

Авторизація й токени (хост OAuth = `apiHost` профілю, за замовчуванням хост Auth UI `pis-auth-…`):

| Метод | HTTP | Примітка |
|---|---|---|
| PIS. Get nonce | `POST /oauth/nonce` `{client_id}` | відповідь `data.token` = JWT (HS512, aud `mithril-login`, ~15 хв). `client_secret` лише для `TRUSTED_PIS` |
| Patient sign-in / sign-up (через Auth UI) | редирект `GET {authUI}/sign-in` і `/sign-up?client_id&redirect_uri&scope&state&user_data` | `user_data` = Base64 підписаного вмісту |
| PIS. Exchange oAuth Code Grant | `POST /oauth/tokens` тіло `{"token":{grant_type:"authorization_code",client_id,client_secret,code,redirect_uri,scope}}` | код одноразовий, не повторюється |
| Renew access token | той самий endpoint, `grant_type=refresh_token` | `scope` не надсилається (ЕСОЗ бере з approval) |
| Logout | `POST /auth/logout`, Bearer, **без тіла** | |
| `sign-up_validation` | `POST {authUI}/api/pis/sign-up_validation` `{signed_content, signed_content_encoding:"base64"}` | 422 з `error.invalid[].entry/rules[]` до переходу в Auth UI |

Читання (`api-key` + Bearer; шляхи в `GatewayOptions.DataOptions`):

| Метод | Шлях | Скоуп |
|---|---|---|
| Get Person details | `GET /api/pis/person` | `person:details_pis` |
| Get Person verification details | `GET /api/pis/person/verification` | `person_verification:details_pis` |
| Get Person authentication methods | `GET /api/pis/person/authentication_methods` | `authentication_method:read_pis` |
| Get declarations / details | `GET /api/pis/declarations`, `/{id}` | `declaration:read_pis`, `declaration:details_pis` |
| Get Declaration requests / details | `GET /api/pis/declaration_requests`, `/{id}` | `declaration_request:read_pis`, `…:details_pis` |
| Get Person requests / details | `GET /api/pis/person_requests`, `/{id}` | `person_request:read_pis`, `…:details_pis` |
| Get Approvals / details | `GET /api/pis/apps?page_number=1&page_size=50`, `/{id}` | `app:read_pis` |
| Довідники, адреси | `GET /api/v2/dictionaries?name=`, `GET /api/uaddresses/{regions,districts,settlements}` | публічні, без Bearer |

Запис (ніколи не повторюється шлюзом, окремий HTTP-клієнт без retry):

| Метод | Шлях | Скоуп |
|---|---|---|
| Create Declaration request | `POST /api/pis/declaration_requests` `{employee_id, division_id}` | `declaration_request:write_pis` |
| Sign Declaration request | `PATCH …/{id}/actions/sign` `{signed_content, signed_content_encoding}` | `declaration_request:sign_pis` |
| Reject Declaration request | `PATCH …/{id}/actions/reject` | `declaration_request:reject_pis` |
| Initialize Update Person details | `POST /api/pis/person_requests` `{person, patient_signed:false, process_disclosure_data_consent}` | `person_request:write_pis` |
| Complete Update Person details | `PATCH …/{id}/actions/complete` | **`person_request:sign_pis`** (не `write`) |
| Reject Person request | `PATCH …/{id}/actions/reject` | `person_request:reject_pis` |
| Create authentication method request | `POST /api/pis/authentication_method_requests` `{authentication_method:{type:"OTP",phone_number,alias?}}` | `authentication_method_request:write_pis` |
| Approve | `PATCH …/{id}/actions/approve` `{verification_code}` | те саме |
| Resend OTP | **`POST`** `…/{id}/actions/resend_otp` (сторінка API перемагає бізнес-процес, який каже PATCH) | те саме |
| Update authentication method (alias) | `PATCH /api/pis/authentication_methods/{id}` `{alias}` | `authentication_method:write_pis` |
| Deactivate | `PATCH …/{id}/actions/deactivate` | `authentication_method:deactivate_pis` |
| Terminate declaration | `PATCH /api/pis/declarations/{id}/actions/terminate` `{reason_description?}` | `declaration:terminate_pis` |
| Delete approval | `DELETE /api/pis/apps/{id}` | `app:delete_pis` |

**Не реалізовано в MedOne:** Initialize/Complete Person documents upload (PG-09), bulk-реєстри (PG-06, доступу до Bulk немає), клієнт `TRUSTED_PIS` (74 рядки Додатка 1 позначено «не застосовно»), довірені особи.

### 1.3. Власні ендпоінти шлюзу (для платформи/браузера)

`POST /api/v1/ehealth/auth/{nonce,url,result,error,identity,identity/bind}`, `GET /auth/callback`, `POST /link/{refresh,disconnect}`,
`POST /sign-up/{prepare,validate}`, `GET /sign-up/config`, `GET /addresses/{regions,districts,settlements}`, `GET /dictionaries/{name}`,
`/data/*` (читання), `/sign/*` (запис), `/kep/proxy`, `GET /profile` (без секретів), `/diag/*` (трасування). Внутрішні виклики платформа -> шлюз захищені заголовком `X-Internal-Key` (порівняння за SHA-256 у сталий час; не налаштовано = 404).

---

## 2. Як працює

### 2.1. Вхід: nonce, підпис, state, обмін коду

1. `POST /auth/nonce`: шлюз просить nonce **у ЕСОЗ** (`/oauth/nonce`); власного nonce не генерує. Зберігає лише SHA-256 JWT і вікно 5 хв (або `exp` JWT, якщо коротший). Усі «голі» випадкові nonce, що були в першій версії, ЕСОЗ відхиляло (`JWT is invalid`).
2. Клієнт підписує **JSON `{"jwt":"<nonce>"}`** (КЕП CAdES-X Long, вбудовані дані, Base64). «Голий» JWT -> `422 $.signed_data: Malformed encoded content`. Це зафіксовано і в клієнтах (`apps/web/lib/kep/signing-config.ts`).
3. `POST /auth/url {signedNonce, mode: sign_in|sign_up, codeChallenge?, linkRef?, intent}`:
   - з підпису шлюз витягує nonce (регулярка по JWT, спершу `SignedCms`, потім сирі байти для ГОСТ/ДСТУ-підписів, які .NET не декодує);
   - логує рівень підпису (`CadesInspector`: `x-long`/`c`/`t`/`bes`, за OID `…16.2.23` і `…16.2.24`), опційно відхиляє не-X-Long (`Ehealth:Auth:RequireCadesXLong`, за замовчуванням вимкнено, бо живого ключа ще не було);
   - **спалює nonce в одному умовному UPDATE і прив'язує його до `state`**: невдалий запит не «спалює» nonce, один nonce не може обслужити два state;
   - створює `state = <statePrefix><32 випадкових байти base64url>`, у БД лише SHA-256, дійсний 10 хв, одноразовий;
   - формує URL Auth UI. `scope` у ньому = **мінімально потрібні скоупи** (див. 2.4).
4. `GET /auth/callback?code&state`: одноразово споживає state (conditional UPDATE), далі `ct = CancellationToken.None`, щоб обрив браузера не втратив пару токенів. `redirect_uri` в обміні = той, що був у state. Після успіху: токени шифруються і зберігаються, GET person (best effort) доповнює особу, статус `connected`.
5. `redirect_uri` зареєстровано на **чужому** домені партнера (preprod); там ретранслятор пересилає `code/state` на callback шлюзу за префіксом `state` (`mo_`). `PickRedirectUri` бере лише ті URI, які є в `redirectUris` профілю (інакше ЕСОЗ -> 401 «redirection URI … does not match»).
6. Результат читається через `/auth/result` (PKCE: `Base64Url(SHA-256(verifier))` проти `codeChallenge`, сталий час) або внутрішнім `/auth/identity`. Нічого з токенів назовні не віддається, лише статуси.

### 2.2. Токени: сховище, шифрування, оновлення

- Таблиця `pis_gateway.tokens`: `AccessProtected`, `RefreshProtected` (ASP.NET Data Protection, purpose `MedOne.PisGateway.Tokens.v1`), `AccessExpiresAt`, `Scope`, `LinkRef` (`acc:<id акаунта>`), `StateId`, `RevokedAt`. Ключове кільце (`DataProtection:KeysPath`) спільне з Admin; у прод плануються KMS/Vault.
- Токен **ніколи не повертається** по HTTP; його відкриває лише код усередині процесу (`LinkApiSession.OpenAsync`).
- Оновлення: заздалегідь за `RenewBeforeSeconds`=60 с до `expires_at` і **по 401** (один раз за запуск: `RenewBudget`). Refresh виконується під **мьютексом на лінк** (`LinkRefreshLocks`): refresh-токен одноразовий, тому паралельні запити не мають «спалити» один токен двічі. Після блокування рядок перечитується: якщо його вже оновив інший, повторного refresh немає.
- Нова пара: старий рядок отримує `RevokedAt`, новий успадковує `StateId`; якщо ЕСОЗ не повернув новий `refresh_token`, лишається старий.
- Рішення при 401 (`PisFailure`, `PisWriteFailure`): 401 без придатного `api-key` -> `unavailable` (токен не винен, refresh не витрачається); 401 **після** успішного refresh -> `forbidden` (не просимо пацієнта входити знову); refresh не вдався через недоступність -> `unavailable`; інакше -> `reauth_required`.
- Повторювані записи: після refresh повтор дозволено лише для 401 (ЕСОЗ відхилив токен до обробки).
- Таймаут запиту до ЕСОЗ береться з профілю (`timeouts.requestSeconds`, ТВ 1.3.2: не менше 60, у коді 1..300). Таймаут запису = `outcome_unknown` («запис міг пройти, перечитайте перелік, не повторюйте наосліп»).
- Logout (`DisconnectAsync`): якщо access прострочений, спершу refresh, потім `POST /auth/logout`; **локальні токени видаляються завжди** (навіть якщо ключове кільце втрачено або ЕСОЗ відмовив); результат `revokedUpstream: true|false|null`. Повтор безпечний.
- Відкликання **власного** approval: за `client_id` доступу в `GET /apps/{id}` (або за 401-пробою) шлюз сам робить Logout і видаляє токени (ТВ 3.8.2.1).

### 2.3. Заголовок `api-key` (критично для preprod)

`EhealthApiKey`: ключ додається **тільки** до https-викликів на дозволений хост ЕСОЗ зі шляхом, що містить `/api/` і не містить `/oauth/`. Значення: секрет профілю `apiKey` -> `Ehealth:Upstream:ApiKey:SecretRef` (vault://) -> `clientSecret` (Apiary: «api-key is a pis_client_secret»). Без нього ЕСОЗ (Kong) дає `401 access_denied`/`API-KEY header required` на всі `/api/pis/*` при цілком робочому вході. Якщо секрет недоступний, виклик іде без заголовка і помічається `api_key_not_set`/`api_key_unavailable`; **такий 401 не запускає refresh** і не вважається проблемою токена.

### 2.4. Скоупи (ТВ 1.4.3, «не більше, ніж потрібно»)

`PisScopeMatrix` (`platform/.../BuildingBlocks/Ehealth/PisScopeMatrix.cs`): таблиця «функція -> скоупи». `RequestedScopes.For(profile)` = скоупи профілю ∩ скоупи **увімкнених** функцій (модуль профілю ввімкнено і, для запису, увімкнено потік `Ehealth:Signing:Flows:*`).
Той самий рядок іде і в Auth UI (`scope=`), і в обмін коду. Скоупи профілю = стеля (22).

Функції: `person.view` (`person:details_pis`), `verification.view`, `auth_methods.view`, `person_requests.view` (`read`+`details`),
`person_request.change` (`write`+**`sign`**+`reject`), `auth_method_request.create`, `auth_method.change` (`write`+`deactivate`), `declarations.view`, `declaration_requests.view`,
`declaration_request.create` (`write`+`sign`+`reject`), `declaration.terminate`, `apps.view`, `apps.revoke` (`app:delete_pis`), `documents.upload` (`person_documents:write_pis`, ще не реалізовано, тому не запитується).

### 2.5. Що підписується

| Дія | Що саме підписується (UTF-8 JSON без BOM, Base64) | Як перевіряє шлюз до відправки |
|---|---|---|
| Вхід | `{"jwt":"<nonce ЕСОЗ>"}` | nonce знайдено і не використано; рівень CAdES |
| Реєстрація | `{"person":{…},"patient_signed":true,"process_disclosure_data_consent":true,"jwt":"<nonce>"}`; лише відомі ключі, порожні рядки **відкидаються**, `no_tax_id:false` ставиться явно, `tax_id` прибирається при `no_tax_id:true` | `SignUpValidator` (нижче) перед видачею nonce; після підпису `POST /sign-up/validate` |
| Декларація | `data_to_be_signed` з відповіді Create/Details **без змін** (порядок ключів, кирилиця й HTML не екрануються), єдина правка `person.patient_signed=true` (якщо прапорця немає в `person`, а є зверху, змінюється там) | `SignatureCheck`: підписані дані == підготовлені (байти, інакше `JsonNode.DeepEquals`), РНОКПП сертифіката == `person.tax_id` (крім випадку з `confidant_person`), опційно X-Long |
| Зміна ПД | поля запиту: `id,status,channel,person,patient_signed,process_disclosure_data_consent,content` у порядку відповіді ЕСОЗ, `patient_signed=true` | та сама перевірка |
| Методи автентифікації, розірвання, відкликання доступу | **не підписуються** (підтвердження в діалозі + OTP для методу) | рівень довіри платформи (L2 + КЕП/Дія не старше 10 хв) |

Підготовлений вміст кешується шифрованим (Data Protection) у пам'яті `PreparedMinutes`=60 хв; після рестарту будується заново з `GET details` (ЕСОЗ порівнює саме з деталями).
Створення декларації/запиту ЕСОЗ скасовує інші відкриті запити пацієнта, тому кеш переліків скидається після кожного запису (`Evict`).

### 2.6. Реєстрація (ТВ 3.5.4)

`SignUpValidator` (шлюз = авторитет, веб дзеркалить): вік >=14 (<14 відмова), 14-17 -> **рівно 2 документи** (особи + дієздатності), >=18 -> 1; типи документів реєстрації
(`PASSPORT, NATIONAL_ID, BIRTH_CERTIFICATE, TEMPORARY_CERTIFICATE, REFUGEE_CERTIFICATE, PERMANENT_RESIDENCE_PERMIT, COMPLEMENTARY_PROTECTION_CERTIFICATE, TEMPORARY_PASSPORT, BIRTH_CERTIFICATE_FOREIGN`),
типи дієздатності (`MARRIAGE_CERTIFICATE, DIVORCE_CERTIFICATE, COURT_DECISION_DIVORCE, COURT_DECISION_LEGAL_CAPACITY, GUARDIANSHIP_DECISION_LEGAL_CAPACITY, LEGAL_CAPACITY_DOCUMENT, STATE_REGISTER_EXTRACT`),
формати (`tax_id ^\d{10}$`, `unzr ^\d{8}-\d{5}$`, `secret ^[A-Za-zА-Яа-яҐґЇїІіЄє0-9]{6,20}$`, телефони `^\+38\d{10}$`, паспорт `^((?![ЫЪЭЁ])[А-ЯҐЇІЄ]{2})\d{6}$`, ID-картка `^\d{9}$`, zip `^\d{5}$`),
заборонені символи в іменах (`ЫЪЭЁыъэё@%&$^#`), `settlement_id` (UUID зі довідника ЕСОЗ) обов'язковий для UA, `settlement_type ∈ {CITY,SETTLEMENT,TOWNSHIP,VILLAGE}`, `street_type` обов'язковий, якщо є вулиця,
`phones[].type ∈ {MOBILE,LAND_LINE}`, рівно один метод автентифікації `OTP`, `emergency_contact` (ім'я, прізвище, телефон), `preferred_way_communication ∈ {phone,email}`.

Правила, виявлені на живому preprod (HAR попереднього постачальника, 422 від `sign-up_validation`), які ТВ не називає:
- **`issued_by` обов'язковий** для будь-якого документа (`required property issued_by was not present`), хоча ТВ 3.5.4.12.e каже «необов'язково»;
- **`unzr` обов'язковий для `NATIONAL_ID`** (`unzr is mandatory for document type NATIONAL_ID`);
- порожній рядок для ЕСОЗ = «присутнє» -> порожні `unzr/issued_by/zip` у підписаний JSON **не потрапляють**.

Також: домен e-mail перевіряється проти переліку (за замовчуванням `mail.ru, bk.ru, inbox.ru, list.ru, internet.ru, yandex.{ru,ua,by,kz,com}, ya.ru, rambler.ru`, піддомени теж, `.ru` як зона **не** блокується; читається з `admin.registration_settings`, кеш 15 с; немає БД -> діє типове значення, «збій не вимикає обов'язкову перевірку»; адмінка редагує перелік, кожна зміна в аудиті).
Текст відмови: «Електронна пошта з цього домену не приймається: домен входить до переліку заборонених (заблокованих) розпорядженнями НЦУ. Вкажіть адресу іншого поштового сервісу.»

### 2.7. Зміна персональних даних (ТВ 3.10.1)

- Запит містить **всю особу**: шлюз читає поточну (`GET /api/pis/person`, без кешу), залишає лише документовані ключі
  (`first_name,last_name,second_name,birth_date,birth_country,birth_settlement,gender,email,tax_id,no_tax_id,documents,addresses,phones,unzr,emergency_contact,preferred_way_communication`),
  для вкладених об'єктів теж лише документовані ключі (`additionalProperties=false` -> інакше 422), потім накладає зміни пацієнта і прибирає `null` та порожні рядки.
- **`secret` (кодове слово) не береться з поточних даних ніколи**: пацієнт вводить його сам при кожному запиті (ЕСОЗ вимагає його в запиті, а поточне значення MedOne не читає, не показує і не підставляє).
- `process_disclosure_data_consent` = явний вибір пацієнта (галочка), без неї запит не створюється; `patient_signed=false` при створенні, `true` лише в підписаному вмісті.
- У MedOne змінюється свідомо малий набір: e-mail, телефон, спосіб зв'язку, адреса проживання, екстрений контакт, кодове слово. ПІБ/документи/РНОКПП/УНЗР беруться з ЕСОЗ без змін (зміна документів вимагає сканів, яких у MedOne немає).
- Якщо ЕСОЗ вимагає скани (`urgent.documents[].is_uploaded=false`), `PendingDocuments` показуються, завершити не можна, лише «Скасувати заявку».

### 2.8. Декларація (ТВ 3.11.1)

- Лікарі: список із конфігурації (`Ehealth:Signing:Doctors:N:{EmployeeId,DivisionId,DoctorName,Speciality,ClinicName,DivisionName,DivisionAddress}`) + лікарі з попередніх запитів пацієнта (5 хв кеш). Пошуку за реєстрами немає (PG-06).
- Перед Create: перевіряються **скоупи всього потоку** (write+sign+reject) у approval (`OwnApproval`, `wholeFlow:true`), щоб не створити запит, який пацієнт не зможе завершити.
- Результат підпису: `signed` або `approved` (лікар має перевищений ліміт: до 7 діб на погодження). Номер декларації береться з `declaration_id` або зі свіжого переліку.
- Коди відмов: `person_not_verified`, `speciality_age`, `doctor_unavailable`, `signer_mismatch`, `content_mismatch`, `invalid_status`, `content_unavailable`.

### 2.9. Верифікація, довідники, пагінація, кеш

- **Верифікація**: напрями, які ПІС показує: `drfo, dracs_death, dracs_birth, nhs, unzr, dms_passport`; `mvs_passport`, `dracs_name_change`, `legal_capacity` не показуються ніколи. Статус `DOCUMENTS_TRIGGERED` (НСЗУ) -> повідомлення про завантаження копій.
- **Довідники** (`GET {host}/api/v2/dictionaries?name=`): кеш у пам'яті `dictionaryCacheHours` профілю, затиснутий у 4..12 год (ТВ 3.12.1.1: не частіше 4 год і не рідше доби);
  **single-flight** (одночасні читання одного довідника діляться одним запитом), невдале читання не повторюється 15 хв (5xx/401/403/таймаут) або **4 год** (400/404/410/422);
  фоновий прогрів (`DictionaryWarmupWorker`) кожні 8 год (4..12, 0 = вимкнено) для `GENDER, COUNTRY, ADDRESS_TYPE, SETTLEMENT_TYPE, STREET_TYPE, PHONE_TYPE, DOCUMENT_TYPE, AUTHENTICATION_METHOD, SCOPES` і причин верифікації. Мітки кодів у відповідях беруться з довідників; недоступний довідник нічого не ламає.
- **Адреси** (`/api/uaddresses/*` на хості Auth UI, публічні): області 24 год (`page_size=100`), райони 24 год (`region=<назва>&page_size=100`), населені пункти 30 хв (`region`, `name` **від 2 символів**, `district?`, `page_size=30`).
- **Пагінація**: у MedOne переліки читаються **однією сторінкою** (`apps?page_number=1&page_size=50`; `page_number` і `page_size` для approvals обов'язкові, Confluence API-023-004-0001). Збір усіх сторінок не реалізовано.
- **Читання**: мінімальний інтервал між двома запитами одного лінка 15 с (відповідь із кешу), після запису кеш лінка скидається; форми друку й «розкриті» значення не кешуються.
- GET-запити йдуть через `AddStandardResilienceHandler` (retry/circuit-breaker); записи, обмін коду, refresh, logout, nonce **ніколи** не повторюються.

### 2.10. Помилки: Додаток 1 і санітизація

- Повна таблиця Додатка 1 (373 рядки, 43 методи) імпортована скриптом (`infra/tools/dodatok1/import.mjs`) у `GW/Dodatok1/dodatok1.table.json`; номер `D1-nnn` позиційний, імпортер **відмовляється** записувати таблицю, якщо номери зсунулися (`--accept-id-shift`).
- `Dodatok1Resolver`: метод визначається за HTTP-методом і формою шляху; слова відповіді ЕСОЗ (`error.message`, `error.invalid[].rules[].description`, `error_description`) порівнюються з «Оригінальним текстом помилки» (плейсхолдери `%{property}`, `<<types>>`, `{field}`, `#{limit}` = довільні слова; апострофи й регістр ігноруються); найконкретніший збіг перемагає;
  без збігу слів береться рядок із загальним описом («422 with field-specific message»); без нього рядок за статусом, **якщо всі рядки методу з цим статусом дають однакові текст і дію**; 404 «про особу» проти 404 «про ресурс» розрізняється за видом запиту.
- Підстановки: `[назва ПІС]`, `[контакти підтримки ПІС]` із профілю (`PisName`, `SupportContacts`), `[url переходу на створення запиту …]` -> `https://support.ehealth.gov.ua/issues/new?service_id=…&category_id=…&subcategory_id=…` (таблиця ids із Confluence «[PІS UI] Посилання на підтримку пацієнтів НСЗУ»; повна відповідність у `docs/tv-texts.json`, розділ `support`).
- Адмін може замінити текст/дію рядка (код `D1-nnn`), решта рядків адмінки обслуговує помилки поза таблицею.
- Логи й БД: `UpstreamErrors.Sanitize` **allow-list** (відомі англійські слова, назви скоупів, числа до 3 цифр; усе інше -> `[redacted]`), `meta.request_id`/`x-request-id` зберігається для Support. Тіла запитів/відповідей і токени не логуються.

### 2.11. Діагностика для Support

`Ehealth:Diag:Enabled` (вимкнено за замовчуванням) + «трасування» одного лінка на 1..60 хв (причина >=10 символів в аудиті): кожен виклик до ЕСОЗ записується (редагування токенів/`api-key`/cookie, шифрування в спокої, 7 діб, до 300 обмінів), експорт **HAR 1.2** (`TraceHar`), доступний ролям «інженер інтеграцій» і «суперадмін».

### 2.12. КЕП-проксі

`/api/v1/ehealth/kep/proxy`: allow-list хостів ЦСК (~40 хостів у `appsettings.json`, додатково з профілю: списки OCSP/TSP/CMP), типи вмісту `application/ocsp-request`, `timestamp-query`, `pkix-cmp`, `octet-stream`, ліміт тіла 1 МБ (відповідь x4), таймаут 6 с,
**блок приватних адрес на рівні `ConnectCallback`** (проти SSRF і DNS-rebinding: підключення лише до публічних IP), без редиректів, rate-limit 60/хв. Протокол ІІТ: тіло POST у Base64 з `Content-Type: X-user/base64-data`, відповідь теж Base64. Бібліотека працює з `directAccess:false`, тобто браузер не звертається до ЦСК напряму (ТВ 1.6.1).

### 2.13. Конфігурація профілю ЕСОЗ і секрети (без значень)

**Профіль** (`admin.ehealth_profiles`, одна активна на середовище; шлюз перечитує кожні 15 с, межа 60 с):
`name, environment (preprod|prod), authUiHost, apiHost (OAuth; за замовчуванням authUiHost), apiBaseUrl (/api/*, словники; за замовчуванням authUiHost), clientType (PIS|TRUSTED_PIS),
clientId, redirectUris[] (зареєстровані в ЕСОЗ), redirectUrisToRequest[] (які ще просимо зареєструвати), scopes[] (стеля, 22), pisName, supportContacts, legalCapacityDocumentTypes[],
localAccounts, statePrefix (`mo_`), kepProxyAllowlist {ocsp[],tsp[],cmp[]}, timeouts {requestSeconds, retries, dictionaryCacheHours, registryCacheHours}, modules {auth, signUp, personalData, declarations, apps}`.
У seed-файлі додатково: `$comment`, `apiHostNote`, `apiBaseUrlNote` (пояснення), `secrets{clientSecret, testKepKey}`.

**Секрети** (у профілі лише посилання `vault://<ключ>`):
- слоти: `clientSecret` (він же `api-key`, якщо немає окремого `apiKey`), `apiKey` (необов'язково), для preprod ще `testKepKey` і `testKepKeyPassword` (файловий тестовий ключ КЕП для автотестів; для prod заборонено);
- запис через адмінку **write-only**: API повертає лише `{isSet, updatedAt, updatedBy, expiresAt}` (`SecretRef`), значення ніколи; у журналі аудиту `***`; при створенні/зміні профілю секрет шифрується (Data Protection, purpose `MedOne.Admin.SecretStore.v1` + підпорядкований protector на **ключ секрету**, тож шифртекст не можна перенести в інший рядок) і кладеться в `admin.secrets`; інтерфейс `ISecretStore` готовий під HashiCorp/Azure Key Vault;
- читач шлюзу (`AdminDbSecretResolver`): `vault://key` -> розшифрування з `admin.secrets` -> якщо немає, змінна оточення `VAULT__<КЛЮЧ_З_/_ЗАМІНЕНИМИ_НА___>` (`vault://ehealth/x/client-secret` -> `VAULT__EHEALTH__X__CLIENT_SECRET`);
- збій сховища (ключове кільце, БД) = **ретраябельна** помилка: код/refresh не відправлено, не витрачено; логується лише тип винятку (повідомлення може містити посилання на секрет);
- **prod-профіль** лише `platform_superadmin`, активація заборонена, поки `Admin:Ehealth:ProdCertified=false`, кожна зміна/активація в аудиті з причиною;
- `GET /api/v1/ehealth/profile` (внутрішній ключ) показує секрети лише як `{reference, isSet}`.

**Змінні шлюзу** (`Ehealth__*`; повний перелік у `docs/ehealth-verification-guide.md` §1.6): `Signing__Enabled` (головний вимикач усіх записів, вимкнено), `Signing__Flows__{DeclarationRequest,PersonRequest,AuthMethodRequest,AuthMethods,DeclarationTerminate,AppRevoke}`,
`Signing__Doctors__N__*`, `Signing__CheckApproval`, `Auth__RequireCadesXLong`, `Data__RevealEnabled`, `Dictionaries__WarmupHours`, `Diag__Enabled`, `Upstream__ApiKey__{Enabled,HeaderName,ProfileSecret,SecretRef,FallbackToClientSecret}`,
`Upstream__AllowedHostSuffixes` (за замовчуванням `ehealth.gov.ua`: усі хости з профілю перевіряються проти нього; лише https; без `userinfo`; без редиректів), `Callback__PublicBaseUrl`, `Token__{Endpoint,NonceEndpoint,LogoutEndpoint,BodyStyle,DefaultAccessTtlSeconds}`.
PSK-заголовка (`X-Custom-PSK`) у коді шлюзу **немає** (на preprod MedOne працює без нього).

---

## 3. Знахідки та нюанси ЕСОЗ (що встановлено на preprod і в документації)

### 3.1. Автентифікація

| № | Знахідка | Джерело |
|---|---|---|
| A1 | Підписується **JSON `{"jwt":"…"}`**, а не голий JWT (інакше `422 Malformed encoded content. Probably, you have encoded corrupted JSON`) | `raw/17`, `signing-config.ts` |
| A2 | Nonce видає ЕСОЗ (`/oauth/nonce`), власний випадковий -> `JWT is invalid`. Термін JWT 15 хв (`JWT_LOGIN_TTL`) | `raw/13` |
| A3 | Особа не в ЕСОЗ: `401 access_denied: Person with tax id or document number not found.` (це **не** «користувач скасував»: потрібна пропозиція реєстрації) | `raw/17`, `ErrorMapper` |
| A4 | Для sign-in в Auth UI ЕСОЗ сам викликає `POST /auth/login` (grant `pis_auth`), потім екран згоди, потім редирект з `code` | `raw/13` |
| A5 | Повторний вхід КЕП **пропускає екран згоди Auth UI** (вхід за ~4 с), список прав пацієнт не бачить; щоб побачити, треба відкликати доступ застосунку | `raw/25`, S03 |
| A6 | Відповідь `/oauth/tokens`: `data.value` (access), `data.expires_at`, `data.details.refresh_token`, `data.details.scope`, `data.user.person_id`; access ~86400 с; refresh ~31556926 с (його терміну у відповіді немає, `reauth_required` визначається за відмовою ЕСОЗ) | `raw/13`, `EhealthClients.cs` |
| A7 | Помилки обміну: `Token not found.`, `Token expired.`, `Token has already been used.`, `Invalid client id or secret.`, `The redirection URI provided does not match a pre-registered value.`, `Resource owner revoked access for the client.`; 422 `Request must include grant_type.` | `raw/13`, `ErrorMapper` |
| A8 | `redirect_uri` має збігатися **побуквенно** в Auth UI і в обміні; зміна лише через Jira Service Desk (portal/6) | `raw/13` |
| A9 | Рівень підпису: очікується CAdES-X Long (атрибути `certificate-values`, `revocation-values`); на живому ключі ще не підтверджено, тому перевірка опційна | checklist §7 |

### 3.2. Скоупи й approval (найважливіше)

| № | Знахідка | Джерело |
|---|---|---|
| S1 | `person_request:sign_pis` потрібен для **Complete** (`write_pis` не достатньо): `403 Missing allowances: person_request:sign_pis` | `raw/25` №6 |
| S2 | Навіть коли скоуп **є в токені**, Complete давав той самий 403. ЕСОЗ перевіряє **approval** (що пацієнт підтвердив при першому вході), а повторний вхід із розширеним `scope` approval **не розширює** | checklist §2 |
| S3 | Тому шлюз читає скоупи **власного** approval (`GET /apps`, запис із `client_id` = клієнт профілю; **повний** рядок `scope` ~600 символів, його не можна різати) і до звернення в ЕСОЗ відповідає `approval_scope_missing`; «Оновити дозвіл» = `DELETE /apps/{own}` + новий вхід (Auth UI показує повний список) | `OwnApproval.cs` |
| S4 | Якщо скоуп є і в токені, і в approval, а ЕСОЗ усе одно відмовляє -> `client_scope_not_allowed`: скоуп не дозволено самому `client_id` (налаштування ДП ЕЗ), пацієнт нічого зробити не може (питання Q11 до Support, відкрито) | там само |
| S5 | Токен, виданий до ввімкнення запису, має лише скоупи читання: один новий вхід із КЕП | checklist §8 |
| S6 | Для неповнолітніх/без дієздатності доступні лише `PIS_READ_ONLY_SCOPES_ALLOWED`: `app:read_pis, person_verification:details_pis, person:details_pis, authentication_method:read_pis, declaration_request:read|details, declaration:read|details, person_request:read|details` | `raw/13` |

### 3.3. Виклики API

| № | Знахідка | Джерело |
|---|---|---|
| C1 | **`api-key` обов'язковий** на всіх `/api/*` (Apiary 9.14.0 PREPROD: «PIS must mandatory send api-key», токен ПІС має `access_type BROKER`, Kong перевіряє ключ). Без нього `401 access_denied` на кожному `/api/pis/*` при робочому вході. Для `/oauth/*` не потрібен | `raw/13` §5 |
| C2 | `GET /api/pis/apps`: `page_number` і `page_size` **обов'язкові** | `GatewayOptions` |
| C3 | Хост OAuth для PIS: **`pis-auth-preprod`** маршрутизує `/oauth/*` на «PIS Mithril»; `auth-preprod` це загальний Mithril. `/api/pis/*` на живому прогоні читалися з того самого хоста (7 з 7 = 200) | `EhealthProfile.cs`, `raw/25` |
| C4 | `POST …/actions/resend_otp`: **POST**, а не PATCH (сторінка API перемагає бізнес-процес) | `GatewayOptions` |
| C5 | `verification_code` у API число, але код з ведучим нулем треба надсилати **рядком** (схема `^\d{4}$`); чи приймає ЕСОЗ рядок, перевірити | `PisAccountActions.cs` |
| C6 | `person_requests/{id}`: статус `CANCELED` (одна L) у деталях, `cancelled` у переліках; дати `2020-01-10 18:23:34.217335` (пробіл, без зони) = UTC | `PisJson.cs` |
| C7 | `PATCH …/person_requests/{id}/actions/complete`: вміст = запит з `patient_signed=true`; Create дає `urgent.documents[]` зі `url` для завантаження; `data_to_be_signed` у деталях декларації «може бути очищений з міркувань безпеки», тоді потрібен новий запит | `DeclarationRequestFlow.cs` |
| C8 | Не перевірено: де саме `patient_signed` у `data_to_be_signed` (у `person` за Apiary); якщо ЕСОЗ дасть `content_mismatch`, надіслати структуру через діаг-захват (питання QD-5) | checklist §5 |
| C9 | Чи повертає ЕСОЗ refresh_token при оновленні, на живому не перевірено; шлюз обробляє обидва варіанти | S05 |
| C10 | SMS на preprod **не надходять** (QD-2), тому створення методу OTP і реєстрація наскрізно не пройдені | guide §1.5 |
| C11 | `POST /api/pis/authentication_method_requests` повертає 201 і `id`, але SMS на новий номер не приходить (блокер preprod) | `raw/25` №3 |
| C12 | Ліміт номера: «present more than» -> `phone_limit` («Цей номер телефону перевищив ліміт для використання в ЕСОЗ»); «unverified phone» -> `phone_unverified` | `PisWriteErrors` |
| C13 | Помилки запису розпізнаються за шаблонами англійських слів (`signed content does not match`, `unable to authenticate signer`, `last authentication method`, `only for otp`, `person request`, `not verified`, `invalid transition`, `can't be updated`, `too many`, `deduplicat`…); перелік у `PisWriteErrors.Known` |
| C14 | Неідентифікація особи: `It is impossible to uniquely identify the person.` (дубль запису, звернення до НСЗУ) |
| C15 | **«Validation failed»** (рядок D1-223 Додатка 1 каже «дубль запису») Auth UI надсилає й при звичайній помилці форми реєстрації (`error=invalid_request&error_description=Validation failed`). Тому за замовчуванням це «повторіть реєстрацію», а не «дубль»; справжній збій упізнання ЕСОЗ називає прямо (D1-215) | checklist §11.6 |

### 3.4. Інше

| № | Знахідка |
|---|---|
| X1 | Дані особи на preprod «реальні» (в межах preprod): запит на зміну надсилає **всю** особу, моків немає |
| X2 | Довідник `SCOPES` (опис прав для пацієнта): перевірити мову описів (ТВ вимагає `description` довідника, інтерфейс українською) |
| X3 | Межі даних довідників: список `values[{code,description}]` або об'єкт код -> текст, розбір допускає обидва |
| X4 | Параметри Системи: `no_self_registration_age=14`, `person_full_legal_capacity_age=18`, `OTP_CODE_LENGTH=4`, `CODE_EXPIRATION_PERIOD_MINUTES=15`, `PIS_VALIDATE_ALL_PHONES=true` на preprod |
| X5 | Адреса: `area` = область, `region` = район (у відповіді `/uaddresses/settlements`: `district/district_id/id/koatuu/name/region/region_id/type`) |

---

## 4. Розбіжності з Плексі (`backend/app.py`, `backend/ehealth_pis/*.py`)

Позначки: **Н** = у Плексі немає; **Ч** = частково; **Р** = робимо інакше; **+** = у Плексі є, у MedOne немає.

| № | Тема | MedOne | Плексі | Стан |
|---|---|---|---|---|
| D1 | Скоуп `person_request:sign_pis` | є в матриці, профілі, запиті | **відсутній** у `config.DEFAULT_SCOPES` | Н, P0 |
| D2 | Склад скоупів у запиті входу | лише скоупи увімкнених функцій (ТВ 1.4.3) | завжди всі 21 (`scope_string`), зокрема `person_documents:write_pis`, `declaration:terminate_pis` | Р |
| D3 | Approval vs токен | перевірка scope власного approval, `approval_scope_missing`/`client_scope_not_allowed`, кнопка «Оновити дозвіл» | немає; після додавання скоупа Complete поверне 403 для вже авторизованих | Н |
| D4 | Код підтвердження OTP | рядок, якщо починається з `0`, інакше число | `int(verification_code)`: `0123` -> `123` | Н, P0 |
| D5 | Пре-валідація реєстрації | `POST /sign-up/validate` (`sign-up_validation`) після підпису, до Auth UI: 422 на поля | немає: підпис -> одразу Auth UI -> «Validation failed» без полів | Н |
| D6 | Валідація форми | імена (заборонені символи), паспорт/ID-картка за регулярками, `settlement_id` UUID, `settlement_type` enum, `street_type`, zip 5 цифр, phones.type enum, вік >120, дата в майбутньому, дата дієздатності > сьогодні | `validate_person_request`: перелік обов'язкових полів і дат без регулярок номерів, імен, zip, enum | Ч |
| D7 | Перевірка підпису перед відправкою | вміст == підготовлений, РНОКПП сертифіката == РНОКПП особи, рівень CAdES логується | лише `is_base64()` у `_signed_content` | Н |
| D8 | Одноразовість nonce/state | nonce хеш у БД, спалюється атомарно і прив'язується до state; state в БД одноразовий | nonce не зберігається; web-state у cookie, mobile-state HMAC у пам'яті процесу (ок для одного воркера) | Р |
| D9 | Refresh-токен одноразовий | мьютекс на лінк, повторне читання рядка після блокування | `_refresh_tokens` без блокування: два паралельні запити (gthread) можуть обидва пред'явити refresh; другий отримає 401 і `clear_session_ehealth_tokens` викине пацієнта | Н |
| D10 | Інтерпретація 401 | `api-key` не придатний -> `unavailable`; після успішного refresh -> `forbidden`; refresh не вдався через недоступність -> `unavailable`; лише справжня відмова токена -> `reauth_required` | `_ehealth_error`: будь-який 401 стирає токени сесії й просить вхід | Р |
| D11 | Таймаут запису | `outcome_unknown`: «перевірте переліки, не повторюйте наосліп» | будь-який збій мережі = `NETWORK_MESSAGE` «спробуйте пізніше» (підштовхує повторити створення декларації/запиту) | Н |
| D12 | Згода при зміні даних | `process_disclosure_data_consent` лише явна галочка, без неї 422 `process_disclosure_data_consent` | `bool(data.get("process_disclosure_data_consent", True))`: **за замовчуванням true** | Р |
| D13 | Кодове слово при зміні даних | пацієнт вводить сам, поточне не читається/не показується | клієнт надсилає `person` повністю (`fillPersonForm` підставляє `p.secret`) | Р |
| D14 | Склад `person` у запиті на зміну | сервер сам будує з `GET person` лише документовані ключі (інакше 422 `additionalProperties=false`) | приймає `person` від клієнта, `clean_person` лише прибирає порожнє | Ч |
| D15 | Помилка `GET person` після обміну коду | best effort: токени вже збережено, ідентичність із `data.user.person_id` або сертифіката | `_complete_ehealth_login`: виняток -> відповідь помилкою, а код ЕСОЗ уже витрачено | Ч |
| D16 | Визначення власного approval при відкликанні | `client_id` із `GET /apps/{id}` або 401-проба; автоматичний Logout і видалення токенів; попередження в діалозі | `delete_app` повертає 204; токени лишаються до першого 401 | Н |
| D17 | Журнал збою ЕСОЗ | шаблон шляху, статус, `error.type`, **`request_id`**, стан `api-key`, результат refresh, рядок Додатка 1; без тіл і id | `logger.warning(f"eHealth error {err}")` з повним `message`; `request_id` не зберігається | Ч |
| D18 | Санітизація тексту помилки | allow-list слів для логів/БД | `message` ЕСОЗ у логах і в `to_dict()["error_message"]` | Ч |
| D19 | Додаток 1: добір рядка | слова -> «загальний опис» -> статус, якщо всі рядки методу одноманітні; розрізнення «особа/ресурс» | слова (найдовший збіг) або, лише без тексту, перший рядок статусу; інакше загальне повідомлення | Ч |
| D20 | Посилання на підтримку НСЗУ | `…/issues/new?service_id&category_id&subcategory_id` за таблицею Confluence; категорія залежить від повідомлення | `https://support.ehealth.gov.ua/issues/new` без категорії, у коментарі «пряме посилання на категорію портал не надає» | Ч |
| D21 | Домен e-mail | перелік у БД, редагує адмін, аудит, вимкнення з «УВАГА»; `.ru` не зона | жорсткий `BLOCKED_EMAIL_DOMAINS` (~45) **і будь-яка зона `.ru`** | Р |
| D22 | Блок доменів у зміні даних | не підключено (ТВ 3.5.4.8 говорить лише про реєстрацію) | `validate_person_request(for_update=True)` застосовує і до зміни даних | Р |
| D23 | Перевірка стану реєстрації 14-17 при зміні | не дозволяє змінювати документи | `validate_person_update` вимагає >=1 документ дієздатності | Р |
| D24 | Кеш довідників | single-flight, пам'ять; прогрів 8 год; негативний кеш 15 хв/4 год | SQLite `cache`: 4 год свіжість, при збої до 48 год «застаріле»; без single-flight і без негативного кешу (кожен запит клієнта при збої ЕСОЗ знову б'є ЕСОЗ) | Ч |
| D25 | Адреси: `name` від 2 символів, `region` обов'язковий | перевіряється на сервері (400) | `address_settlements` приймає будь-що | Ч |
| D26 | `GET /apps` без `page_size` | завжди `page_number=1&page_size=50` | `eh_list_apps`: якщо клієнт передав `page`, `page_size` не додається (ЕСОЗ вимагає обидва) | Ч |
| D27 | `api-key` | лише `/api/*`, не в `/oauth/*`, не в словниках; окремий слот `apiKey` | `API-key` у **кожному** запиті, включно з `/oauth/*` і публічними довідниками/адресами | Р |
| D28 | Хост OAuth | `pis-auth-preprod` (перевірено: PIS Mithril) | `auth-preprod` (`PREPROD["auth_host"]`), `/api/pis` на `pis-preprod` | Р (перевірити) |
| D29 | `X-Custom-PSK` | немає | є (`psk`, для WAF preprod) | + (специфіка нашого доступу) |
| D30 | Розірвання, зміна alias, відкликання доступу | рівень довіри L2 + свіжий КЕП/Дія (<=10 хв), `step_up_required` | у `app.py` додаткового підтвердження дій немає (лише сесія) | Н |
| D31 | Діагностика для Support | трасування викликів одного лінка, експорт HAR, редагування секретів | немає | Н |
| D32 | SSRF КЕП-проксі | allow-list **і** блок приватних IP на рівні з'єднання (DNS-rebinding), типи вмісту, rate-limit | allow-list за іменами хостів із `CAs.json`, без перевірки, на які IP вони резолвляться | Ч |
| D33 | Рівень CAdES | `CadesInspector` логує x-long/t/c/bes, опційно блокує | немає (немає навіть логу) | Н |
| D34 | Тести контрактів Додатка 1 | CT-D1: 373 рядки, імпортер із перевіркою зсуву номерів, звіт покриття | `annex1_errors.json` і `tools/build_annex1.py`; тестів «кожен рядок -> відповідь» немає | Ч |
| D35 | Копії документів (3.6), bulk-реєстри (3.12.2), пошук лікаря | **немає** (PG-09, PG-06) | є (`init/complete_documents_upload`, `RegistryStore`, `registry_doctors`) | + |
| D36 | Збір усіх сторінок | немає (одна сторінка) | `_list_all`, `_all_pages` | + |

---

## 5. Що перенести (пріоритети)

### P0 (до наступного прогону на preprod / до демонстрації)

| № | Дія | Де в Плексі | Орієнтир MedOne |
|---|---|---|---|
| P0-1 | Додати `person_request:sign_pis` у `DEFAULT_SCOPES` (і в `PIS_SCOPES`, якщо задано в `.env`). **Після деплою усім пацієнтам потрібно відкликати доступ Плексі (власний approval) і ввійти знову**, інакше approval лишиться без скоупа: додати в UI «Оновити дозвіл» (див. P1-2) | `backend/ehealth_pis/config.py`, `deploy/.env.example` | `Signing/PersonRequestFlow.cs` (`SignScope`), `PisScopeMatrix.cs` |
| P0-2 | `verification_code`: рядок, якщо починається з `0`, інакше число; без коду не слати `{}` у `approve` | `client.py:approve_auth_method_request` | `Signing/PisAccountActions.cs:VerificationCode` |
| P0-3 | Прибрати `process_disclosure_data_consent` за замовчуванням `True`: без явної згоди 422 | `app.py:eh_create_person_request` | `Signing/PersonRequestFlow.cs:Validate` |
| P0-4 | Виправити документ `docs/medone-analysis/06-clients.md` (рядки 23 і 182): `sign-up_validation` у Плексі **немає** | `docs/medone-analysis/06-clients.md` | |

### P1 (корисно й недорого)

| № | Дія | Орієнтир MedOne |
|---|---|---|
| P1-1 | `POST /api/auth/sign-up/validate` -> `POST {login_host}/api/pis/sign-up_validation` `{signed_content, signed_content_encoding:"base64"}` до редиректу; 422 -> поля форми (парсер `error.invalid[].entry` -> `person.<path>`; спеціальні правила `unzr is mandatory…`, `legal capacity`, `incorrect person age`, `name doesn't match`, `malformed encoded content`) | `SignUp/SignUpContent.cs:EsozValidationErrors`, `Upstream/SignUpClients.cs` |
| P1-2 | Перевірка approval: перед записом читати `GET /api/pis/apps` (запис з `client_id` == наш), кешувати на 120 с (скидати при новому вході/відкликанні), при нестачі скоупів відповідати `approval_scope_missing` + кнопка «Оновити дозвіл» (`DELETE /apps/{own}` -> вхід). 403 «Missing allowances: X», коли X є в токені й approval = `client_scope_not_allowed` (звертатись до Support, не плутати з повторним входом) | `Signing/OwnApproval.cs`, `PisWriteFailure.ForbiddenCode` |
| P1-3 | Блокування refresh на сесію (`threading.Lock` за `session_id`, повторне читання рядка після блокування); пам'ятати, що refresh одноразовий | `Auth/AuthServices.cs:LinkRefreshLocks` |
| P1-4 | Не стирати токени при кожному 401: розрізняти (а) 401 без придатного `API-key`, (б) 401 після успішного refresh -> `forbidden`, (в) refresh не вдався через 5xx/мережу -> 503, (г) тільки справжня відмова токена -> `ehealth_required` | `Data/EhealthApi.cs`, `PisFailure.Map` |
| P1-5 | Для записів таймаут/мережевий збій -> код `outcome_unknown` з текстом «перевірте Запити/Декларації, не повторюйте»; не повторювати POST/PATCH/DELETE автоматично (крім 401 після refresh, як зараз) | `PisWriteFailure.MapStatus` |
| P1-6 | Перевірка підпису до `PATCH …/sign` і `…/complete`: порівняти підписані дані з очікуваним вмістом (байти без BOM або `json` дерево), порівняти РНОКПП з сертифіката (CN/serial/Subject `DRFO`) з `person.tax_id` (крім `confidant_person`); коди `content_mismatch`, `signer_mismatch`, `content_missing` | `Signing/SigningCore.cs:SignatureCheck`, `SignedContentReader` |
| P1-7 | Логувати `request_id` (`meta.request_id` і заголовок `x-request-id`) і стан refresh при кожній відмові; не логувати `message`/тіла (див. P2-3) | `UpstreamErrors.Read`, `PisRun.SendAsync` |
| P1-8 | Підтягнути валідацію форми до `SignUpValidator`: імена без `ЫЪЭЁыъэё@%&$^#`, паспорт `^((?![ЫЪЭЁ])[А-ЯҐЇІЄ]{2})\d{6}$`, ID-картка `^\d{9}$`, zip `^\d{5}$`, `settlement_id` UUID для UA, `settlement_type ∈ {CITY,SETTLEMENT,TOWNSHIP,VILLAGE}`, `phones[].type ∈ {MOBILE,LAND_LINE}`, вік >120, `issued_at` < сьогодні і > дата народження | `SignUp/SignUpValidator.cs` |
| P1-9 | Посилання на підтримку НСЗУ з категоріями (service_id/category_id/subcategory_id): таблиця ids з `docs/tv-texts.json` (розділ `support`) -> підстановка в `[url переходу …]` за змістом повідомлення; перелік (уся публічна, не секрет): смерть у ДРАЦС 742/5729/5733; вік 742/5729/5771; дубль запису 742/5729/5730; заблоковано 741/5718/5766; збій підпису 741/5720/5764; не вдалося завантажити «Мої дані» 741/5724/5725; не вдалося розірвати декларацію 742/5753/5754; reauth 741/5718/5756; недоступність 741/5722/5758 | `Dodatok1/Dodatok1Guidance.cs`, `docs/tv-texts.json` |
| P1-10 | «Validation failed» при реєстрації трактувати як «повтор форми» (не «дубль запису», рядок D1-223), «It is impossible to uniquely identify the person.» як дубль (D1-215); мати перемикач | `Auth/ErrorMapper.cs:ValidationFailedSetting` |
| P1-11 | Після обміну коду: `GET /person` best effort. Не втрачати вже видані токени, якщо `GET person` дав збій; `person_id` взяти з `data.user.person_id` | `EhealthEndpoints.cs:Callback`, `PersonClient` |
| P1-12 | При відкликанні **власного** approval (`GET /apps/{id}`.client_id == наш): Logout + очистка токенів сесії + текст ТВ 3.8.2.1; без `app:read_pis` визначати за 401-пробою | `Signing/PisAccountActions.cs:RevokeAppAsync` |
| P1-13 | Привести правило доменів e-mail до формального переліку: не блокувати `.ru` як зону без підстав (перелік НЦУ окремо не публікується; MedOne тримає лише 12 доменів із рішень РНБО), винести в налаштування, при блокуванні давати текст ТВ 3.5.4.8; не застосовувати до зміни даних без рішення власника | `docs/ehealth-banned-email-domains.md`, `SignUp/RegistrationRules.cs` |
| P1-14 | Мінімальні скоупи (ТВ 1.4.3): запитувати лише скоупи увімкнених функцій (як мінімум не просити `person_documents:write_pis`, поки завантаження приховано; не просити `declaration:terminate_pis`, якщо розірвання вимкнено). **Обережно: звуження скоупів не звужує вже наданий approval, а розширення потребує «Оновити дозвіл»** | `Auth/RequestedScopes.cs` |

### P2 (за можливості)

| № | Дія | Орієнтир MedOne |
|---|---|---|
| P2-1 | Одноразовість nonce: зберігати SHA-256 виданого nonce і споживати атомарно разом зі `state` (захист від повторного використання підписаного nonce) | `NonceService.ConsumeAsync` |
| P2-2 | Дозволити `GET`-повтор (2-3 спроби з backoff) для 5xx/таймаутів і ввести circuit-breaker; записи не повторювати | `Program.cs:AddStandardResilienceHandler` |
| P2-3 | Санітизація помилок для логів/БД за allow-list слів (`[redacted]`) | `Upstream/UpstreamErrors.cs` |
| P2-4 | Негативний кеш довідників (15 хв для 5xx/401/403/таймаутів, 4 год для 400/404/410/422), single-flight для паралельних читань, фоновий прогрів 8 год для використовуваних довідників | `Upstream/EhealthClients.cs:DictionaryService`, `Data/DictionaryWarmup.cs` |
| P2-5 | `API-key` лише на `/api/*` ЕСОЗ (не в `/oauth/*`, не в публічних довідниках/адресах), окремий слот `apiKey` у конфігурації | `Upstream/EhealthApiKey.cs` |
| P2-6 | Логувати рівень CAdES підпису (`x-long|c|t|bes`) при вході, реєстрації й підписі; за потреби опція «вимагати X-Long» після підтвердження на реальному ключі | `Signing/SignatureFormat.cs` |
| P2-7 | Заборона підключень КЕП-проксі до приватних IP (перевірка `ConnectCallback`/резолву перед запитом) | `Upstream/EhealthClients.cs:PublicAddressConnector` |
| P2-8 | Трасування викликів до ЕСОЗ для одного користувача на обмежений час (з редагуванням і експортом HAR) для звернень у Support | `Data/EhealthTrace*.cs`, `TraceHar.cs` |
| P2-9 | Додатковий step-up (свіжий КЕП <=10 хв) для записів ЕСОЗ: розірвання, відкликання доступу, зміна методу | checklist §0 |
| P2-10 | Імпорт Додатка 1 із перевіркою зсуву номерів рядків і звітом покриття (CT-D1) | `infra/tools/dodatok1/import.mjs`, `docs/dodatok1-coverage.md` |
| P2-11 | Ротація ключа шифрування токенів (`MultiFernet`) і окремий purpose-протектор | `TokenVault`, `SecretStore.cs` |
| P2-12 | Скопіювати практику «перевірка форм відповідей на живому preprod»: після кожного нового виклику фіксувати в логу **структуру** відповіді (шляхи й типи полів, без значень), `StructureExtractor` | `EhealthClients.cs:Shape` |
| P2-13 | Звірити хост OAuth: `pis-auth-preprod` (перевірено в MedOne) vs `auth-preprod` (використовує Плексі). Якщо обмін працює, залишити, але зафіксувати в `docs/` як перевірене | `EhealthProfile.cs:ApiHost` |

### Що переносити не потрібно

Профілі в адмінці та Vault (у Плексі профіль один і секрети в `.env`/файлі), Data Protection, `LinkRef` на акаунт платформи, Dodatok1 admin-override, step-up платформи, HAR для платформи, весь блок `Ehealth:Signing:Doctors` (у Плексі є реєстри й пошук лікаря).

---

## 6. Відкриті питання MedOne до Support ЕСОЗ (корисно знати, щоб не повторювати)

- QD-2: SMS на preprod не приходять (створення методу OTP і реєстрація не пройдені).
- QD-5: де саме `patient_signed` у підписі і форма Complete.
- QD-11: скоуп є в токені, а Complete -> 403 «Missing allowances»; ЕСОЗ перевіряє токен чи approval; як ПІС розширює approval; чи дозволено скоуп `client_id`. **Головний блокер S07.**
- QD-4: доступ ПІС до Bulk (ключ, скоупи): бракує для PG-06; **у Плексі Bulk працює**, тож наш підхід до Bulk варто описати для MedOne окремо.
- QD-7: реєстрація `redirect_uri` нашого callback (працює через ретранслятор партнера).
- QD-9: чи можна показувати кодове слово/повні ідентифікатори.

---

## 7. Файли MedOne, які варто читати першими

| Тема | Файл |
|---|---|
| OAuth, nonce, state, callback | `services/pis-gateway/src/MedOne.PisGateway/EhealthEndpoints.cs`, `Upstream/EhealthClients.cs`, `Auth/AuthServices.cs` |
| `api-key` | `Upstream/EhealthApiKey.cs`, `Configuration/GatewayOptions.cs` (`ApiKeyOptions`) |
| Approval і скоупи | `Signing/OwnApproval.cs`, `Auth/RequestedScopes.cs`, `services/platform/src/MedOne.BuildingBlocks/Ehealth/PisScopeMatrix.cs` |
| Підпис і перевірка | `Signing/SigningCore.cs`, `Signing/SignatureFormat.cs` |
| Декларація, зміна ПД, методи | `Signing/DeclarationRequestFlow.cs`, `Signing/PersonRequestFlow.cs`, `Signing/PisAccountActions.cs` |
| Реєстрація | `SignUp/SignUpValidator.cs`, `SignUp/SignUpContent.cs`, `Upstream/SignUpClients.cs`, `SignUp/RegistrationRules.cs` |
| Помилки | `Auth/ErrorMapper.cs`, `Dodatok1/Dodatok1Resolver.cs`, `Upstream/UpstreamErrors.cs` |
| Довідники/адреси | `Upstream/EhealthClients.cs` (`DictionaryService`, `AddressService`), `Data/DictionaryWarmup.cs` |
| Профіль і секрети | `EhealthProfile.cs`, `Profiles/AdminData.cs`, `services/platform/src/MedOne.Modules.Admin/{Secrets/SecretStore.cs,Services/EhealthProfileService.cs}` |
| Перевірка на preprod | `docs/ehealth-signing-checklist.md`, `docs/ehealth-verification-guide.md`, `..\analysis\raw\25_live_test_2026-10-12.md` |
