import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, RefreshControl, ScrollView, View, StyleSheet } from 'react-native';

import { Button, Card, ErrorBox, Field, formatDate, Muted, Row, Text, Title, useColors } from '../components/ui';
import { ApiError } from '../lib/api';
import {
  type AuthMethod,
  MSG_CREATED,
  MSG_NO_ACTIVE_METHODS,
  MSG_RESENT,
  approveAuthMethodRequest,
  authMethodsNotice,
  canDeactivate,
  canRename,
  createAuthMethodRequest,
  deactivateAuthMethod,
  deactivateConfirmText,
  detailRows,
  errorMessage,
  fetchAuthMethods,
  methodTitle,
  methodTypeLabel,
  renameAuthMethod,
  resendAuthMethodOtp,
  validateAlias,
  validateOtp,
  validatePhone,
} from '../lib/authMethods';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';
import { useStyles, type Palette } from '../theme';

type Status = { type: 'ok' | 'error'; message: string } | null;
type Phase = 'form' | 'otp' | 'done';
type CardError = { id: string; message: string } | null;

function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

/** Повідомлення форми: помилка — через ErrorBox, успіх — зеленим із озвученням. */
function StatusMessage({ status }: { status: Status }) {
  const styles = useStyles(makeStyles);
  if (!status) return null;
  if (status.type === 'error') return <ErrorBox message={status.message} />;
  return (
    <Card tone="success">
      <Text style={styles.okText} accessibilityLiveRegion="polite">{status.message}</Text>
    </Card>
  );
}

/**
 * Методи автентифікації в ЕСОЗ (п.3.9.4): перелік, повідомлення п.3.9.4.2/3.9.4.3,
 * додавання номера телефону з підтвердженням кодом із SMS (п.3.10.3), зміна назви (п.3.10.4),
 * деактивація з підтвердженням.
 * Параметр add=1 відкриває форму додавання одразу (наприклад, з повідомлення на головному екрані).
 */
