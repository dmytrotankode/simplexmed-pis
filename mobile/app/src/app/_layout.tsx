import { Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, useFonts } from '@expo-google-fonts/manrope';
import { Stack, usePathname, useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LockOverlay, PrivacyCover } from '../components/LockOverlay';
import { useColors } from '../components/ui';
import { ALLOW_SCREENSHOTS } from '../lib/config';
import { shouldCoverContent } from '../lib/lock';
import { SessionProvider, useSession } from '../lib/session';
import { fonts } from '../theme';

// Дані пацієнта не потрапляють на знімки екрана і в мініатюру «Останні застосунки» (Android FLAG_SECURE)
function PreventScreenCapture() {
  usePreventScreenCapture();
  return null;
}

// Заставка тримається, доки не завантажиться шрифт Manrope (без «стрибка» накреслення)
void SplashScreen.preventAutoHideAsync().catch(() => {});

function Shell() {
  const colors = useColors();
  const { status, appState, touch } = useSession();
  const cover = shouldCoverContent(appState, status);
  const pathname = usePathname();
  const router = useRouter();
  // п.2.9: переміщення між екранами — дія користувача
  useEffect(() => {
    touch();
  }, [pathname, touch]);
  // Після входу без PIN-коду жоден екран (зокрема відкритий за посиланням simplexpis://) не доступний до встановлення PIN
  const pinRequired = status === 'needsPin' && pathname !== '/pin-setup';
  useEffect(() => {
    if (pinRequired) router.replace('/pin-setup');
  }, [pinRequired, router]);
  const overlay = status === 'locked' || cover || pinRequired;
  return (
    // Будь-який дотик (натискання, прокручування, жести) скидає таймер бездіяльності (п.2.9: 5 хвилин без дій — блокування);
    // введення з клавіатури враховує поле Field
    <View style={{ flex: 1, backgroundColor: colors.page }} onTouchStart={touch}>
      <View style={{ flex: 1 }} importantForAccessibility={overlay ? 'no-hide-descendants' : 'auto'}
            accessibilityElementsHidden={overlay}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.page },
          headerTintColor: colors.ink,
          headerShadowVisible: false,
          headerTitleStyle: { fontFamily: fonts.semibold, fontSize: 17 },
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.page },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="privacy" options={{ title: 'Політика конфіденційності' }} />
        <Stack.Screen name="sign-up" options={{ title: 'Реєстрація в ЕСОЗ' }} />
        <Stack.Screen name="kep-sign" options={{ title: 'Електронний підпис', presentation: 'modal' }} />
        <Stack.Screen name="pin-setup" options={{ title: 'PIN-код застосунку', headerBackVisible: false }} />
        <Stack.Screen name="person-edit" options={{ title: 'Зміна персональних даних' }} />
        <Stack.Screen name="person-requests" options={{ title: 'Запити на зміну даних' }} />
        <Stack.Screen name="person-request" options={{ title: 'Запит на зміну даних' }} />
        <Stack.Screen name="auth-methods" options={{ title: 'Методи входу' }} />
        <Stack.Screen name="apps" options={{ title: 'Доступи застосунків' }} />
        <Stack.Screen name="declaration-new" options={{ title: 'Подання декларації' }} />
        <Stack.Screen name="declaration-request" options={{ title: 'Запит на декларацію' }} />
      </Stack>
      </View>
      {status === 'locked' ? <LockOverlay /> : cover || pinRequired ? <PrivacyCover /> : null}
      {ALLOW_SCREENSHOTS ? null : <PreventScreenCapture />}
      <StatusBar style={colors.scheme === 'dark' ? 'light' : 'dark'} />
    </View>
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({ Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold });
  const ready = loaded || Boolean(error);   // без шрифту — системний, але застосунок працює
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Shell />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
