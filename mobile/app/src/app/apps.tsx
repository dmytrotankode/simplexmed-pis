import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, View, StyleSheet } from 'react-native';

import { Button, Card, ErrorBox, formatDate, Muted, Row, Text, Title, useColors } from '../components/ui';
import { ApiError } from '../lib/api';
import {
  type Approval,
  MSG_NO_APPS,
  describeScopes,
  detailRows,
  errorMessage,
  fetchAppDetails,
  fetchApps,
  fetchOwnClientId,
  fetchScopeDescriptions,
  isCurrentClient,
  revokeApp,
  revokeConfirmText,
} from '../lib/authMethods';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';
import { useStyles, type Palette } from '../theme';

/**
 * Пацієнтські системи з доступом до даних (п.3.8): назва клієнта, скоупи описами з довідника SCOPES,
 * дата створення, усі атрибути (п.3.8.1.2), відкликання доступу з підтвердженням (п.3.8.2).
 * Відкликання доступу самої ПІС — попередження і вихід із кабінету (п.3.8.2.1).
 */
export default function Apps() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const { status, token, handleApiError, signOut } = useSession();
  const { data, error: loadError, loading, reload } = useLoader(async () => {
    const [apps, scopes, clientId] = await Promise.all([fetchApps(token), fetchScopeDescriptions(), fetchOwnClientId()]);
    return { apps, scopes, clientId };
  }, status === 'unlocked' && Boolean(token));

  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Approval>>({});
  const [detailsLoadingId, setDetailsLoadingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const ehealthRequired = loadError instanceof ApiError && loadError.ehealthRequired;
  useEffect(() => {
    if (loadError instanceof ApiError && loadError.unauthorized) handleApiError(loadError);
  }, [loadError, handleApiError]);

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  const loaded = data !== undefined;
  const apps = data?.apps ?? [];
  const scopes = data?.scopes ?? {};
  const clientId = data?.clientId ?? null;
  const error = actionError ?? (loadError && !ehealthRequired ? errorMessage(loadError) : null);

  async function toggleDetails(app: Approval) {
    if (expandedId === app.id) return setExpandedId(null);
    setExpandedId(app.id);
    if (details[app.id]) return;
    setDetailsLoadingId(app.id);
    try {
      const full = await fetchAppDetails(token, app.id);
      setDetails((d) => ({ ...d, [app.id]: full ?? app }));
      setActionError(null);
    } catch (e) {
      // Деталі недоступні — показуємо атрибути з переліку і текст помилки
      setActionError(handleApiError(e));
    } finally {
      setDetailsLoadingId(null);
    }
  }

  function revoke(app: Approval) {
    const current = isCurrentClient(app, clientId);
    Alert.alert('Відкликання доступу', revokeConfirmText(app, current), [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Відкликати', style: 'destructive', onPress: async () => {
          setRevokingId(app.id);
          try {
            await revokeApp(token, app.id);
            if (current) {
              // п.3.8.2.1: доступ цієї ПІС припинено — вихід (п.3.7) і повторна авторизація
              await signOut();
              router.replace('/');
              return;
            }
            setActionError(null);
            reload();   // п.3.8.2.2: актуальний перелік
          } catch (e) {
            setActionError(handleApiError(e));
          } finally {
            setRevokingId(null);
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}
                refreshControl={<RefreshControl refreshing={loading && loaded} onRefresh={reload} />}>
      {ehealthRequired ? (
        <Card tone="warning">
          <Text style={styles.text}>Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.</Text>
          <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
        </Card>
      ) : null}
      <Title>Пацієнтські системи з доступом до ваших даних</Title>
      <Muted>Застосунки, яким ви надали доступ до інформації про себе в ЕСОЗ.</Muted>
      <ErrorBox message={error} />

      {loading && !loaded ? <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Завантаження" /> : null}
      {loaded && apps.length === 0 ? <Muted>{MSG_NO_APPS}</Muted> : null}

      {apps.map((app) => {
        const name = app.client_name || '—';
        const expanded = expandedId === app.id;
        const scopeList = describeScopes(app.scope, scopes);
        const current = isCurrentClient(app, clientId);
        return (
          <Card key={app.id}>
            <Text style={styles.appName} accessibilityRole="header">{name}</Text>
            {current ? <Muted>Це застосунок, через який ви зараз працюєте.</Muted> : null}
            <View style={styles.scopes}>
              <Text style={styles.label}>Перелік доступів</Text>
              {scopeList.length === 0 ? <Text style={styles.text}>—</Text> : scopeList.map((s, i) => (
                <Text key={`${i}-${s}`} style={styles.text}>{`• ${s}`}</Text>
              ))}
            </View>
            <Row label="Дата створення" value={formatDate(app.created_at)} />
            <Button title={expanded ? 'Сховати деталі' : 'Деталі'} variant="secondary"
                    onPress={() => void toggleDetails(app)} busy={detailsLoadingId === app.id}
                    accessibilityHint={`Усі відомості про доступ застосунку «${name}»`} />
            {expanded && detailsLoadingId !== app.id ? (
              <View style={styles.details}>
                {detailRows(details[app.id] ?? app).map((r) => <Row key={r.key} label={r.label} value={r.value} />)}
              </View>
            ) : null}
            <Button title="Відкликати" variant="danger" onPress={() => revoke(app)} busy={revokingId === app.id}
                    accessibilityHint={`Відкликає доступ застосунку «${name}» до ваших даних`} />
          </Card>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  text: { fontSize: 15, color: colors.text, lineHeight: 21 },
  label: { fontSize: 13, color: colors.muted },
  appName: { fontSize: 17, fontWeight: '700', color: colors.text },
  scopes: { gap: 2, paddingVertical: 4 },
  details: { borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: 8 },
});
