import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { BrandLockup, Button, ErrorBox, Group, ListRow, Muted, Text, Title, useColors } from '../components/ui';
import { ApiError } from '../lib/api';
import { LoginCancelled, getNonce, loginWithEhealth } from '../lib/auth';
import { requestSignature } from '../lib/kepBridge';
import { useSession } from '../lib/session';

/** Вхід через сервіс авторизації ЕСОЗ (п.3.3 ТВ ПІС): з КЕП у застосунку або іншими способами на сайті ЕСОЗ. */
export default function Login() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { status, signIn, handleApiError } = useSession();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<'kep' | 'site' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status !== 'signedOut') return <Redirect href="/" />;

  async function run(kind: 'kep' | 'site') {
    // п.3.3.1.2: продовжити лише після явної згоди з політикою конфіденційності
    if (!agreed) {
      setError('Щоб продовжити, ознайомтеся з Політикою конфіденційності та підтвердьте згоду.');
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      let userData: string | undefined;
      if (kind === 'kep') {
        const nonce = await getNonce();
        const signing = requestSignature(nonce, 'Вхід через ЕСОЗ з КЕП',
          'Підпишіть запит на вхід своїм КЕП. Після цього відкриється сторінка ЕСОЗ для надання доступу.');
        router.push('/kep-sign');
        userData = await signing;
      }
      await signIn((await loginWithEhealth({ userData })).token);
      router.replace('/');
    } catch (e) {
      if (!(e instanceof LoginCancelled)) setError(handleApiError(e));
      // Додаток 1: пацієнта не знайдено в ЕСОЗ — запропонувати реєстрацію
      if (e instanceof ApiError && e.nextStep === 'sign-up') {
        Alert.alert('Реєстрація в ЕСОЗ', e.message, [
          { text: 'Не зараз', style: 'cancel' },
          { text: 'Зареєструватися', onPress: () => router.push('/sign-up') },
        ]);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.page }} keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24, paddingHorizontal: 20, gap: 28 }}>
      <View style={{ flex: 1, justifyContent: 'center', gap: 24 }}>
        <BrandLockup />
        <View style={{ gap: 8 }}>
          <Title>Кабінет пацієнта</Title>
          <Muted>Вхід через електронну систему охорони здоров’я (ЕСОЗ)</Muted>
        </View>
      </View>
      <View style={{ gap: 12 }}>
        <Group>
          {/* п.3.3.1.2: продовжити лише після явної згоди (окрема дія) */}
          <Pressable onPress={() => setAgreed((v) => !v)} accessibilityRole="switch" accessibilityState={{ checked: agreed }}
                     accessibilityLabel="Я ознайомився(-лась) і погоджуюсь з Політикою конфіденційності"
                     style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 16, paddingVertical: 12 }}>
            <View style={{ width: 24, height: 24, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center',
                           borderColor: agreed ? colors.accent : colors.outline, backgroundColor: agreed ? colors.accent : 'transparent' }}>
              {agreed ? <Icon name="tick" color={colors.onAccent} size={18} strokeWidth={3} /> : null}
            </View>
            <Text style={{ flex: 1, fontSize: 17, lineHeight: 24 }}>Я ознайомився(-лась) і погоджуюсь з Політикою конфіденційності</Text>
          </Pressable>
          {/* п.3.3.1–3.3.1.1: ознайомлення до авторизації і збереження у текстовий файл */}
          <ListRow icon="file" tone="action" title="Переглянути або зберегти Політику конфіденційності" onPress={() => router.push('/privacy')} />
        </Group>
        <ErrorBox message={error} />
        <Button title="Увійти з КЕП" icon="key" busy={busy === 'kep'} disabled={busy !== null} onPress={() => void run('kep')}
                accessibilityHint="Кваліфікований електронний підпис, далі сторінка ЕСОЗ" />
        <Button title="Інші способи входу на сайті ЕСОЗ" variant="secondary" busy={busy === 'site'} disabled={busy !== null}
                onPress={() => void run('site')} />
        <View style={{ alignItems: 'center', gap: 2, paddingTop: 4 }}>
          <Muted>Ще не зареєстровані в ЕСОЗ?</Muted>
          <Pressable accessibilityRole="link" disabled={busy !== null} onPress={() => router.push('/sign-up')}
                     style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}>
            <Text style={{ color: colors.accent, fontSize: 17, fontWeight: '600' }}>Зареєструватися</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
