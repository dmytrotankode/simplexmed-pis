/* eslint-disable import/first -- jest.mock має стояти до імпортів модулів, які він підміняє */
jest.mock('expo-constants', () => ({ expoConfig: { extra: { pisApiBase: 'https://pis.test', ehealthEnv: 'pis-app' } } }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), Paths: { cache: {} } }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

import { htmlForPdf, safeFileName } from '../lib/exportFiles';
import { isSameOrigin } from '../lib/kepBridge';
import { REGISTRATION_DOCUMENT_TYPES, signUpNeedsDocuments } from '../lib/personForm';
import {
  dictText, groupDocuments, lacksResidence, maskSecret, noTaxIdText, preferredWayText, splitLinks, verificationReasonText,
  verificationStatusText,
} from '../lib/personRecord';

describe('запис про пацієнта (п.3.9.2)', () => {
  test('документи групуються: посвідчення особи / про набуття цивільної дієздатності', () => {
    const { identity, capacity } = groupDocuments([
      { type: 'PASSPORT', number: 'АА1' },
      { type: 'BIRTH_CERTIFICATE_FOREIGN', number: 'F-1' },
      { type: 'MARRIAGE_CERTIFICATE', number: 'M-1' },
      null,
    ]);
    expect(identity.map((d) => d.type)).toEqual(['PASSPORT', 'BIRTH_CERTIFICATE_FOREIGN']);
    expect(capacity.map((d) => d.type)).toEqual(['MARRIAGE_CERTIFICATE']);
    expect(groupDocuments(undefined)).toEqual({ identity: [], capacity: [] });
  });

  test('перелік документів реєстрації — як у ТВ ПІС v2 п.3.4.5.9.a (9 типів)', () => {
    expect([...REGISTRATION_DOCUMENT_TYPES].sort()).toEqual([
      'BIRTH_CERTIFICATE', 'BIRTH_CERTIFICATE_FOREIGN', 'COMPLEMENTARY_PROTECTION_CERTIFICATE', 'NATIONAL_ID', 'PASSPORT',
      'PERMANENT_RESIDENCE_PERMIT', 'REFUGEE_CERTIFICATE', 'TEMPORARY_CERTIFICATE', 'TEMPORARY_PASSPORT',
    ]);
  });

  test('значення довідників, порожні атрибути, відмова від РНОКПП, спосіб зв’язку, кодове слово', () => {
    const dicts = { GENDER: [{ code: 'MALE', description: 'Чоловіча' }] };
    expect(dictText(dicts, 'GENDER', 'MALE')).toBe('Чоловіча');
    expect(dictText(dicts, 'GENDER', 'FEMALE')).toBe('FEMALE');   // немає опису — код
    expect(dictText(dicts, 'GENDER', null)).toBe('');              // немає значення — порожньо
    expect(noTaxIdText(true)).toBe('Так');
    expect(noTaxIdText(false)).toBe('Ні');
    expect(noTaxIdText(undefined)).toBe('');
    expect(preferredWayText('email')).toBe('Електронна пошта');
    expect(preferredWayText('phone')).toBe('Телефон');
    expect(preferredWayText(undefined)).toBe('');
    expect(maskSecret('Кодове1')).toBe('••••••');
    expect(maskSecret('')).toBe('');
  });

  test('немає адреси фактичного місця проживання (п.3.9.2.1.2.2)', () => {
    expect(lacksResidence([{ type: 'REGISTRATION' }])).toBe(true);
    expect(lacksResidence(undefined)).toBe(true);
    expect(lacksResidence([{ type: 'RESIDENCE' }])).toBe(false);
  });
});

