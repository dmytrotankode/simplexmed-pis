import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { ErrorBox, Screen } from '../components/ui';
import { API_BASE } from '../lib/config';
import { isSameOrigin, settleSignature, takePendingSignature } from '../lib/kepBridge';

/**
 * Підпис КЕП: сторінка mobile-sign.html кабінету з бібліотекою ІІТ у WebView.
 * Файл ключа і пароль обробляються лише у WebView на пристрої; застосунок отримує готовий підпис.
 */
export default function KepSign() {
  const request = takePendingSignature();
  const webview = useRef<WebView>(null);
  const settled = useRef(false);

  useEffect(() => () => {
    // Закриття екрана без підпису — скасування
    if (!settled.current) settleSignature({ error: new Error('Підпис скасовано') });
  }, []);

  if (!request) {
    return <Screen><ErrorBox message="Немає даних для підпису. Поверніться і почніть знову." /></Screen>;
  }

  function onMessage(event: WebViewMessageEvent) {
    // Повідомлення приймаються лише від сторінки кабінету
    if (!isSameOrigin(event.nativeEvent.url, API_BASE)) return;
    let msg: { type?: string; signed?: string; message?: string };
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      webview.current?.postMessage(JSON.stringify({ type: 'sign', data: request!.data, title: request!.title, purpose: request!.purpose }));
    } else if (msg.type === 'signed' && msg.signed) {
      settled.current = true;
      settleSignature({ signed: msg.signed });
      router.back();
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <WebView
        ref={webview}
        source={{ uri: `${API_BASE}/mobile-sign.html` }}
        onMessage={onMessage}
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