export default function AuthMethods() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const { status, token, handleApiError, signOut } = useSession();
  const params = useLocalSearchParams<{ add?: string | string[] }>();
  const addParam = Array.isArray(params.add) ? params.add[0] : params.add;
  const { data, error: loadError, loading, reload } = useLoader(
    () => fetchAuthMethods(token),
    status === 'unlocked' && Boolean(token),
  );

  // Помилка дії над конкретним методом — показується в його картці, а не вгорі списку
  const [cardError, setCardError] = useState<CardError>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Зміна назви (п.3.10.4)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  // Додавання методу (п.3.10.3)
  const [formOpen, setFormOpen] = useState(addParam === '1');
  const [phone, setPhone] = useState('');
  const [alias, setAlias] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [formStatus, setFormStatus] = useState<Status>(null);
  // Запит, що виконується ('submit', 'resend', 'rename:<id>', 'deactivate:<id>'): поки він триває,
  // інші кнопки дій неактивні. Ref — синхронний захист від подвійного натискання до перерендеру.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyRef = useRef(false);

  const ehealthRequired = loadError instanceof ApiError && loadError.ehealthRequired;
  useEffect(() => {
    if (loadError instanceof ApiError && loadError.unauthorized) handleApiError(loadError);
  }, [loadError, handleApiError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  const methods = data ?? [];
  const loaded = data !== undefined;
  const notice = loaded ? authMethodsNotice(methods) : null;
  const error = loadError && !ehealthRequired ? errorMessage(loadError) : null;
  const busy = busyAction !== null;

  /** Виконує запит-дію, лише якщо інша дія зараз не виконується. */
  async function run(action: string, fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction(action);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  /** Текст помилки дії; якщо доступ до ЕСОЗ у сесії припинено — перезавантаження покаже «Увійти знову». */
  function actionFailed(e: unknown): string {
    const message = handleApiError(e);
    if (e instanceof ApiError && e.ehealthRequired) reload();
    return message;
  }

  function refresh() {
    setCardError(null);
    reload();
  }

  function showFormStatus(next: Status) {
    setFormStatus(next);
    if (next?.type === 'ok') announce(next.message);
  }

  function openForm() {
    setPhone('');
    setAlias('');
    setCode('');
    setPhase('form');
    setRequestId(null);
    setFormStatus(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setRequestId(null);
    refresh();
  }

  function submit() {
    if (phase === 'form') {
      const invalid = validatePhone(phone);
      if (invalid) return showFormStatus({ type: 'error', message: invalid });
      void run('submit', async () => {
        try {
          const outcome = await createAuthMethodRequest(token, phone, alias);
          if (outcome.phase === 'error') return showFormStatus({ type: 'error', message: outcome.message });
          if (outcome.phase === 'done') {
            setPhase('done');
            reload();
          } else {
            setRequestId(outcome.requestId);
            setPhase('otp');
          }
          showFormStatus({ type: 'ok', message: outcome.message });
        } catch (e) {
          showFormStatus({ type: 'error', message: actionFailed(e) });
        }
      });
    } else if (phase === 'otp' && requestId) {
      const invalid = validateOtp(code);
      if (invalid) return showFormStatus({ type: 'error', message: invalid });
      void run('submit', async () => {
        try {
          await approveAuthMethodRequest(token, requestId, code);
          setRequestId(null);
          setPhase('done');
          showFormStatus({ type: 'ok', message: MSG_CREATED });
          reload();
        } catch (e) {
          showFormStatus({ type: 'error', message: actionFailed(e) });
        }
      });
    }
  }

  function resend() {
    if (!requestId) return;
    void run('resend', async () => {
      try {
        await resendAuthMethodOtp(token, requestId);
        showFormStatus({ type: 'ok', message: MSG_RESENT });
      } catch (e) {
        showFormStatus({ type: 'error', message: actionFailed(e) });
      }
    });
  }

  function startRename(m: AuthMethod) {
    setEditingId(m.id);
    setAliasDraft(String(m.alias ?? ''));
    setRenameError(null);
  }

  function saveRename(m: AuthMethod) {
    const invalid = validateAlias(aliasDraft);
    if (invalid) return setRenameError(invalid);
    void run(`rename:${m.id}`, async () => {
      try {
        await renameAuthMethod(token, m.id, aliasDraft);
        setEditingId(null);
        setRenameError(null);
        reload();   // п.3.10.4.1.1: показати нову назву
      } catch (e) {
        setRenameError(actionFailed(e));
      }
    });
  }

  function deactivate(m: AuthMethod) {
    if (busyRef.current) return;
    Alert.alert('Деактивація методу автентифікації', deactivateConfirmText(m, methods), [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Деактивувати', style: 'destructive', onPress: () => void run(`deactivate:${m.id}`, async () => {
          setCardError(null);
          try {
            await deactivateAuthMethod(token, m.id);
            reload();
          } catch (e) {
            setCardError({ id: m.id, message: actionFailed(e) });
          }
        }),
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
                refreshControl={<RefreshControl refreshing={loading && loaded} onRefresh={refresh} />}>
      {ehealthRequired ? (
        <Card tone="warning">
          <Text style={styles.text}>Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.</Text>
          <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
        </Card>
      ) : null}
      <Title>Методи автентифікації в ЕСОЗ</Title>
      <ErrorBox message={error} />
      {notice ? (
        <Card tone="warning"><Text style={styles.noticeText}>{notice}</Text></Card>
      ) : null}

      {loaded && !formOpen && !ehealthRequired ? (
        <Button title="Додати номер телефону для входу" onPress={openForm}
                accessibilityHint="Відкриває форму додавання методу автентифікації за номером телефону" />
      ) : null}

      {formOpen && !ehealthRequired ? (
        <Card>
          <Text style={styles.sectionTitle} accessibilityRole="header">Новий метод автентифікації (SMS)</Text>
          <Field label="Номер мобільного телефону *" value={phone} onChangeText={setPhone} placeholder="+380XXXXXXXXX"
                 keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber"
                 editable={phase === 'form'} accessibilityState={{ disabled: phase !== 'form' }} />
          <Field label="Назва методу (щоб ви його впізнали)" value={alias} onChangeText={setAlias}
                 placeholder="Напр.: мій телефон" editable={phase === 'form'} accessibilityState={{ disabled: phase !== 'form' }} />
          {phase === 'otp' ? (
            <View style={styles.otpBox}>
              <Field label="Код із SMS *" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6}
                     autoComplete="sms-otp" textContentType="oneTimeCode" />
              <Button title="Надіслати код повторно" variant="secondary" onPress={resend}
                      busy={busyAction === 'resend'} disabled={busy}
                      accessibilityHint="Надсилає SMS з кодом підтвердження ще раз" />
            </View>
          ) : null}
          <StatusMessage status={formStatus} />
          {phase !== 'done' ? (
            <Button title={phase === 'form' ? 'Додати' : 'Підтвердити'} onPress={submit}
                    busy={busyAction === 'submit'} disabled={busy} />
          ) : null}
          <Button title="Закрити" variant="secondary" onPress={closeForm} disabled={busyAction === 'submit'} />
        </Card>
      ) : null}

      {loading && !loaded ? <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Завантаження" /> : null}
      {loaded && methods.length === 0 ? <Muted>{MSG_NO_ACTIVE_METHODS}</Muted> : null}

      {methods.map((m) => {
        const title = methodTitle(m);
        const expanded = expandedId === m.id;
        const editing = editingId === m.id;
        return (
          <Card key={m.id}>
            <Row label="Тип" value={methodTypeLabel(m.type)} />
            <Row label="Номер телефону" value={m.phone_number} />
            <Row label="Назва" value={m.alias} />
            <Row label="Діє з" value={formatDate(m.started_at)} />
            {editing ? (
              <View style={styles.inline}>
                <Field label="Нова назва методу автентифікації" value={aliasDraft} onChangeText={setAliasDraft} autoFocus />
                <ErrorBox message={renameError} />
                <Button title="Зберегти назву" onPress={() => saveRename(m)}
                        busy={busyAction === `rename:${m.id}`} disabled={busy} />
                <Button title="Скасувати" variant="secondary" onPress={() => setEditingId(null)}
                        disabled={busyAction === `rename:${m.id}`} />
              </View>
            ) : canRename(m) ? (
              <Button title="Змінити назву" variant="secondary" onPress={() => startRename(m)}
                      accessibilityHint={`Метод «${title}»`} />
            ) : null}
            <Button title={expanded ? 'Сховати деталі' : 'Деталі'} variant="secondary"
                    onPress={() => setExpandedId(expanded ? null : m.id)} accessibilityHint={`Усі відомості про метод «${title}»`} />
            {expanded ? (
              <View style={styles.details}>
                {detailRows(m).map((r) => <Row key={r.key} label={r.label} value={r.value} />)}
              </View>
            ) : null}
            {cardError?.id === m.id ? <ErrorBox message={cardError.message} /> : null}
            {canDeactivate(m) ? (
              <Button title="Деактивувати" variant="danger" onPress={() => deactivate(m)}
                      busy={busyAction === `deactivate:${m.id}`} disabled={busy}
                      accessibilityHint={`Метод «${title}»`} />
            ) : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  text: { fontSize: 15, color: colors.text },
  noticeText: { fontSize: 15, color: colors.attention, lineHeight: 21 },
  okText: { fontSize: 15, color: colors.ink },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  otpBox: { gap: 8, padding: 12, borderRadius: 10, backgroundColor: colors.accentTint, borderWidth: 1, borderColor: colors.hairline },
  inline: { gap: 8 },
  details: { borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: 8 },
});
