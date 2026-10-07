import { Redirect, Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { Button, Card, ErrorBox, formatDate, Muted, Row, Text, useColors } from '../components/ui';
import { ApiError } from '../lib/api';
import {
  FORM_UNAVAILABLE, REJECT_CONFIRM, SIGN_CONTINUE, SIGN_PURPOSE, SIGN_TITLE, errorMessage, fetchDeclarationRequest,
  fetchSignContent, isFormNavigationAllowed, nearLimitWarning, parsePlacesLeft, rejectDeclarationRequest, requestActions,
  requestFormContent, requestStatusLabel, shouldReloadAfterActionError, signDeclarationRequest, withViewport,
} from '../lib/declarationFlow';
import { shareHtmlAsPdf } from '../lib/exportFiles';
import { requestSignature } from '../lib/kepBridge';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';
import { useStyles, type Palette } from '../theme';

const SCREEN_OPTIONS = { title: 'Запит на декларацію' };

function confirmAsync(title: string, message: string, okText: string, destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Скасувати', style: 'cancel', onPress: () => resolve(false) },
      { text: okText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/**
 * Запит на декларацію (п.3.11.1.8–3.11.1.11, 3.11.2.2–3.11.2.3): форма від ЕСОЗ,
 * підпис КЕП даних, повернутих Системою, або відхилення запиту.
 */
export default function DeclarationRequestScreen() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const params = useLocalSearchParams<{ id?: string; left?: string }>();
  const requestId = (Array.isArray(params.id) ? params.id[0] : params.id) ?? '';
  const warning = nearLimitWarning(parsePlacesLeft(params.left));
  const { status, token, handleApiError, signOut } = useSession();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<'sign' | 'reject' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [savingPdf, setSavingPdf] = useState(false);
  // Синхронний замок від подвійного натискання: стан busy застосовується лише з наступним рендером
  const actionLock = useRef(false);
  const alive = useRef(true);
  const { data, error: loadError, loading, reload } = useLoader(
    () => fetchDeclarationRequest(token ?? '', requestId),
    status === 'unlocked' && Boolean(token) && Boolean(requestId),
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Недійсна сесія — локальний вихід (як на головному екрані)
  useEffect(() => {
    if (loadError instanceof ApiError && loadError.unauthorized) handleApiError(loadError);
  }, [loadError, handleApiError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  const shownError = actionError ?? loadError;
  const ehealthRequired = shownError instanceof ApiError && shownError.ehealthRequired;
  const message = !requestId ? 'Не вказано запит на декларацію. Поверніться до декларацій.'
    : shownError && !ehealthRequired ? errorMessage(shownError) : null;
  const content = requestFormContent(data);
  const { canSign, canReject } = requestActions(data?.status);
  const title = `Запит на декларацію ${data?.declaration_number ?? ''}`.trim();

  async function sign() {
    if (!token || actionLock.current) return;
    actionLock.current = true;
    setBusy('sign');
    setActionError(null);
    try {
      const { content: toSign, warning: signWarning } = await fetchSignContent(token, requestId);
      // п.3.11.1.10: попередження про ліміт декларацій лікаря
      if (signWarning && !(await confirmAsync('Попередження', `${signWarning}\n\n${SIGN_CONTINUE}`, 'Продовжити'))) return;
      const signing = requestSignature(toSign, SIGN_TITLE, SIGN_PURPOSE);
      router.push('/kep-sign');
      let signed: string;
      try {
        signed = await signing;
      } catch {
        return; // підпис скасовано
      }
      const result = await signDeclarationRequest(token, requestId, signed);
      router.dismissTo('/declarations');
      Alert.alert('Декларація', result);
    } catch (e) {
      handleApiError(e);
      if (alive.current) {
        setActionError(e);
        // Стан запиту міг змінитися (строк минув, запит скасовано) — перечитати відомості
        if (shouldReloadAfterActionError(e)) reload();
      }
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(null);
    }
  }

  async function reject() {
    if (!token || actionLock.current) return;
    actionLock.current = true;
    try {
      if (!(await confirmAsync('Відхилення запиту', REJECT_CONFIRM, 'Відхилити', true))) return;
      setBusy('reject');
      setActionError(null);
      await rejectDeclarationRequest(token, requestId);
      router.dismissTo('/declarations');
    } catch (e) {
      handleApiError(e);
      if (alive.current) {
        setActionError(e);
        if (shouldReloadAfterActionError(e)) reload();
      }
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(null);
    }
  }

  // п.3.11.1.13.3, 3.11.2.2.1: форма Декларації з можливістю завантаження у PDF
  async function savePdf() {
    if (!content) return;
    setSavingPdf(true);
    try {
      await shareHtmlAsPdf(`zapyt_deklaratsii_${data?.declaration_number ?? requestId}`, content, 'Зберегти форму декларації у PDF');
    } catch (e) {
      Alert.alert('PDF', e instanceof Error ? e.message : 'Не вдалося зберегти PDF');
    } finally {
      if (alive.current) setSavingPdf(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <Stack.Screen options={SCREEN_OPTIONS} />
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {data ? <Text style={styles.status}>Статус: {requestStatusLabel(data.status)}</Text> : null}
        {warning && canSign ? <Card tone="warning"><Text style={styles.text}>{warning}</Text></Card> : null}
        {ehealthRequired ? (
          <Card tone="warning">
            <Text style={styles.text}>Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.</Text>
            <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
          </Card>
        ) : null}
        <ErrorBox message={message} />
        {loadError && !data && !ehealthRequired ? <Button title="Спробувати ще раз" variant="secondary" onPress={reload} /> : null}
      </View>

      {loading && !data && requestId ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Завантаження запиту" />
        </View>
      ) : content ? (
        <View style={styles.formBox}>
          {/* HTML форми від ЕСОЗ — без JavaScript і переходів */}
          {/* originWhitelist ['*']: інакше react-native-webview відкриває «чужі» адреси в зовнішньому браузері;
              переходи блокує onShouldStartLoadWithRequest */}
          <WebView
            source={{ html: withViewport(content) }}
            javaScriptEnabled={false}
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(r) => isFormNavigationAllowed(r.url)}
            setSupportMultipleWindows={false}
            accessibilityLabel="Форма декларації"
          />
        </View>
      ) : data ? (
        <ScrollView contentContainerStyle={styles.details}>
          <Card>
            <Row label="Номер декларації" value={data.declaration_number} />
            <Row label="Статус" value={requestStatusLabel(data.status)} />
            <Row label="Дата" value={formatDate(data.start_date || data.inserted_at)} />
            <Muted>{FORM_UNAVAILABLE}</Muted>
            <Pressable onPress={() => setShowRaw((s) => !s)} accessibilityRole="button" accessibilityState={{ expanded: showRaw }}
                       style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
              <Text style={styles.linkText}>Усі відомості</Text>
            </Pressable>
            {showRaw ? <Text style={styles.raw} selectable>{JSON.stringify(data, null, 2)}</Text> : null}
          </Card>
        </ScrollView>
      ) : <View style={styles.flex} />}

      {content ? (
        <View style={styles.pdf}>
          <Button title="Завантажити PDF" variant="secondary" busy={savingPdf} onPress={() => void savePdf()} />
        </View>
      ) : null}
      {data && (canReject || (canSign && content)) ? (
        <View style={styles.actions}>
          {canReject ? (
            <View style={styles.flex}>
              <Button title="Відхилити запит" variant="danger" onPress={() => void reject()}
                      busy={busy === 'reject'} disabled={Boolean(busy)} />
            </View>
          ) : null}
          {canSign && content ? (
            <View style={styles.flex}>
              <Button title="Підписати КЕП" variant="success" onPress={() => void sign()}
                      busy={busy === 'sign'} disabled={Boolean(busy)}
                      accessibilityHint="Відкриває підпис декларації кваліфікованим електронним підписом" />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 8 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  status: { fontSize: 15, color: colors.muted },
  text: { fontSize: 15, color: colors.text, lineHeight: 21 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  formBox: { flex: 1, marginHorizontal: 16, borderWidth: 1, borderColor: colors.hairline, borderRadius: 12, overflow: 'hidden',
             backgroundColor: colors.surface },
  details: { padding: 16, gap: 12 },
  flex: { flex: 1 },
  actions: { flexDirection: 'row', gap: 12, padding: 16 },
  pdf: { paddingHorizontal: 16, paddingTop: 12 },
  link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { fontSize: 16, color: colors.primary, textDecorationLine: 'underline' },
  pressed: { opacity: 0.8 },
  raw: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, color: colors.text,
         backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline, borderRadius: 8, padding: 10 },
});
