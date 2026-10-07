import { Redirect, router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View, StyleSheet } from 'react-native';

import { PersonForm } from '../components/PersonForm';
import { Button, Card, ErrorBox, Muted, Text, Title, useColors } from '../components/ui';
import { ApiError, api } from '../lib/api';
import {
  PENDING_DECLARATION_REQUESTS_WARNING, type PersonFormValues, type Rec, buildPerson, errorSummary, fillFromPerson,
  hasPendingDeclarationRequests, mapFieldErrors, needsCapacityDoc, serverFieldErrors, validateDates,
} from '../lib/personForm';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';
import { useStyles, type Palette } from '../theme';

function confirmPendingRequests(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert('Зміна персональних даних', PENDING_DECLARATION_REQUESTS_WARNING, [
      { text: 'Скасувати', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Продовжити', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** Редактор з початковими значеннями із запису ЕСОЗ (fillPersonForm) і надсиланням запиту (submitPersonEdit). */
function PersonEditor({ person, token }: { person: Rec; token: string | null }) {
  const { handleApiError, touch } = useSession();
  const [initial] = useState(() => fillFromPerson(person));
  const [values, setValues] = useState<PersonFormValues>(initial.values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Введення з клавіатури не є дотиком до екрана — скидаємо таймер бездіяльності (п.2.9) при кожній зміні
  const onChange = (update: (prev: PersonFormValues) => PersonFormValues) => {
    touch();
    setValues(update);
  };

  function showErrors(list: { field: string; message: string }[]) {
    const mapped = mapFieldErrors(list, { capacityShown: needsCapacityDoc(values), hasPhone: Boolean(values.phone.trim()) });
    setErrors(mapped.byField);
    setMessages(mapped.messages);
  }

  async function submit() {
    const dateErrors = validateDates(values, needsCapacityDoc(values));
    if (dateErrors.length) {
      showErrors(dateErrors);
      return;
    }
    const person = buildPerson(values, initial.extras, { withAuthMethod: false });
    setBusy(true);
    try {
      // п.3.10.1.5: попередження, якщо є запити на декларацію в статусі NEW/APPROVED
      let pending = false;
      let checked = false;
      try {
        const dr = await api<{ data?: Rec[] }>('/ehealth/declaration-requests', { token });
        pending = hasPendingDeclarationRequests(dr.data ?? []);
        checked = true;
      } catch {
        pending = false;
      }
      if (pending && !(await confirmPendingRequests())) return;
      let id: string | undefined;
      try {
        const r = await api<{ data?: { id?: string } }>('/ehealth/person-requests', {
          method: 'POST', token, body: { person, process_disclosure_data_consent: true },
        });
        id = r.data?.id;
      } catch (e) {
        const fields = serverFieldErrors(e);
        if (fields) {
          showErrors(fields);
          return;
        }
        throw e;
      }
      if (!id) {
        setErrors({});
        setMessages(['ЕСОЗ не повернула ідентифікатор запиту']);
        return;
      }
      setErrors({});
      setMessages([]);
      // Крок 2 — документи і підпис запиту (екран person-request)
      // warned=1: попередження п.3.10.1.5 уже перевірено в цьому процесі — перед підписом не повторювати
      router.replace({ pathname: '/person-request', params: checked ? { id, warned: '1' } : { id } });
    } catch (e) {
      setErrors({});
      setMessages([handleApiError(e)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PersonForm mode="update" values={values} onChange={onChange} errors={errors} locks={initial.locks} token={token}
                  disabled={busy} />
      <ErrorBox message={errorSummary(messages)} />
      <Button title="Далі: документи та підпис" busy={busy} onPress={() => void submit()}
              accessibilityHint="Створює запит на зміну даних в ЕСОЗ і переходить до завантаження документів і підпису" />
      <Button title="Скасувати" variant="secondary" disabled={busy}
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))} />
    </>
  );
}

/** Зміна персональних даних (п.3.10.1 ТВ ПІС): запит на зміну запису про пацієнта в ЕСОЗ. */
export default function PersonEdit() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const { status, token, handleApiError, signOut } = useSession();
  // Після блокування і розблокування запис не перезавантажується — введені зміни зберігаються
  const loaded = useRef<Rec | null>(null);
  const { data, error: loadError, loading, reload } = useLoader(async () => {
    if (loaded.current) return loaded.current;
    const person = (await api<{ data?: Rec }>('/ehealth/person', { token })).data ?? {};
    loaded.current = person;
    return person;
  }, status === 'unlocked' && Boolean(token));

  const ehealthRequired = loadError instanceof ApiError && loadError.ehealthRequired;
  const error = useMemo(() => (loadError && !ehealthRequired ? handleApiError(loadError) : null),
    [loadError, ehealthRequired, handleApiError]);
  useEffect(() => {
    if (loadError instanceof ApiError && loadError.unauthorized) handleApiError(loadError);
  }, [loadError, handleApiError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
                automaticallyAdjustKeyboardInsets>
      <Title>Зміна персональних даних в ЕСОЗ</Title>
      <Muted>РНОКПП і УНЗР, внесені раніше, змінити неможливо. Зміни підписуються вашим КЕП. Поля, позначені *, обов’язкові.</Muted>
      {ehealthRequired ? (
        <Card tone="warning">
          <Text style={styles.warningText}>Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.</Text>
          <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
        </Card>
      ) : null}
      {error ? (
        <>
          <ErrorBox message={error} />
          <Button title="Спробувати ще раз" variant="secondary" busy={loading} onPress={reload} />
        </>
      ) : null}
      {data && !loadError ? (
        <PersonEditor person={data} token={token} />
      ) : !loadError ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Завантаження даних пацієнта" />
        </View>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  bg: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { paddingVertical: 32, alignItems: 'center' },
  warningText: { fontSize: 15, color: colors.attention },
});
