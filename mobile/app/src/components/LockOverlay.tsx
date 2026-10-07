import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { showLogoutWarning, useSession } from '../lib/session';
import { BrandLockup, Button, ErrorBox, Field, Text } from './ui';
import { useStyles, type Palette } from '../theme';

/**
 * Екран блокування поверх будь-якого екрана: PIN-код або біометрія (п.2.9 ТВ ПІС).
 * Вміст прокручується і піднімається над клавіатурою, щоб «Розблокувати» і «Вийти» були досяжні на малих екранах.
 */
export function LockOverlay() {
  const styles = useStyles(makeStyles);
  const { unlockWithPin, unlockWithBiometric, biometricEnabled, signOut } = useSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Синхронний замок: кнопка і «Готово» на клавіатурі (або подвійне натискання) не перевіряють PIN двічі —
  // кожна перевірка зараховує спробу
  const submitting = useRef(false);
  const leaving = useRef(false);

  useEffect(() => {
    if (biometricEnabled) void unlockWithBiometric().catch(() => false);
  }, [biometricEnabled, unlockWithBiometric]);

  async function submit() {
    if (busy || submitting.current || pin.length < 4) return;
    submitting.current = true;
    setBusy(true);
    try {
      const r = await unlockWithPin(pin);
      setPin('');
      if (!r.ok && !r.wiped) setError(`Невірний PIN-код. Залишилось спроб: ${r.attemptsLeft}`);
    } catch {
      setError('Не вдалося перевірити PIN-код. Спробуйте ще раз.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function leave() {
    if (leaving.current) return;
    leaving.current = true;
    void signOut().then(showLogoutWarning).catch(() => {}).finally(() => {
      leaving.current = false;
    });
  }

  return (
    <SafeAreaView style={styles.overlay} accessibilityViewIsModal>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <View style={styles.box}>
            <BrandLockup size="small" />
            <Text style={styles.title} accessibilityRole="header">Кабінет заблоковано</Text>
            <Text style={styles.text}>Введіть PIN-код застосунку{biometricEnabled ? ' або скористайтеся біометрією' : ''}.</Text>
            <Field label="PIN-код" value={pin} onChangeText={(v) => { setPin(v.replace(/\D/g, '')); setError(null); }}
                   keyboardType="number-pad" secureTextEntry maxLength={6} autoFocus returnKeyType="done"
                   onSubmitEditing={() => void submit()} />
            <ErrorBox message={error} />
            <Button title="Розблокувати" onPress={() => void submit()} busy={busy} disabled={pin.length < 4} />
            {biometricEnabled && (
              <Button title="Біометрія" icon="fingerprint" variant="secondary" disabled={busy}
                      onPress={() => void unlockWithBiometric().catch(() => false)} />
            )}
            <Button title="Вийти з кабінету" icon="logout" variant="quiet" disabled={busy} onPress={leave}
                    accessibilityHint="Завершує сесію; для входу знадобиться ЕСОЗ" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center' },
  box: { padding: 24, gap: 14 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, marginTop: 12 },
  text: { fontSize: 17, lineHeight: 24, color: colors.muted },
});
