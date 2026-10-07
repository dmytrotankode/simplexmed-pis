import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useColors } from '../components/ui';
import { useSession } from '../lib/session';

/** Маршрутизація за станом сесії; блокування показується оверлеєм поверх кабінету. */
export default function Index() {
  const colors = useColors();
  const { status } = useSession();
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Завантаження" />
      </View>
    );
  }
  if (status === 'signedOut') return <Redirect href="/login" />;
  if (status === 'needsPin') return <Redirect href="/pin-setup" />;
  return <Redirect href="/home" />;
}
