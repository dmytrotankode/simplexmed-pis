/*
 * SimplexMed ПІС — підпис КЕП у браузері (п.1.6, 3.3.3, 3.5.5 ТВ ПІС).
 *
 * Бібліотека АТ «ІІТ» (EndUser, euscp) працює у web worker: файл ключа і пароль
 * не залишають браузер, сервер отримує лише готовий підпис. Запити бібліотеки до
 * ЦСК (сертифікати, OCSP, TSP) йдуть напряму (directAccess) або через /api/kep/proxy.
 * Файли бібліотеки — pis/web/lib/euscp (див. pis/tools/fetch_euscp.py).
 *
 *   await Kep.readKey(fileBytes, password, caName)  -> {owner}
 *   await Kep.sign('дані')                         -> base64 CAdES-X Long (дані всередині)
 *   await Kep.reset()
 */
(function (global) {
  'use strict';

  const BASE = '/lib/euscp';
  const SCRIPT_URL = BASE + '/euscp.js';
  const WORKER_URL = BASE + '/euscp.worker.js';
  const CAS_URL = BASE + '/data/CAs.json';
  const CA_CERTS_URL = BASE + '/data/CACertificates.p7b';
  const PROXY_URL = '/api/kep/proxy';

  let endUserPromise = null;
  let keyRead = false;
  let ownCerts = [];

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      if (global.EndUser) return resolve();
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Не вдалося завантажити бібліотеку підпису'));
      document.head.appendChild(s);
    });
  }

  async function fetchOk(url, as) {
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('Не вдалося завантажити ' + url);
    return as === 'json' ? resp.json() : new Uint8Array(await resp.arrayBuffer());
  }

  function constants() {
    const C = global.EndUserConstants;
    if (!C) throw new Error('Бібліотеку підпису завантажено некоректно');
    return C;
  }

  /** Один ініціалізований EndUser на вкладку: worker важкий (~17 МБ), вантажимо лише при першому підписі. */
  function getEndUser() {
    if (!endUserPromise) {
      endUserPromise = (async () => {
        const [cas, certificates] = await Promise.all([
          fetchOk(CAS_URL, 'json'), fetchOk(CA_CERTS_URL), loadScript(SCRIPT_URL)
        ]).then(r => [r[0], r[1]]);
        const C = constants();
        const eu = new global.EndUser(WORKER_URL, C.EndUserLibraryType.JS);
        await eu.Initialize({
          language: 'uk',
          encoding: 'UTF-8',
          httpProxyServiceURL: PROXY_URL,
          directAccess: true,
          CAs: cas,
          CACertificates: certificates
        });
        return eu;
      })().catch(e => {
        endUserPromise = null;
        throw e;
      });
    }
    return endUserPromise;
  }

  /** Перелік ЦСК для вибору: без вибору бібліотека перебирає всі ЦСК (довго). */
  async function listCAs() {
    const cas = await fetchOk(CAS_URL, 'json');
    return cas.map(ca => ca.issuerCNs[0]).sort((a, b) => a.localeCompare(b, 'uk'));
  }

  function errorMessage(e) {
    if (!e) return 'Невідома помилка бібліотеки підпису';
    return e.message || e.description || String(e);
  }

  async function readKey(keyBytes, password, caName) {
    if (!keyBytes || !keyBytes.length) throw new Error('Оберіть файл ключа (.dat, .pfx, .jks, .zs2)');
    if (!password) throw new Error('Введіть пароль до ключа');
    const eu = await getEndUser();
    keyRead = false;
    let owner;
    try {
      owner = await eu.ReadPrivateKeyBinary(keyBytes, password, null, caName || null);
    } catch (e) {
      throw new Error(errorMessage(e));
    }
    try {
      ownCerts = await eu.GetOwnCertificates();
    } catch (e) {
      ownCerts = [];
    }
    keyRead = true;
    return { owner };
  }

  /** Алгоритм підпису за типом ключа: ДСТУ 4145 — з гешем ДСТУ 7564 (КЕП нового зразка), інакше RSA/ECDSA. */
  function signAlgos() {
    const C = constants();
    const signCert = ownCerts.find(c => c.infoEx && (c.infoEx.keyUsageType & C.EndUserKeyUsage.DigitalSignature));
    const keyType = signCert ? signCert.infoEx.publicKeyType : C.EndUserCertKeyType.DSTU4145;
    if (keyType === C.EndUserCertKeyType.RSA) return [C.EndUserSignAlgo.RSAWithSHA];
    if (keyType === C.EndUserCertKeyType.ECDSA) return [C.EndUserSignAlgo.ECDSAWithSHA];
    return [C.EndUserSignAlgo.DSTU4145WithDSTU7564, C.EndUserSignAlgo.DSTU4145WithGOST34311];
  }

  /** Внутрішній (дані всередині) підпис CAdES-X Long у BASE64 (п.1.6, 1.6.2). */
  async function sign(data) {
    if (!keyRead) throw new Error('Спершу зчитайте ключ');
    // п.1.6.3: дані без символу U+FEFF
    const text = String(data).replace(/﻿/g, '');
    const eu = await getEndUser();
    const C = constants();
    // За замовчуванням CAdES-X Long (з міткою часу). Для діагностики вимог ЕСОЗ: localStorage.kep_sign_type = BES | T | C | X_Long
    let signType = 'X_Long';
    try { signType = localStorage.getItem('kep_sign_type') || 'X_Long'; } catch (e) { /* сховище недоступне */ }
    const type = C.EndUserSignType['CAdES_' + signType] || C.EndUserSignType.CAdES_X_Long;
    await eu.SetRuntimeParameter(C.EU_SIGN_TYPE_PARAMETER, type);
    let lastError = null;
    for (const algo of signAlgos()) {
      try {
        return await eu.SignDataEx(algo, text, false, true, true);
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(errorMessage(lastError));
  }

  async function reset() {
    keyRead = false;
    ownCerts = [];
    if (!endUserPromise) return;
    try {
      const eu = await endUserPromise;
      await eu.ResetPrivateKey();
    } catch (e) { /* ключ уже вивантажено */ }
  }

  async function available() {
    try {
      const r = await fetch(SCRIPT_URL, { method: 'HEAD' });
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  global.Kep = { listCAs, readKey, sign, reset, available, isKeyRead: () => keyRead };
})(window);
