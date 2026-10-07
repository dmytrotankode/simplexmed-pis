import { Tabs } from 'expo-router';
import { type ColorValue, View } from 'react-native';

import { Icon, type IconName } from '../../components/Icon';
import { useColors } from '../../components/ui';
import { fonts } from '../../theme';

type TabIconProps = { color: ColorValue; focused: boolean };

function TabIcon({ name, color, focused }: { name: IconName; color: string; focused: boolean }) {
  const colors = useColors();
  return (
    <View style={{ width: 56, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                   backgroundColor: focused ? colors.accentTint : 'transparent' }}>
      <Icon name={name} color={color} />
    </View>
  );
}

/** Нижні вкладки дизайну «Плексі»: Головна, Декларації, Мої дані, Ще (підписи завжди видимі — для будь-якого віку). */
export default function TabsLayout() {
  const colors = useColors();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.secondary,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.hairline, minHeight: 68, paddingTop: 6 },
        tabBarLabelStyle: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18 },
        sceneStyle: { backgroundColor: colors.page },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Головна', tabBarIcon: ({ color, focused }: TabIconProps) => <TabIcon name="home" color={String(color)} focused={focused} /> }} />
      <Tabs.Screen name="declarations" options={{ title: 'Декларації', tabBarIcon: ({ color, focused }: TabIconProps) => <TabIcon name="file" color={String(color)} focused={focused} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Мої дані', tabBarIcon: ({ color, focused }: TabIconProps) => <TabIcon name="user" color={String(color)} focused={focused} /> }} />
      <Tabs.Screen name="more" options={{ title: 'Ще', tabBarIcon: ({ color, focused }: TabIconProps) => <TabIcon name="more" color={String(color)} focused={focused} /> }} />
    </Tabs>
  );
}
