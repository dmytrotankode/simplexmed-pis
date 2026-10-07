import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '../lib/session';
import { BrandLockup, Button, ErrorBox, Field, Text } from './ui';
import { useStyles, type Palette } from '../theme';

/** Екран блокування поверх будь-якого екрана: PIN-код або біометрія (п.2.9 ТВ ПІС). */
export function LockOverlay() {
  const styles = useStyles(makeStyles);
  const { unlockWithPin, unlockWithBiometric, biometricEnabled, signOut } = useSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (biometricEnabled) void unlockWithBiometric();
  }, [biometricEnabled, unlockWithBiometric]);

  async function submit() {
    setBusy(true);
    try {
      const r = await unlockWithPin(pin);
      setPin('');
      if (!r.ok && !r.wiped) setError(`Невірний PIN-код. Залишилось спроб: ${r.attemptsLeft}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.overlay} accessibilityViewIsModal>
      <View style={styles.box}>
        <BrandLockup size="small" />
        <Text style={styles.title} accessibilityRole="header">Кабінет заблоковано</Text>
        <Text style={styles.text}>Введіть PIN-код застосунку{biometricEnabled ? ' або скористайтеся біометрією' : ''}.</Text>
        <Field label="PIN-код" value={pin} onChangeText={(v) => { setPin(v.replace(/\D/g, '')); setError(null); }}
               keyboardType="number-pad" secureTextEntry maxLength={6} autoFocus onSubmitEditing={submit} />
        <ErrorBox message={error} />
        <Button title="Розблокувати" onPress={submit} busy={busy} disabled={pin.length < 4} />
        {biometricEnabled && <Button title="Біометрія" icon="fingerprint" variant="secondary" onPress={() => void unlockWithBiometric()} />}
        <Button title="Вийти з кабінету" icon="logout" variant="quiet" onPress={() => void signOut()}
                accessibilityHint="Завершує сесію; для входу знадобиться ЕСОЗ" />
      </View>
    </SafeAreaView>
  );
}

/** Приховування вмісту, коли застосунок неактивний (перемикач застосунків). */
export function PrivacyCover() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.overlay} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={{ alignItems: 'center' }}><BrandLockup /></View>
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.bg, justifyContent: 'center', zIndex: 100 },
  box: { padding: 24, gap: 14 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, marginTop: 12 },
  text: { fontSize: 17, lineHeight: 24, color: colors.muted },
});
