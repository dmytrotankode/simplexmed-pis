import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Button, ErrorBox, Muted, Screen } from '../components/ui';
import { API_BASE } from '../lib/config';
import { isSameOrigin, settleSignature, takePendingSignature } from '../lib/kepBridge';
import { useStyles, type Palette } from '../theme';

const MSG_LOAD_FAILED = 'Не вдалося завантажити сторінку електронного підпису. Перевірте з’єднання з інтернетом і спробуйте ще раз.';
const MSG_SIGN_FAILED = 'Не вдалося накласти електронний підпис.';

/**
 * Підпис КЕП: сторінка mobile-sign.html кабінету з бібліотекою ІІТ у WebView.
 * Файл ключа і пароль обробляються лише у WebView на пристрої; застосунок отримує готовий підпис.
 * Помилка завантаження сторінки — повідомлення з повтором і закриттям; помилка підпису від сторінки
 * ({type:'error'}) — повідомлення над формою (підписати можна ще раз у тій самій формі).
 */
export default function KepSign() {
  const styles = useStyles(makeStyles);
  const request = takePendingSignature();
  const webview = useRef<WebView>(null);
  const settled = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => () => {
    // Закриття екрана без підпису — скасування
    if (!settled.current) settleSignature({ error: new Error('Підпис скасовано') });
  }, []);

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  function retry() {
    setLoadError(null);
    setSignError(null);
    setAttempt((n) => n + 1);
  }

  if (!request) {
    return (
      <Screen>
        <ErrorBox message="Немає даних для підпису. Поверніться і почніть знову." />
        <Button title="Закрити" variant="secondary" onPress={close} />
      </Screen>
    );
  }

  function onMessage(event: WebViewMessageEvent) {
    // Повідомлення приймаються лише від сторінки кабінету
    if (!isSameOrigin(event.nativeEvent.url, API_BASE)) return;
    let msg: { type?: string; signed?: string; message?: unknown };
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      webview.current?.postMessage(JSON.stringify({ type: 'sign', data: request!.data, title: request!.title, purpose: request!.purpose }));
    } else if (msg.type === 'signed' && msg.signed) {
      settled.current = true;
      setSignError(null);
      settleSignature({ signed: msg.signed });
      router.back();
    } else if (msg.type === 'error') {
      setSignError(typeof msg.message === 'string' && msg.message.trim() ? msg.message : MSG_SIGN_FAILED);
    }
  }

  if (loadError) {
    return (
      <Screen>
        <ErrorBox message={loadError} />
        <Button title="Спробувати ще раз" onPress={retry} />
        <Button title="Закрити" variant="secondary" onPress={close} accessibilityHint="Скасовує підпис" />
      </Screen>
    );
  }

  return (
    <View style={styles.screen}>
      {signError ? (
        <View style={styles.banner}>
          <ErrorBox message={signError} />
          <Muted>Перевірте файл ключа і пароль та підпишіть ще раз або закрийте підпис.</Muted>
          <Button title="Закрити" variant="secondary" onPress={close} accessibilityHint="Скасовує підпис" />
        </View>
      ) : null}
      <WebView
        key={attempt}
        ref={webview}
        source={{ uri: `${API_BASE}/mobile-sign.html` }}
        onMessage={onMessage}
        onError={() => setLoadError(MSG_LOAD_FAILED)}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 400) setLoadError(`${MSG_LOAD_FAILED} (HTTP ${e.nativeEvent.statusCode})`);
        }}
        // Власний екран помилки замість системної сторінки WebView (англійською)
        renderError={() => <View style={styles.screen} />}
        // originWhitelist ['*']: «чужі» адреси react-native-webview інакше відкриває в зовнішньому браузері;
        // сторінка не повинна переходити на інші ресурси — точна перевірка походження (не префікс рядка)
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={(req) => isSameOrigin(req.url, API_BASE) || req.url === 'about:blank'}
        setSupportMultipleWindows={false}
        incognito
        allowFileAccess={false}
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  banner: { padding: 16, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.hairline },
});
