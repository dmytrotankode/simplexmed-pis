import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PersonRecord, VerificationCard } from '../../components/PersonRecord';
import { Button, Card, ErrorBox, formatDate, Group, ListRow, Section, Text, Title, useColors } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { type AuthMethod, activeMethods, authMethodsNotice, methodTypeLabel } from '../../lib/authMethods';
import type { Rec } from '../../lib/personForm';
import { type RecordDicts, type VerificationItem, loadRecordDictionaries } from '../../lib/personRecord';
import { useSession } from '../../lib/session';
import { useLoader } from '../../lib/useLoader';

type VerificationResponse = { data?: unknown; display?: { items?: VerificationItem[]; documents_required?: boolean } };

/** Мої дані: запис про пацієнта (п.3.9.2), статуси верифікації (п.3.9.3), методи автентифікації (п.3.9.4). */
export default function Profile() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { status, token, handleApiError, signOut } = useSession();
  const { data, error: loadError, loading, reload } = useLoader(async () => {
    const [p, v, m, dicts] = await Promise.all([
      api<{ data: Rec }>('/ehealth/person', { token }),
      api<VerificationResponse>('/ehealth/person/verification', { token }),
      api<{ data?: AuthMethod[] }>('/ehealth/person/authentication-methods', { token }),
      loadRecordDictionaries(token).catch(() => ({} as RecordDicts)),
    ]);
    return { person: p.data ?? {}, verification: v.display?.items ?? [], methods: activeMethods(m.data), dicts };
  }, status === 'unlocked' && Boolean(token));

  const focusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedOnce.current) reload();
    focusedOnce.current = true;
  }, [reload]));

  const ehealthRequired = loadError instanceof ApiError && loadError.ehealthRequired;
  useEffect(() => {
    if (loadError instanceof ApiError && loadError.unauthorized) handleApiError(loadError);
  }, [loadError, handleApiError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  const errorText = loadError && !ehealthRequired ? (loadError instanceof Error ? loadError.message : 'Сталася помилка') : null;
  const methods = data?.methods ?? [];
  const notice = data ? authMethodsNotice(methods) : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.page }}
                contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 24, gap: 14 }}
                refreshControl={<RefreshControl refreshing={loading && Boolean(data)} onRefresh={reload} tintColor={colors.accent} />}>
      <Title>Мої дані</Title>
      {ehealthRequired ? (
        <Card tone="warning">
          <Text style={{ fontSize: 17, lineHeight: 24 }}>Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.</Text>
          <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
        </Card>
      ) : null}
      <ErrorBox message={errorText} />

      {data ? <PersonRecord person={data.person} dicts={data.dicts} /> : null}
      {data ? (
        <Group>
          <ListRow first icon="pencil" tone="action" title="Змінити персональні дані" onPress={() => router.push('/person-edit')} />
          <ListRow icon="list" title="Запити на зміну персональних даних" onPress={() => router.push('/person-requests')} />
        </Group>
      ) : null}

      {data ? <VerificationCard items={data.verification} dicts={data.dicts} /> : null}

      {data ? (
        <Section title="Методи автентифікації">
          {notice ? <Card tone="warning"><Text style={{ fontSize: 17, lineHeight: 24, color: colors.attention }}>{notice}</Text></Card> : null}
          <Group>
            {methods.map((m, i) => (
              <ListRow key={m.id ?? i} first={i === 0} icon="key" title={methodTypeLabel(m.type)}
                       subtitle={[m.phone_number, m.alias, m.started_at ? `з ${formatDate(m.started_at)}` : null].filter(Boolean).join(' · ')} />
            ))}
            <ListRow first={methods.length === 0} tone="action" icon="plus" title="Керувати методами входу"
                     onPress={() => router.push(methods.length ? '/auth-methods' : '/auth-methods?add=1')} />
          </Group>
        </Section>
      ) : null}
    </ScrollView>
  );
}
