import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Alert, Modal, Platform, RefreshControl, ScrollView, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { Button, Card, ErrorBox, formatDate, Muted, Row, Text, Title } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { isFormNavigationAllowed } from '../lib/declarationFlow';
import { requestSignature } from '../lib/kepBridge';
import { PENDING_DECLARATION_REQUESTS_WARNING, type Rec, hasPendingDeclarationRequests } from '../lib/personForm';
import {
  DOCUMENT_TYPE_DICTIONARY_PATH, TEXTS, type DictionaryValue, type PersonRequestDetails,
  canContinue, canReject, completePayload, createExclusive, documentTypeLabel, documentsInfo, errorMessage, firstParam,
  isEhealthRequired, parseDictionary, pendingDocuments, personFullName, personRequestPath, pickDocumentFile, prepareUpload,
  statusLabel, uploadDocument,
} from '../lib/personRequests';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';
import { useStyles, type Palette } from '../theme';

type UploadState = { tone: 'info' | 'ok' | 'error'; message: string };
type Params = { id?: string | string[]; warned?: string | string[] };
type Busy = 'sign' | 'reject' | 'upload' | null;

function confirmPendingDeclarationRequests(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert('Зміна персональних даних', PENDING_DECLARATION_REQUESTS_WARNING, [
      { text: 'Скасувати', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Продовжити', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

function confirmReject(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert('Скасування запиту', TEXTS.rejectConfirm, [
      { text: 'Ні', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Скасувати запит', style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/**
 * Запит на зміну персональних даних (п.3.10.1.2–3.10.1.7, п.3.10.2.2): відомості, електронна форма,
 * копії документів, підпис КЕП і скасування запиту.
 */
export default function PersonRequest() {
  const styles = useStyles(makeStyles);
  const { id: rawId, warned } = useLocalSearchParams<Params>();
  const id = firstParam(rawId);
  // Попередження п.3.10.1.5 уже показано на екрані зміни даних у цьому ж процесі
  const alreadyWarned = firstParam(warned) === '1';
  const { status, token, handleApiError, signOut } = useSession();

  const { data, error: loadError, loading, reload } = useLoader(async () => {
    const details = await api<PersonRequestDetails>(personRequestPath(id), { token });
    let documentTypes: DictionaryValue[] = [];
    if (pendingDocuments(details).length) {
      documentTypes = parseDictionary(await api(DOCUMENT_TYPE_DICTIONARY_PATH).catch(() => null));
    }
    return { details, documentTypes };
  }, status === 'unlocked' && Boolean(token) && Boolean(id));

  const [actionError, setActionError] = useState<string | null>(null);
  const [ehealthLost, setEhealthLost] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [form, setForm] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Одна дія за раз (підпис, скасування, завантаження) — навіть за подвійного натискання до перерендеру
  const [exclusive] = useState(createExclusive);

  // Недійсна сесія — локальний вихід (побічна дія — в ефекті, не під час рендеру)
  useEffect(() => {
    if (loadError instanceof ApiError && loadError.unauthorized) handleApiError(loadError);
  }, [loadError, handleApiError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  const loadEhealthRequired = isEhealthRequired(loadError);
  const loadMessage = loadError && !loadEhealthRequired ? errorMessage(loadError) : null;
  const details = data?.details ?? null;
  const request = details?.data ?? null;
  const docs = pendingDocuments(details);
  const documentTypes = data?.documentTypes ?? [];
  const requestStatus = request?.status;
  const fullName = personFullName(request?.person);

  /** Текст помилки дії; втрата доступу до ЕСОЗ — картка з повторним входом замість тексту. */
  function failure(e: unknown): string | null {
    const message = handleApiError(e);
    if (isEhealthRequired(e)) {
      setEhealthLost(true);
      return null;
    }
    return message;
  }

  // Повернення до переліку; якщо екран відкрито без історії — перехід на перелік запитів
  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/person-requests');
  }

  function showForm() {
    const html = request?.content;
    if (!html) {
      setActionError(TEXTS.formUnavailable);
      return;
    }
    setActionError(null);
    setForm(html);
  }

  function setUploadState(type: string, state: UploadState) {
    setUploads((u) => ({ ...u, [type]: state }));
    if (state.tone !== 'info') AccessibilityInfo.announceForAccessibility(state.message);
  }

  const upload = (type: string) => exclusive(async () => {
    setActionError(null);
    setBusy('upload');
    setUploadingType(type);
    try {
      const picked = await pickDocumentFile();
      if (!picked) return;
      const prepared = prepareUpload(picked);
      if (prepared.file === null) {
        setUploadState(type, { tone: 'error', message: prepared.error });
        return;
      }
      setUploadState(type, { tone: 'info', message: TEXTS.uploading });
      await uploadDocument(personRequestPath(id, '/documents/upload'), type, prepared.file, token);
      setUploadState(type, { tone: 'ok', message: TEXTS.uploaded });
    } catch (e) {
      const message = failure(e);
      if (message) {
        setUploadState(type, { tone: 'error', message });
      } else {
        setUploads((u) => {
          const next = { ...u };
          delete next[type];
          return next;
        });
      }
    } finally {
      setBusy(null);
      setUploadingType(null);
    }
  });

  // п.3.10.1.4–3.10.1.6: дані для підпису від BFF (без змін) -> КЕП -> Complete
  const sign = () => exclusive(async () => {
    setActionError(null);
    setBusy('sign');
    try {
      // п.3.10.1.5: перед підписанням — попередження, якщо є запити на декларацію NEW/APPROVED
      // (зокрема коли процес відновлено з переліку запитів, п.3.10.1.7)
      if (!alreadyWarned) {
        const dr = await api<{ data?: Rec[] }>('/ehealth/declaration-requests', { token }).catch(() => null);
        if (dr && hasPendingDeclarationRequests(dr.data ?? []) && !(await confirmPendingDeclarationRequests())) return;
      }
      const r = await api<{ content?: string }>(personRequestPath(id, '/sign-content'), { token });
      if (typeof r.content !== 'string' || !r.content) throw new Error(TEXTS.noSignContent);
      const signing = requestSignature(r.content, TEXTS.signTitle, TEXTS.signPurpose);
      router.push('/kep-sign');
      const signed = await signing;
      await api(personRequestPath(id, '/complete'), { method: 'PATCH', token, body: completePayload(signed) });
      Alert.alert('Зміна персональних даних', TEXTS.completed, [{ text: 'Гаразд', onPress: goBack }],
                  { cancelable: false });
    } catch (e) {
      setActionError(failure(e));
    } finally {
      setBusy(null);
    }
  });

  const reject = () => exclusive(async () => {
    if (!(await confirmReject())) return;
    setActionError(null);
    setBusy('reject');
    try {
      await api(personRequestPath(id, '/reject'), { method: 'PATCH', token });
      goBack();
    } catch (e) {
      setActionError(failure(e));
    } finally {
      setBusy(null);
    }
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}
                refreshControl={<RefreshControl refreshing={loading && Boolean(data)} onRefresh={reload} />}>
      <Title>Запит на зміну персональних даних</Title>
      {ehealthLost || loadEhealthRequired ? (
        <Card tone="warning">
          <Text style={styles.warningText}>{TEXTS.ehealthLost}</Text>
          <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
        </Card>
      ) : null}
      <ErrorBox message={!id ? TEXTS.noRequestId : actionError ?? loadMessage} />
      {id && loadMessage && !data ? (
        <Button title={TEXTS.retry} variant="secondary" busy={loading} onPress={reload} />
      ) : null}
      {!data && !loadError && loading && id ? <Muted>{TEXTS.loading}</Muted> : null}

      {request && (
        <Card>
          <Row label="Статус" value={statusLabel(requestStatus)} />
          <Row label="Дата створення" value={formatDate(request.inserted_at)} />
          <Row label="Дата оновлення" value={formatDate(request.updated_at)} />
          <Row label="Хто вніс зміни" value={request.channel} />
          {fullName ? <Row label="Пацієнт" value={fullName} /> : null}
          {request.person?.birth_date ? <Row label="Дата народження" value={formatDate(request.person.birth_date)} /> : null}
          {request.person ? (
            // п.3.10.2.2.1: електронна форма — за умови, що ЕСОЗ повернула дані Користувача (person)
            <Button title="Переглянути форму" variant="secondary" onPress={showForm}
                    accessibilityHint="Відкрити електронну форму запиту" />
          ) : null}
        </Card>
      )}

      {request && canContinue(requestStatus) && (
        <Card>
          <Text style={styles.header} accessibilityRole="header">Документи та підпис</Text>
          <Muted>{documentsInfo(docs.length)}</Muted>
          {docs.map((d) => {
            const label = documentTypeLabel(documentTypes, d.type);
            const state = uploads[d.type];
            return (
              <View key={d.type} style={styles.docRow}>
                <Text style={styles.docLabel}>{label}</Text>
                <Button title="Обрати файл" variant="secondary" busy={uploadingType === d.type}
                        disabled={busy !== null} accessibilityHint={`Завантажити копію документа: ${label}`}
                        onPress={() => void upload(d.type)} />
                {state ? (
                  <Text style={[styles.uploadStatus, state.tone === 'ok' && styles.ok, state.tone === 'error' && styles.err]}
                        accessibilityLiveRegion="polite" accessibilityRole={state.tone === 'error' ? 'alert' : undefined}>
                    {state.message}
                  </Text>
                ) : null}
              </View>
            );
          })}
          <Muted>{TEXTS.signAfterDocuments}</Muted>
          <Button title="Підписати КЕП" variant="success" busy={busy === 'sign'} disabled={busy !== null}
                  accessibilityHint="Відкрити екран електронного підпису" onPress={() => void sign()} />
        </Card>
      )}

      {request && canReject(requestStatus) && (
        <Button title="Скасувати запит" variant="danger" busy={busy === 'reject'} disabled={busy !== null}
                accessibilityHint="Скасування запиту незворотне" onPress={() => void reject()} />
      )}

      {details && (
        <Button title={showAll ? 'Сховати відомості' : 'Усі відомості'} variant="secondary"
                onPress={() => setShowAll((v) => !v)} accessibilityHint="Показати всі атрибути запиту від ЕСОЗ" />
      )}
      {details && showAll && (
        <Card>
          <Text selectable style={styles.json}>{JSON.stringify(details, null, 2)}</Text>
        </Card>
      )}

      <Modal visible={form !== null} animationType="slide" onRequestClose={() => setForm(null)}>
        <SafeAreaView style={styles.modal}>
          <Text style={styles.modalTitle} accessibilityRole="header">Електронна форма</Text>
          {/* HTML форми від ЕСОЗ — без JavaScript, переходів і нових вікон (target="_blank" на Android) */}
          {/* originWhitelist ['*']: інакше react-native-webview відкриває «чужі» адреси в зовнішньому браузері */}
          <WebView source={{ html: form ?? '' }} javaScriptEnabled={false} originWhitelist={['*']}
                   onShouldStartLoadWithRequest={(r) => isFormNavigationAllowed(r.url)} allowFileAccess={false}
                   setSupportMultipleWindows={false} />
          <View style={styles.modalFooter}><Button title="Закрити" onPress={() => setForm(null)} /></View>
        </SafeAreaView>
      </Modal>
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  header: { fontSize: 17, fontWeight: '700', color: colors.text },
  warningText: { fontSize: 15, color: colors.text },
  docRow: { gap: 6, paddingVertical: 6 },
  docLabel: { fontSize: 15, fontWeight: '600', color: colors.text },
  uploadStatus: { fontSize: 14, color: colors.muted },
  ok: { color: colors.success },
  err: { color: colors.danger },
  json: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, color: colors.text },
  modal: { flex: 1, backgroundColor: colors.surface },
  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.text, padding: 16 },
  modalFooter: { padding: 16 },
});
