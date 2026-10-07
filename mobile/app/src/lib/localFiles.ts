import { File, Paths } from 'expo-file-system';

/**
 * Локальні файли застосунку, що можуть містити персональні дані (п.1.4.2 ТВ ПІС), і ознака встановлення.
 */

/** Позначка в теці документів застосунку: її немає лише при першому запуску після встановлення. */
export const INSTALL_MARKER = '.installed';

/**
 * iOS не видаляє записи Keychain разом із застосунком: після перевстановлення в сховищі лишилися б
 * сесія і PIN-код попереднього встановлення. Тека документів при видаленні застосунку очищується,
 * тож без позначки — перший запуск: спершу стираємо захищене сховище (wipe), потім ставимо позначку.
 * true — це перший запуск після встановлення.
 */
export async function ensureFreshInstall(wipe: () => Promise<void>): Promise<boolean> {
  const marker = new File(Paths.document, INSTALL_MARKER);
  if (marker.exists) return false;
  await wipe();
  marker.create({ overwrite: true });
  return true;
}

/** Видалення файлу без винятків (файлу вже немає, немає доступу). */
export function deleteFileQuietly(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // файл міг бути видалений системою або належати іншому застосунку
  }
}

/**
 * Очищення кешу застосунку (експортовані PDF/TXT, копії обраних документів, кеш WebView і мережі)
 * під час виходу, стирання після невдалих спроб PIN-коду і видалення облікового запису.
 */
export function clearCacheDirectory(): void {
  try {
    for (const entry of Paths.cache.list()) {
      try {
        entry.delete();
      } catch {
        // файл використовується системою — пропускаємо
      }
    }
  } catch {
    // теки кешу ще немає
  }
}
