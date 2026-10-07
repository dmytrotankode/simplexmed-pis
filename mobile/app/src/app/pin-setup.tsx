import * as LocalAuthentication from 'expo-local-authentication';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';

import { Button, Card, ErrorBox, Field, Muted, Screen, Text, Title, useColors } from '../components/ui';
import { isValidPin } from '../lib/pin';
import { useSession } from '../lib/session';

/** п.2.9 ТВ ПІС: після авторизації — обов'язкове встановлення PIN-коду (і за бажанням біометрії). */
export default function PinSetup() {
  const colors = useColors();
  const { status, setupPin } = useSession();
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [bioAvailable, setBioAvailable] = useState(false);
  const [useBio, setUseBio] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const ok = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
      setBioAvailable(ok);
      setUseBio(ok);
    })();
  }, []);

  if (status !== 'needsPin') return <Redirect href="/" />;

  async function save() {
    if (!isValidPin(pin)) return setError('PIN-код має містити від 4 до 6 цифр');
    if (pin !== repeat) return setError('PIN-коди не збігаються');
    setBusy(true);
    try {
      if (useBio) {
        const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Підтвердіть біометрію', disableDeviceFallback: true });
        if (!r.success) {
          setBusy(false);
          return setError('Біометрію не підтверджено. Вимкніть її або спробуйте ще раз.');
        }
      }
      await setupPin(pin, useBio);
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти PIN-код');
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Захист застосунку</Title>
      <Muted>Встановіть PIN-код. Його потрібно буде вводити після 5 хвилин без дій та після кожного запуску застосунку.</Muted>
      <Field label="PIN-код (4–6 цифр)" value={pin} onChangeText={(v) => { setPin(v.replace(/\D/g, '')); setError(null); }}
             keyboardType="number-pad" secureTextEntry maxLength={6} autoFocus />
      <Field label="Повторіть PIN-код" value={repeat} onChangeText={(v) => { setRepeat(v.replace(/\D/g, '')); setError(null); }}
             keyboardType="number-pad" secureTextEntry maxLength={6} />
      {bioAvailable && (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Switch value={useBio} onValueChange={setUseBio} accessibilityLabel="Розблоковувати біометрією" />
            <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>Розблоковувати відбитком пальця або обличчям</Text>
          </View>
        </Card>
      )}
      <ErrorBox message={error} />
      <Button title="Зберегти" onPress={() => void save()} busy={busy} />
    </Screen>
  );
}