describe('верифікація (п.3.9.3)', () => {
  test('статус і причина — описом із довідника, з резервними підписами', () => {
    const dicts = { PERSON_VERIFICATION_STATUS_REASONS: [{ code: 'DOCUMENTS_TRIGGERED', description: 'Оновлено документи' }] };
    expect(verificationReasonText(dicts, 'DOCUMENTS_TRIGGERED')).toBe('Оновлено документи');
    expect(verificationReasonText(dicts, null)).toBe('');
    expect(verificationStatusText({}, 'NOT_VERIFIED')).toBe('Не верифіковано');
    expect(verificationStatusText({ PERSON_VERIFICATION_STATUSES: [{ code: 'IN_REVIEW', description: 'Перевіряється' }] }, 'IN_REVIEW'))
      .toBe('Перевіряється');
  });

  test('посилання на портал підтримки НСЗУ стає натисканим (п.3.9.3.3)', () => {
    const parts = splitLinks('Створіть звернення за посиланням https://support.nszu.gov.ua/new?cat=5. Дякуємо');
    expect(parts).toEqual([
      { text: 'Створіть звернення за посиланням ' },
      { text: 'https://support.nszu.gov.ua/new?cat=5', url: 'https://support.nszu.gov.ua/new?cat=5' },
      { text: '. Дякуємо' },
    ]);
    expect(splitLinks('без посилань')).toEqual([{ text: 'без посилань' }]);
  });
});

describe('реєстрація: копії документів (п.3.5.8.2)', () => {
  test('посвідка на постійне проживання або документ про дієздатність для 14–18 років', () => {
    expect(signUpNeedsDocuments({ documents: [{ type: 'PERMANENT_RESIDENCE_PERMIT' }] }, false)).toBe(true);
    expect(signUpNeedsDocuments({ documents: [{ type: 'PASSPORT' }, { type: 'MARRIAGE_CERTIFICATE' }] }, true)).toBe(true);
    expect(signUpNeedsDocuments({ documents: [{ type: 'PASSPORT' }, { type: 'MARRIAGE_CERTIFICATE' }] }, false)).toBe(false);
    expect(signUpNeedsDocuments({ documents: [{ type: 'NATIONAL_ID' }] }, true)).toBe(false);
    expect(signUpNeedsDocuments({}, true)).toBe(false);
  });
});

describe('підпис КЕП у WebView: точна перевірка походження', () => {
  test('лише те саме походження; префікс рядка, userinfo і інша схема — ні', () => {
    const base = 'https://my-dev.simplex-med.com';
    expect(isSameOrigin('https://my-dev.simplex-med.com/mobile-sign.html', base)).toBe(true);
    expect(isSameOrigin('https://MY-DEV.simplex-med.com/lib/euscp/x.js', base)).toBe(true);
    expect(isSameOrigin('https://my-dev.simplex-med.com', base)).toBe(true);
    expect(isSameOrigin('https://my-dev.simplex-med.com.evil.com/', base)).toBe(false);
    expect(isSameOrigin('https://my-dev.simplex-med.com@evil.com/', base)).toBe(false);
    expect(isSameOrigin('http://my-dev.simplex-med.com/', base)).toBe(false);
    expect(isSameOrigin('https://my-dev.simplex-med.com:8443/', base)).toBe(false);
    expect(isSameOrigin(undefined, base)).toBe(false);
    expect(isSameOrigin('about:blank', base)).toBe(false);
  });
});

describe('збереження файлів (п.3.3.1.1, 3.11.3.3)', () => {
  test('назва файлу без заборонених символів (п.3.6.1) і розділювачів шляху', () => {
    expect(safeFileName('deklaratsiia_0000-1234-5678', 'pdf')).toBe('deklaratsiia_0000-1234-5678.pdf');
    expect(safeFileName('Декларація № 12/34', 'pdf')).toBe('Декларація_12_34.pdf');
    expect(safeFileName('ыЁ@%&$^#', 'txt')).toBe('document.txt');
    expect(safeFileName('../../etc/passwd', 'txt')).toBe('etc_passwd.txt');
  });

  test('PDF із кирилицею: кодування UTF-8 у формі', () => {
    expect(htmlForPdf('<html><head><title>x</title></head><body>Ф</body></html>'))
      .toBe('<html><head><meta charset="utf-8"><title>x</title></head><body>Ф</body></html>');
    expect(htmlForPdf('<p>Ф</p>')).toBe('<!doctype html><html><head><meta charset="utf-8"></head><body><p>Ф</p></body></html>');
    const withCharset = '<html><head><meta charset="windows-1251"></head></html>';
    expect(htmlForPdf(withCharset)).toBe(withCharset);
  });
});
