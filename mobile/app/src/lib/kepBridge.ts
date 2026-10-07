/**
 * Міст між екранами і екраном підпису КЕП (WebView з mobile-sign.html).
 * Екран, якому потрібен підпис, викликає requestSignature(); екран kep-sign забирає запит,
 * а результат повертається через resolve/reject.
 */
export type SignRequest = {
  data: string;
  title: string;
  purpose: string;
  resolve: (signed: string) => void;
  reject: (error: Error) => void;
};

let pending: SignRequest | null = null;

export function requestSignature(data: string, title: string, purpose: string): Promise<string> {
  if (pending) pending.reject(new Error('Попередній запит на підпис скасовано'));
  return new Promise<string>((resolve, reject) => {
    pending = { data, title, purpose, resolve, reject };
  });
}

export function takePendingSignature(): SignRequest | null {
  return pending;
}

export function settleSignature(result: { signed?: string; error?: Error }): void {
  const req = pending;
  pending = null;
  if (!req) return;
  if (result.signed) req.resolve(result.signed);
  else req.reject(result.error ?? new Error('Підпис скасовано'));
}

/** URL належить тому самому походженню (схема, хост, порт), що й base. "https://a.ua.evil.com" — не "https://a.ua". */
export function isSameOrigin(url: string | undefined, base: string): boolean {
  if (!url) return false;
  const origin = (u: string) => {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@]+)(?=[/?#]|$)/i.exec(u.trim());
    return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : null;
  };
  const a = origin(url);
  return a !== null && a === origin(base);
}
