import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, View, StyleSheet } from 'react-native';

import { PersonForm, SwitchRow } from '../components/PersonForm';
import { Button, Card, ErrorBox, Muted, Text, Title, useColors } from '../components/ui';
import { api } from '../lib/api';
import { LoginCancelled, loginWithEhealth } from '../lib/auth';
import { requestSignature } from '../lib/kepBridge';
import {
  DOCUMENTS_UPLOAD_MESSAGE, type PersonFormValues, buildPerson, emptyExtras, emptyPersonForm, errorSummary, mapFieldErrors,
  needsCapacityDoc, serverFieldErrors, signUpNeedsDocuments, validateDates,
} from '../lib/personForm';
import { KEYS, setSecure } from '../lib/secure';
import { useSession } from '../lib/session';
import { useStyles, type Palette } from '../theme';

/**
 * Реєстрація пацієнта в ЕСОЗ (п.3.5 ТВ ПІС), як submitSignUp у веб-кабінеті:
 * перевірка даних і контент для підпису від сервера -> підпис КЕП -> сервіс реєстрації ЕСОЗ -> сесія кабінету.
 */
export default function SignUp() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const { status, signIn, handleApiError } = useSession();
  const [values, setValues] = useState<PersonFormValues>(emptyPersonForm);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Завантаження" />
      </View>
    );
  }
  if (status === 'unlocked') return <Redirect href="/home" />;
  if (status !== 'signedOut') return <Redirect href="/" />;

  function showErrors(list: { field: string; message: string }[]) {
    const mapped = mapFieldErrors(list, { capacityShown: needsCapacityDoc(values), hasPhone: Boolean(values.phone.trim()) });
    setErrors(mapped.byField);
    setMessages(mapped.messages);
  }

  async function submit() {
    // п.3.5.3: продовжити лише після явної згоди з політикою конфіденційності
    if (!agreed) {
      setErrors({});
      setMessages(['Підтвердьте згоду з Політикою конфіденційності']);
      return;
    }
    const dateErrors = validateDates(values, needsCapacityDoc(values));
    if (dateErrors.length) {
      showErrors(dateErrors);
      return;
    }
    const person = buildPerson(values, emptyExtras(), { withAuthMethod: true });
    setBusy(true);
    try {
      // Перевірка даних (п.3.5.4) і отримання контенту з nonce для підпису (п.3.5.2)
      let content: string | undefined;
      try {
        content = (await api<{ content?: string }>('/auth/sign-up/prepare', { method: 'POST', body: { person } })).content;
      } catch (e) {
        const fields = serverFieldErrors(e);
        if (fields) {
          showErrors(fields);
          return;
        }
        throw e;
      }
      if (!content) throw new Error('Не вдалося отримати дані для підпису. Спробуйте ще раз.');
      setErrors({});
      setMessages([]);
      const signing = requestSignature(content, 'Підпис даних для реєстрації',
        'Підпишіть дані реєстрації своїм КЕП. Дані з підпису (ПІБ, РНОКПП) мають збігатися з даними форми.');
      router.push('/kep-sign');
      const signed = await signing;
      const { token } = await loginWithEhealth({ userData: signed, mode: 'sign-up' });
      // п.3.5.8.2: копії документів — банер на головному екрані, доки їх не завантажено
      const needsDocuments = signUpNeedsDocuments(person, needsCapacityDoc(values));
      if (needsDocuments) await setSecure(KEYS.documentsPending, '1');
      await signIn(token);
      // п.3.5.8.1: повідомлення про успішне завершення реєстрації та авторизації
      Alert.alert('Реєстрацію завершено', 'Реєстрацію та авторизацію в ЕСОЗ успішно завершено.' +
        (needsDocuments ? `\n\n${DOCUMENTS_UPLOAD_MESSAGE}` : ''));
      router.replace('/');
    } catch (e) {
      if (!(e instanceof LoginCancelled)) {
        setErrors({});
        setMessages([handleApiError(e)]);
      }
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (router.canGoBack()) router.back();
    else router.replace('/login');
  }

  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
                automaticallyAdjustKeyboardInsets>
      <Title>Реєстрація пацієнта в ЕСОЗ</Title>
      <Muted>Дані підписуються вашим КЕП і передаються до сервісу реєстрації ЕСОЗ. Поля, позначені *, обов’язкові.</Muted>
      <PersonForm mode="sign-up" values={values} onChange={setValues} errors={errors} disabled={busy} />
      <Card>
        <SwitchRow label="Я ознайомився(-лась) і погоджуюсь з Політикою конфіденційності" value={agreed}
                   onValueChange={setAgreed} disabled={busy} />
        <Pressable accessibilityRole="link" onPress={() => router.push('/privacy')} style={styles.link} hitSlop={8}>
          <Text style={styles.linkText}>Переглянути Політику конфіденційності</Text>
        </Pressable>
      </Card>
      <ErrorBox message={errorSummary(messages)} />
      <Button title="Підписати КЕП і зареєструватися" variant="success" busy={busy} onPress={() => void submit()}
              accessibilityHint="Відкриє екран електронного підпису, потім сторінку реєстрації ЕСОЗ" />
      <Button title="Скасувати" variant="secondary" disabled={busy} onPress={cancel} />
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  bg: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: colors.primary, textDecorationLine: 'underline', fontSize: 15 },
});
