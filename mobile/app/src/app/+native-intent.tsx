import { deliverAuthCallback, isAuthCallbackUrl } from '../lib/auth';

/**
 * Вхідні посилання simplexpis:// до маршрутизації Expo Router.
 * simplexpis://auth/callback — повернення з ЕСОЗ, а не екран: його обробляє вхід (lib/auth), а маршрутизатор
 * лишається на поточному екрані (null) або, якщо застосунок запущено цим посиланням, відкриває початковий
 * екран «/» — без екрана «Unmatched Route». Вхід, перерваний вивантаженням застосунку, завершує екран входу.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    if (isAuthCallbackUrl(path)) {
      deliverAuthCallback(path);
      return initial ? '/' : null;
    }
    return path;
  } catch {
    return initial ? '/' : null;
  }
}
