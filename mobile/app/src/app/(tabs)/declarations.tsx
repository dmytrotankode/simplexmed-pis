import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { Button, Card, ErrorBox, Field, formatDate, Group, ListRow, Muted, Row, Section, StatusPill, Text, Title, useColors } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import {
  type DeclarationRequestRow, REJECT_CONFIRM, fetchDeclarationRequests, isFormNavigationAllowed, rejectDeclarationRequest,
  withViewport,
} from '../../lib/declarationFlow';
import { shareHtmlAsPdf } from '../../lib/exportFiles';
import { type DictValue, loadDictionary } from '../../lib/personForm';
import { useSession } from '../../lib/session';
import { useLoader } from '../../lib/useLoader';

type Declaration = Record<string, any>;
type FormView = { title: string; fileName: string; html: string };

const STATUSES: Record<string, string> = { active: 'Чинна', pending_verification: 'Очікує верифікації', terminated: 'Припинена', closed: 'Закрита' };
/** п.3.11.4.3: текст попередження, визначений ТВ. */
const TERMINATE_CONFIRM = 'Увага! Припинення дії Декларації є незворотною дією. Ви впевнені?';

function statusText(status: unknown): string {
  const key = String(status ?? '').toLowerCase();
  return STATUSES[key] ?? String(status ?? '');
}

function doctorName(d: Declaration): string {
  const p = d.employee?.party ?? {};
  return [p.last_name, p.first_name, p.second_name].filter(Boolean).join(' ');
}

function reasonText(reasons: DictValue[], code: unknown): string {
  if (!code) return '';
  return reasons.find((r) => r.code === code)?.description || String(code);
}

/**
 * Декларації (п.3.11.1.1, 3.11.2, 3.11.3, 3.11.4): чинна окремо від інших, запити на подання декларації,
 * форма з можливістю зберегти PDF, припинення з причиною і попередженням ТВ.
 */
