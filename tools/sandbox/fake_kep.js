/*
 * Стенд: імітація web/kep.js (той самий інтерфейс window.Kep) без бібліотеки ІІТ.
 * Будь-який файл ключа, пароль «test». Підпис = base64("SANDBOX-SIGNED\n" + дані) —
 * імітація ЕСОЗ (tools/sandbox/fake_ehealth.py) перевіряє, що підписано саме потрібні дані.
 * Лише для локального стенду: на сервері віддається справжній web/kep.js.
 */
(function (global) {
  'use strict';
  let keyRead = false;
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  async function listCAs() {
    return ['Тестовий ЦСК стенду', 'КНЕДП ДПС (стенд)'];
  }

  async function readKey(keyBytes, password) {
    if (!keyBytes || !keyBytes.length) throw new Error('Оберіть файл ключа (.dat, .pfx, .jks, .zs2)');
    if (!password) throw new Error('Введіть пароль до ключа');
    await delay(300);
    if (password !== 'test') throw new Error('Пароль до ключа невірний (стенд: пароль «test»)');
    keyRead = true;
    return { owner: { subjFullName: 'Тестовий підписувач стенду', subjCN: 'Тестовий підписувач', subjDRFOCode: '3126509816' } };
  }

  async function sign(data) {
    if (!keyRead) throw new Error('Спершу зчитайте ключ');
    await delay(200);
    // п.1.6.3: дані без символу U+FEFF — як у справжньому kep.js
    return toBase64('SANDBOX-SIGNED\n' + String(data).replace(/﻿/g, ''));
  }

  async function reset() { keyRead = false; }
  async function available() { return true; }

  global.Kep = { listCAs, readKey, sign, reset, available, isKeyRead: () => keyRead };
})(window);
