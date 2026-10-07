import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, View, StyleSheet } from 'react-native';

import { Button, Card, ErrorBox, formatDate, Muted, Row, Text, Title } from '../components/ui';
import { ApiError, api } from '../lib/api';
import {
  DOCUMENTS_COMPLETE_PATH, DOCUMENTS_PATH, DOCUMENTS_UPLOAD_PATH, DOCUMENT_TYPE_DICTIONARY_PATH, PERSON_REQUESTS_PATH,
  TEXTS, type DictionaryValue, type PendingDocument, type PersonRequestSummary,
  canContinue, documentTypeLabel, documentsCompleteResult, parseDictionary, pickDocumentFile, prepareUpload,
  statusLabel, uploadDocument,
} from '../lib/personRequests';
import { KEYS, deleteSecure } from '../lib/secure';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';
import { useStyles, type Palette } from '../theme';

type UploadState = { tone: 'info' | 'ok' | 'error'; message: string };
type Params = { documents?: string };

/**
 * Запити на зміну персональних даних (п.3.10.2) і копії документів (п.3.6).
 * ?documents=1 — показати завантаження копій документів одразу (напр., після реєстрації).
 */
export default function PersonRequests() {
  const styles = useStyles(makeStyles);
  const { status, token, handleApiError } = useSession();
  const { documents: documentsParam } = useLocalSearchParams<Params>();
  const enabled = status === 'unlocked' && Boolean(token);

  const { data, error: loadError, loading, reload } = useLoader(async () => {
    const [list, verification] = await Promise.all([
      api<{ data?: PersonRequestSummary[] }>(PERSON_REQUESTS_PATH, { token }),
      // Ознака п.3.9.3.5.f "потрібна передача копій документів"; помилка верифікації не заважає переліку
      api<{ display?: { documents_required?: boolean } }>('/ehealth/person/verification', { token }).catch(() => null),
    ]);
    let documents: PendingDocument[] = [];
    let documentTypes: DictionaryValue[] = [];
    let documentsError: string | null = null;
    if (documentsParam === '1' || verification?.display?.documents_required) {
      // п.3.6.1.1: помилку ініціалізації завантаження показуємо користувачу
      const init = await api<{ data?: PendingDocument[] }>(DOCUMENTS_PATH, { method: 'POST', token }).catch((e) => {
        if (e instanceof ApiError && e.unauthorized) throw e;
        documentsError = e instanceof Error ? e.message : 'Не вдалося підготувати завантаження документів';
        return null;
      });
      documents = (init?.data ?? []).filter((d) => d && d.type);
      if (documents.length) documentTypes = parseDictionary(await api(DOCUMENT_TYPE_DICTIONARY_PATH).catch(() => null));
      // Система не вимагає копій — нагадування після реєстрації (п.3.5.8.2) більше не потрібне
      else if (init) await deleteSecure(KEYS.documentsPending);
    }
    return { requests: list.data ?? [], documents, documentTypes, documentsError };
  }, enabled);

  const [actionError, setActionError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [busyType, setBusyType] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [documentsSent, setDocumentsSent] = useState(false);

  // Повернення з деталей запиту — оновити перелік (перший фокус збігається з першим завантаженням)
  const focusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedOnce.current) reload();
    focusedOnce.current = true;
  }, [reload]));

  const loadMessage = useMemo(() => (loadError ? handleApiError(loadError) : null), [loadError, handleApiError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  const requests = data?.requests ?? [];
  const documents = documentsSent ? [] : data?.documents ?? [];
  const documentTypes = data?.documentTypes ?? [];

  async function upload(type: string) {
    setActionError(null);
    setBusyType(type);
    try {
      const picked = await pickDocumentFile();
      if (!picked) return;
      const prepared = prepareUpload(picked);
      if (prepared.file === null) {
        const message = prepared.error;
        setUploads((u) => ({ ...u, [type]: { tone: 'error', message } }));
        return;
      }
      setUploads((u) => ({ ...u, [type]: { tone: 'info', message: TEXTS.uploading } }));
      await uploadDocument(DOCUMENTS_UPLOAD_PATH, type, prepared.file, token);
      setUploads((u) => ({ ...u, [type]: { tone: 'ok', message: TEXTS.uploaded } }));
    } catch (e) {
      const message = handleApiError(e);
      setUploads((u) => ({ ...u, [type]: { tone: 'error', message } }));
    } finally {
      setBusyType(null);
    }
  }

  async function completeDocuments() {
    setActionError(null);
    setCompleting(true);
    try {
      const r = await api<{ data?: unknown }>(DOCUMENTS_COMPLETE_PATH, { method: 'PATCH', token });
      const result = documentsCompleteResult(r);
      Alert.alert('Копії документів', result.message);
      if (result.done) {
        setDocumentsSent(true);
        void deleteSecure(KEYS.documentsPending);
      } else {
        setUploads({});
        reload();
      }
    } catch (e) {
      setActionError(handleApiError(e));
    } finally {
      setCompleting(false);
    }
  }

  function open(item: PersonRequestSummary) {
    if (!item.id) {
      setActionError(TEXTS.missingId);
      return;
    }
    router.push(`/person-request?id=${encodeURIComponent(item.id)}`);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}
                refreshControl={<RefreshControl refreshing={loading && Boolean(data)} onRefresh={reload} />}>
      <Title>Запити на зміну персональних даних</Title>
      {/* Як у веб-кабінеті: створення нового запиту — форма зміни даних (екран person-edit) */}
      <Button title="Змінити дані" onPress={() => router.push('/person-edit')}
              accessibilityHint="Відкрити форму зміни персональних даних" />
      <ErrorBox message={actionError ?? loadMessage} />
      {data?.documentsError && !documentsSent ? <ErrorBox message={data.documentsError} /> : null}

      {documents.length > 0 && (
        <Card tone="warning">
          <Text style={styles.header} accessibilityRole="header">{TEXTS.documentsTitle}</Text>
          <Muted>{TEXTS.documentsLimited}</Muted>
          {documents.map((d) => {
            const label = documentTypeLabel(documentTypes, d.type);
            const state = uploads[d.type];
            return (
              <View key={d.type} style={styles.docRow}>
                <Text style={styles.docLabel}>{label}</Text>
                <Button title="Обрати файл" variant="secondary" busy={busyType === d.type} disabled={busyType !== null || completing}
                        accessibilityHint={`Завантажити копію документа: ${label}`} onPress={() => void upload(d.type)} />
                {state ? (
                  <Text style={[styles.uploadStatus, state.tone === 'ok' && styles.ok, state.tone === 'error' && styles.err]}
                        accessibilityLiveRegion="polite" accessibilityRole={state.tone === 'error' ? 'alert' : undefined}>
                    {state.message}
                  </Text>
                ) : null}
              </View>
            );
          })}
          <Button title="Завершити завантаження" busy={completing} disabled={busyType !== null}
                  onPress={() => void completeDocuments()} />
        </Card>
      )}

      {data && requests.length === 0 && <Card><Muted>{TEXTS.noRequests}</Muted></Card>}
      {requests.map((item) => {
        const label = statusLabel(item.status);
        const created = formatDate(item.inserted_at);
        return (
          <Pressable key={item.id} onPress={() => open(item)} accessibilityRole="button"
                     accessibilityLabel={`Запит від ${created || 'невідомої дати'}, статус: ${label || 'невідомий'}`}
                     accessibilityHint={canContinue(item.status) ? 'Відкрити запит, щоб завантажити документи і підписати' : 'Відкрити деталі запиту'}
                     style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
            <Row label="Дата створення" value={created} />
            <Row label="Статус" value={label} />
            <Row label="Хто вніс зміни" value={item.channel} />
            <Text style={styles.more}>{canContinue(item.status) ? 'Продовжити ›' : 'Деталі ›'}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  header: { fontSize: 17, fontWeight: '700', color: colors.text },
  docRow: { gap: 6, paddingVertical: 6 },
  docLabel: { fontSize: 15, fontWeight: '600', color: colors.text },
  uploadStatus: { fontSize: 14, color: colors.muted },
  ok: { color: colors.success },
  err: { color: colors.danger },
  item: {
    backgroundColor: colors.card, borderRadius: 12, padding: 16, gap: 4, borderWidth: 1, borderColor: colors.hairline, minHeight: 44,
  },
  pressed: { opacity: 0.85 },
  more: { fontSize: 15, fontWeight: '600', color: colors.primary, marginTop: 4 },
});
