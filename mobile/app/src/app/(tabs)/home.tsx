import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../../components/Icon';
import { Button, Card, ErrorBox, formatDate, Group, ListRow, Muted, Section, StatusPill, Text, Tile, useColors } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { DOCUMENTS_UPLOAD_MESSAGE, type Rec } from '../../lib/personForm';
import { KEYS, getSecure } from '../../lib/secure';
import { useSession } from '../../lib/session';
import { useLoader } from '../../lib/useLoader';

type Declaration = Rec;

function doctorName(d: Declaration): string {
  const p = d.employee?.party ?? d.employee ?? {};
  return [p.last_name, p.first_name, p.second_name].filter(Boolean).join(' ');
}

/**
 * Головна: що потребує уваги (документи, п.3.5.8.2 / 3.9.3.5.f), «Мій лікар» (чинна декларація) і великі плитки
 * основних розділів. Повний запис про пацієнта — вкладка «Мої дані».
 */
export default function Home() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { status, token, handleApiError, signOut, lock } = useSession();
  const { data, error: loadError, loading, reload } = useLoader(async () => {
    const [p, v, decl, pending] = await Promise.all([
      api<{ data: Rec }>('/ehealth/person', { token }),
      api<{ display?: { documents_required?: boolean } }>('/ehealth/person/verification', { token }).catch(() => null),
      api<{ data?: Declaration[] }>('/ehealth/declarations', { token }).catch((e) => {
        if (e instanceof ApiError && (e.unauthorized || e.ehealthRequired)) throw e;
        return null;
      }),
      getSecure(KEYS.documentsPending).catch(() => null),
    ]);
    const active = (decl?.data ?? []).find((d) => String(d.status).toLowerCase() === 'active') ?? null;
    return {
      firstName: String(p.data?.first_name ?? ''),
      documentsRequired: Boolean(v?.display?.documents_required) || pending === '1',
      active,
      declarationsLoaded: Boolean(decl),
    };
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
  const active = data?.active;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.page }}
                contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 24, gap: 14 }}
                refreshControl={<RefreshControl refreshing={loading && Boolean(data)} onRefresh={reload} tintColor={colors.accent} />}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <Text style={{ flex: 1, fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.5 }} accessibilityRole="header">
          {data?.firstName ? `Добрий день, ${data.firstName}` : 'Добрий день'}
        </Text>
        <Pressable onPress={lock} accessibilityRole="button" accessibilityLabel="Заблокувати"
                   style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline, opacity: pressed ? 0.7 : 1 })}>
          <Icon name="lock" color={colors.ink} />
        </Pressable>
      </View>

      {ehealthRequired ? (
        <Card tone="warning">
          <Text style={{ fontSize: 17, lineHeight: 24 }}>Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.</Text>
          <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
        </Card>
      ) : null}
      <ErrorBox message={errorText} />

      {data?.documentsRequired ? (
        // п.3.5.8.2.1 і п.3.9.3.5.f: потрібні електронні копії документів (п.3.6)
        <Card tone="warning">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="alert" color={colors.attention} />
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.attention }}>Потрібна дія</Text>
          </View>
          <Text style={{ fontSize: 17, lineHeight: 24 }}>{DOCUMENTS_UPLOAD_MESSAGE}</Text>
          <Button title="Завантажити документи" icon="upload" onPress={() => router.push('/person-requests?documents=1')} />
        </Card>
      ) : null}

      {data?.declarationsLoaded ? (
        <Section title="Мій лікар">
          {active ? (
            <Group>
              <ListRow first icon="doctor" title={doctorName(active) || `Декларація № ${active.declaration_number ?? ''}`}
                       subtitle={[active.legal_entity?.name ?? active.division?.name, `Дійсна з ${formatDate(active.start_date)}`].filter(Boolean).join(' · ')}
                       onPress={() => router.push('/declarations')} />
              <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
                <StatusPill text="Чинна декларація" />
              </View>
            </Group>
          ) : (
            <Card>
              {/* п.3.11.3.2.1 */}
              <Muted>У вас немає чинної декларації з лікарем первинної допомоги.</Muted>
              <Button title="Обрати лікаря" icon="plus" onPress={() => router.push('/declaration-new')} />
            </Card>
          )}
        </Section>
      ) : null}

      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Tile title="Мої дані" icon="user" onPress={() => router.push('/profile')} />
          <Tile title="Декларації" icon="file" onPress={() => router.push('/declarations')} />
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Tile title="Методи входу" icon="key" onPress={() => router.push('/auth-methods')} />
          <Tile title="Доступи застосунків" icon="grid" onPress={() => router.push('/apps')} />
        </View>
      </View>
    </ScrollView>
  );
}
