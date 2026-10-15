/**
 * Plexi SDK — клієнт API кабінету пацієнта «Плексі» для інтеграції у сторонній веб-застосунок (напр. MFX).
 *
 * Принципи:
 *  - ES-модуль без залежностей і без глобальних змінних; нічого не чіпає на сторінці-хості;
 *  - працює з розгорнутим сервісом «Плексі» за baseUrl (окремий піддомен або шлях за зворотним проксі);
 *  - токени ЕСОЗ SDK ніколи не бачить: сервіс тримає їх лише на сервері, клієнт має тільки HttpOnly cookie;
 *  - підпис КЕП виконує бібліотека kep.js самого сервісу (вантажиться з baseUrl на вимогу), ключ і пароль
 *    лишаються в браузері.
 *
 *   import { PlexiClient } from '/sdk/plexi-sdk.js';
 *   const plexi = new PlexiClient({ baseUrl: 'https://plexi.example.com' });
 *   await plexi.me();                       // null, якщо немає сесії
 *   await plexi.startKepSignIn({ consent: true });   // перенаправляє на сторінку авторизації ЕСОЗ
 *
 * Cookie сесії — SameSite=Strict, тому хост і сервіс «Плексі» мають бути одного сайту (напр. app.example.com
 * і plexi.example.com). Для різних сайтів використовуйте перехід (redirect) на сам кабінет.
 */

export class PlexiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'PlexiError';
    this.status = status;
    this.body = body || {};
  }
  /** Підказка дії за Додатком 1: 'person-edit' | 'sign-up' | null */
  get nextStep() { return this.body.next_step || null; }
}

export class PlexiClient {
  /**
   * @param {{baseUrl?: string, fetch?: typeof fetch, env?: 'my-dev'|'my'}} opts
   *   baseUrl — адреса сервісу без завершального «/»; env — значення state для повернення (my-dev на тесті).
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || '').replace(/\/+$/, '');
    this._fetch = opts.fetch || ((...a) => fetch(...a));
    this.env = opts.env || 'my';
    this._kep = null;
  }

  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const init = { method, credentials: 'include', headers: { Accept: 'application/json', ...headers }, signal };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let resp;
    try {
      resp = await this._fetch(this.baseUrl + '/api' + path, init);
    } catch (e) {
      throw new PlexiError('Немає з’єднання із сервісом', 0, {});
    }
    let data = {};
    try { data = await resp.json(); } catch { /* порожня відповідь */ }
    if (!resp.ok) throw new PlexiError(data.error || 'Сталася помилка. Спробуйте пізніше.', resp.status, data);
    return data;
  }

  /** Профіль поточної сесії або null, якщо користувач не авторизований. */
  async me() {
    try { return (await this.request('/patient/me')).data; }
    catch (e) { if (e instanceof PlexiError && e.status === 401) return null; throw e; }
  }

  config() { return this.request('/config'); }
  privacyPolicyUrl({ download = false } = {}) { return `${this.baseUrl}/api/privacy-policy${download ? '?download=1' : ''}`; }

  // --- дані ЕСОЗ (потрібна сесія з доступом до ЕСОЗ) ---
  person() { return this.request('/ehealth/person'); }
  verification() { return this.request('/ehealth/person/verification'); }
  authMethods() { return this.request('/ehealth/person/authentication-methods'); }
  declarations() { return this.request('/ehealth/declarations'); }
  declarationRequests() { return this.request('/ehealth/declaration-requests'); }
  personRequests() { return this.request('/ehealth/person-requests'); }
  apps() { return this.request('/ehealth/apps'); }
  regions() { return this.request('/ehealth/addresses/regions'); }
  dictionary(name) { return this.request('/ehealth/dictionaries?name=' + encodeURIComponent(name)); }

  // --- вхід і вихід ---
  /** Одноразовий вміст для підпису КЕП (JSON {"jwt": nonce}). */
  async signInContent() {
    const r = await this.request('/auth/nonce', { method: 'POST' });
    return r.content || r.nonce;
  }

  /** URL сервісу авторизації ЕСОЗ для підписаних даних (mode: 'sign-in' | 'sign-up'). */
  async authUrl({ userData, mode = 'sign-in' } = {}) {
    const r = await this.request('/auth-url', { method: 'POST', body: { env: this.env, mode, user_data: userData } });
    return r.url;
  }

  /** Завантажує kep.js сервісу один раз і повертає глобальний Kep (бібліотека підпису ІІТ). */
  async loadKep() {
    if (this._kep) return this._kep;
    this._kep = new Promise((resolve, reject) => {
      if (globalThis.Kep) return resolve(globalThis.Kep);
      const el = document.createElement('script');
      el.src = this.baseUrl + '/kep.js';
      el.onload = () => resolve(globalThis.Kep);
      el.onerror = () => reject(new PlexiError('Не вдалося завантажити бібліотеку підпису', 0, {}));
      document.head.appendChild(el);
    });
    return this._kep;
  }

  /**
   * Вхід з КЕП (ТВ 3.3): читання ключа, підпис nonce, перехід на сторінку авторизації ЕСОЗ.
   * @param {{keyFile: File|Uint8Array, password: string, ca?: string, consent: boolean}} p
   */
  async startKepSignIn({ keyFile, password, ca = '', consent }) {
    if (consent !== true) throw new PlexiError('Потрібна явна згода з Політикою конфіденційності', 0, {});
    const Kep = await this.loadKep();
    const bytes = keyFile instanceof Uint8Array ? keyFile : new Uint8Array(await keyFile.arrayBuffer());
    await Kep.readKey(bytes, password, ca);
    const signed = await Kep.sign(await this.signInContent());
    const url = await this.authUrl({ userData: signed, mode: 'sign-in' });
    globalThis.location.assign(url);
  }

  /** Обробка параметрів повернення з ЕСОЗ у сторінці-хості: ?code=…&state=… або ?error=…; повертає true, якщо оброблено. */
  async completeFromLocation(search = globalThis.location.search) {
    const p = new URLSearchParams(search);
    if (p.get('error')) {
      const e = await this.request('/auth/sign-in-error', { method: 'POST', body: {
        error: p.get('error'), error_description: p.get('error_description') || '', mode: 'sign-in' } });
      throw new PlexiError(e.error, 400, e);
    }
    if (!p.get('code')) return false;
    await this.request('/auth/token', { method: 'POST', body: { code: p.get('code'), state: p.get('state') || '' } });
    return true;
  }

  logout() { return this.request('/auth/logout', { method: 'POST' }); }
}

export default PlexiClient;
