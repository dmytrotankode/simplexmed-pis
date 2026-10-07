import { useCallback, useEffect, useRef, useState } from 'react';

type LoaderState<T> = { data?: T; error?: unknown; loading: boolean };

/**
 * Завантаження даних екрана: запит виконується, коли enabled = true, і повторно — за reload().
 * Стан оновлюється лише після відповіді (без синхронних setState в ефекті).
 */
export function useLoader<T>(fn: () => Promise<T>, enabled: boolean) {
  const [state, setState] = useState<LoaderState<T>>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fnRef.current().then(
      (data) => { if (!cancelled) setState({ data, loading: false }); },
      (error) => { if (!cancelled) setState({ error, loading: false }); },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, reload };
}
