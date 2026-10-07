import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

/**
 * Збереження документів на пристрої через системне меню «Поділитися / Зберегти»:
 * політика конфіденційності як текстовий файл (п.3.3.1.1, 3.5.1.1) і форми декларацій у PDF
 * (п.3.11.1.13.3, 3.11.2.2.1, 3.11.3.3).
 */

/** Назва файлу без символів, які ламають шляхи або заборонені для копій документів (п.3.6.1). */
export function safeFileName(base: string, ext: string): string {
  const name = base.trim().replace(/[ЫЪЭЁыъэё@%&$^#]/g, '').replace(/[^0-9A-Za-zА-ЩЬЮЯҐЄІЇа-щьюяґєії_-]+/g, '_')
    .replace(/_+/g, '_').replace(/^_|_$/g, '');
  return `${name || 'document'}.${ext}`;
}

/** HTML форми з кодуванням UTF-8, щоб кирилиця в PDF не спотворилася. */
export function htmlForPdf(html: string): string {
  if (/<meta[^>]+charset/i.test(html)) return html;
  const meta = '<meta charset="utf-8">';
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

async function share(uri: string, mimeType: string, UTI: string, dialogTitle: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Збереження файлів недоступне на цьому пристрої');
  await Sharing.shareAsync(uri, { mimeType, UTI, dialogTitle });
}

/** Текст у файл .txt у кеші застосунку і меню збереження. */
export async function shareTextFile(baseName: string, text: string, dialogTitle: string): Promise<void> {
  const file = new File(Paths.cache, safeFileName(baseName, 'txt'));
  file.create({ overwrite: true });
  file.write(text.replace(/﻿/g, ''));
  await share(file.uri, 'text/plain', 'public.plain-text', dialogTitle);
}

/** HTML-форма ЕСОЗ у PDF і меню збереження. */
export async function shareHtmlAsPdf(baseName: string, html: string, dialogTitle: string): Promise<void> {
  const printed = await Print.printToFileAsync({ html: htmlForPdf(html) });
  const target = new File(Paths.cache, safeFileName(baseName, 'pdf'));
  await new File(printed.uri).move(target, { overwrite: true });
  await share(target.uri, 'application/pdf', 'com.adobe.pdf', dialogTitle);
}
