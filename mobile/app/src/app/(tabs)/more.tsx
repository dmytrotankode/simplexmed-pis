import Constants from 'expo-constants';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLockup, Group, ListRow, Muted, Title, useColors } from '../../components/ui';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

/** «Ще»: рідше потрібні розділи, блокування і вихід (п.3.7). */
export default function More() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { status, token, lock, signOut } = useSession();
  // Пункт «Тестування» показуємо лише тестувальникам (сервер відповідає 404 усім іншим)
  const [isTester, setIsTester] = useState(false);
  useEffect(() => {
    if (status !== 'unlocked' || !token) return;
    let off = false;
    api('/tester/marks', { token }).then(() => { if (!off) setIsTester(true); }, () => {});
    return () => { off = true; };
  }, [status, token]);
  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  function confirmSignOut() {
    Alert.alert('Вийти з кабінету?', 'Доступ до ЕСОЗ у цьому застосунку буде припинено. Для входу знадобиться ЕСОЗ.', [
      { text: 'Скасувати', style: 'cancel' },
      { text: 'Вийти', style: 'destructive', onPress: () => void signOut().then(() => router.replace('/')) },
    ]);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.page }}
                contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 24, gap: 14 }}>
      <Title>Ще</Title>
      <Group>
        <ListRow first icon="key" title="Методи входу" onPress={() => router.push('/auth-methods')} />
        <ListRow icon="grid" title="Доступи застосунків" onPress={() => router.push('/apps')} />
        <ListRow icon="list" title="Запити на зміну персональних даних" onPress={() => router.push('/person-requests')} />
        <ListRow icon="shield" title="Політика конфіденційності" onPress={() => router.push('/privacy')} />
        {isTester ? <ListRow icon="check" title="Тестування" onPress={() => router.push('/tester')} /> : null}
      </Group>
      <Group>
        <ListRow first icon="lock" title="Заблокувати" onPress={lock} chevron={false} />
        <ListRow icon="logout" title="Вийти з кабінету" onPress={confirmSignOut} chevron={false} />
      </Group>
      <View style={{ alignItems: 'flex-start', gap: 6, paddingTop: 12, paddingHorizontal: 4 }}>
        <BrandLockup size="small" />
        <Muted>Версія {Constants.expoConfig?.version ?? ''}</Muted>
      </View>
    </ScrollView>
  );
}