export default function Declarations() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { status, token, handleApiError } = useSession();
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<FormView | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);
  const [terminating, setTerminating] = useState<Declaration | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, error: loadError, loading, reload } = useLoader(async () => {
    const [list, requests, reasons] = await Promise.all([
      api<{ data?: Declaration[] }>('/ehealth/declarations', { token }),
      // Перелік запитів не ламає перелік декларацій (крім недійсної сесії), але помилку показуємо (п.3.11.2.4)
      fetchDeclarationRequests(token ?? '').catch((e) => {
        if (e instanceof ApiError && (e.unauthorized || e.ehealthRequired)) throw e;
        return e instanceof Error ? e.message : 'Не вдалося отримати запити на декларацію';
      }),
      loadDictionary('DECLARATION_STATUS_REASON', token).catch(() => [] as DictValue[]),
    ]);
    return { items: list.data ?? [], requests: typeof requests === 'string' ? [] : requests,
             requestsError: typeof requests === 'string' ? requests : null, reasons };
  }, status === 'unlocked' && Boolean(token));

  // Повернення з подання/підпису запиту — актуальні переліки
  const focusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedOnce.current) reload();
    focusedOnce.current = true;
  }, [reload]));

  useEffect(() => {
    if (loadError instanceof ApiError && loadError.unauthorized) handleApiError(loadError);
  }, [loadError, handleApiError]);
  const loadMessage = useMemo(() => (loadError instanceof ApiError ? loadError.message
    : loadError instanceof Error ? loadError.message : null), [loadError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  const items = data?.items ?? [];
  const requests = data?.requests ?? [];
  const reasons = data?.reasons ?? [];
  const active = items.filter((d) => String(d.status).toLowerCase() === 'active');
  const others = items.filter((d) => String(d.status).toLowerCase() !== 'active');

  async function openForm(d: Declaration) {
    setActionError(null);
    try {
      const r = await api<{ data: { content?: string } }>(`/ehealth/declarations/${encodeURIComponent(d.id)}`, { token });
      const number = String(d.declaration_number || d.id);
      setForm({ title: `Декларація № ${number}`, fileName: `deklaratsiia_${number}`, html: r.data?.content ?? '<p>Форма недоступна</p>' });
    } catch (e) {
      setActionError(handleApiError(e));
    }
  }

  async function savePdf() {
    if (!form) return;
    setSavingPdf(true);
    try {
      await shareHtmlAsPdf(form.fileName, form.html, 'Зберегти декларацію у PDF');
    } catch (e) {
      Alert.alert('PDF', e instanceof Error ? e.message : 'Не вдалося зберегти PDF');
    } finally {
      setSavingPdf(false);
    }
  }

  function startTerminate(d: Declaration) {
    setReason('');
    setTerminating(d);
  }

  function confirmTerminate() {
    const d = terminating;
    if (!d) return;
    // п.3.11.4.3: попередження про незворотність з можливістю скасувати
    Alert.alert('Припинення декларації', TERMINATE_CONFIRM, [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Припинити', style: 'destructive', onPress: async () => {
          setBusy(true);
          try {
            // п.3.11.4.2: причина припинення (reason_description), якщо Користувач її вказав
            await api(`/ehealth/declarations/${encodeURIComponent(d.id)}/terminate`,
              { method: 'PATCH', token, body: { reason_description: reason.trim() } });
            setTerminating(null);
            setActionError(null);
            Alert.alert('Декларації', 'Дію декларації припинено.');
            reload();
          } catch (e) {
            setTerminating(null);
            setActionError(handleApiError(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  function rejectRequest(row: DeclarationRequestRow) {
    Alert.alert('Відхилення запиту', REJECT_CONFIRM, [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Відхилити', style: 'destructive', onPress: async () => {
          try {
            await rejectDeclarationRequest(token ?? '', row.id);
            setActionError(null);
            reload();
          } catch (e) {
            setActionError(handleApiError(e));
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.page }}
                contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 24, gap: 14 }}
                refreshControl={<RefreshControl refreshing={loading && Boolean(data)} onRefresh={reload} tintColor={colors.accent} />}>
      <Title>Декларації</Title>
      <ErrorBox message={actionError ?? loadMessage} />
      {/* п.3.11.1.1: подати декларацію можна незалежно від наявності чинної */}
      <Button title="Подати декларацію" icon="plus" onPress={() => router.push('/declaration-new')} />

      <Section title="Чинна декларація">
        {data && active.length === 0 ? (
          <Card>
            {/* п.3.11.3.2.1 */}
            <Muted>У вас немає чинної декларації з лікарем первинної допомоги.</Muted>
          </Card>
        ) : active.map((d) => (
          <Group key={d.id}>
            <View style={{ padding: 16, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ fontSize: 17, fontWeight: '600' }}>№ {d.declaration_number}</Text>
                <StatusPill text={statusText(d.status)} />
              </View>
              {doctorName(d) ? <Text style={{ fontSize: 17 }}>{doctorName(d)}</Text> : null}
              <Muted>Дійсна з {formatDate(d.start_date)}</Muted>
            </View>
            <ListRow icon="file" tone="action" title="Форма декларації" onPress={() => void openForm(d)} />
            <ListRow icon="stop" title="Припинити" chevron={false} onPress={() => startTerminate(d)}
                     accessibilityHint="Незворотна дія; спершу буде попередження" />
          </Group>
        ))}
      </Section>

      <Section title="Запити на подання декларації">
        {data?.requestsError ? <ErrorBox message={data.requestsError} /> : null}
        {data && !data.requestsError && requests.length === 0 ? <Card><Muted>Запитів немає.</Muted></Card> : null}
        {requests.map((row) => (
          <Group key={row.id}>
            <View style={{ padding: 16, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ fontSize: 17, fontWeight: '600' }}>№ {row.number}</Text>
                {/* NEW очікує підпису Користувача — «увага»; решта статусів нейтральні */}
                <StatusPill text={row.statusLabel} tone={row.openLabel === 'Продовжити' ? 'attention' : 'neutral'}
                            icon={row.openLabel === 'Продовжити' ? 'pencil' : undefined} />
              </View>
              {row.date ? <Muted>{formatDate(row.date)}</Muted> : null}
            </View>
            <ListRow icon={row.openLabel === 'Продовжити' ? 'pencil' : 'file'} tone="action" title={row.openLabel}
                     onPress={() => router.push({ pathname: '/declaration-request', params: { id: row.id } })} />
            {row.canReject ? <ListRow icon="stop" title="Відхилити" chevron={false} onPress={() => rejectRequest(row)} /> : null}
          </Group>
        ))}
      </Section>

      {others.length > 0 ? (
        <Section title="Інші декларації">
          {others.map((d) => (
            <Group key={d.id}>
              <View style={{ padding: 16, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ fontSize: 17, fontWeight: '600' }}>№ {d.declaration_number}</Text>
                  <StatusPill text={statusText(d.status)} tone="ended" />
                </View>
                <Row label="Дійсна з" value={formatDate(d.start_date)} />
                <Row label="Дійсна до" value={formatDate(d.updated_at)} />
                <Row label="Причина" value={reasonText(reasons, d.reason)} />
                <Row label="Опис причини" value={d.reason_description} />
              </View>
              <ListRow icon="file" tone="action" title="Форма декларації" onPress={() => void openForm(d)} />
            </Group>
          ))}
        </Section>
      ) : null}

      <Modal visible={form !== null} animationType="slide" onRequestClose={() => setForm(null)}>
        <View style={{ flex: 1, paddingTop: insets.top + 12, backgroundColor: colors.page }}>
          <Text style={{ fontSize: 18, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 8, color: colors.text }}
                accessibilityRole="header">{form?.title}</Text>
          {/* HTML форми від ЕСОЗ — без JavaScript; переходи за посиланнями блокуються, у тому числі назовні */}
          <WebView source={{ html: withViewport(form?.html ?? '') }} javaScriptEnabled={false} originWhitelist={['*']}
                   onShouldStartLoadWithRequest={(r) => isFormNavigationAllowed(r.url)} setSupportMultipleWindows={false}
                   accessibilityLabel="Форма декларації" />
          <View style={{ padding: 16, gap: 8 }}>
            <Button title="Завантажити PDF" icon="download" variant="secondary" busy={savingPdf} onPress={() => void savePdf()} />
            <Button title="Закрити" onPress={() => setForm(null)} />
          </View>
        </View>
      </Modal>

      <Modal visible={terminating !== null} transparent animationType="fade" onRequestClose={() => setTerminating(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                              style={{ flex: 1, justifyContent: 'center', padding: 16, backgroundColor: colors.overlay }}>
          <Card>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }} accessibilityRole="header">Припинення декларації</Text>
            <Muted>Декларація № {terminating?.declaration_number ?? ''}</Muted>
            <Field label="Причина припинення (необов’язково)" value={reason} onChangeText={setReason} multiline maxLength={500} />
            <Button title="Продовжити" variant="danger" busy={busy} onPress={confirmTerminate} />
            <Button title="Скасувати" variant="secondary" disabled={busy} onPress={() => setTerminating(null)} />
          </Card>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}
