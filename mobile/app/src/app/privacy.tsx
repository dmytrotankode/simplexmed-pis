import { useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Button, Card, ErrorBox, Screen, Text, useColors } from '../components/ui';
import { API_BASE } from '../lib/config';
import { shareTextFile } from '../lib/exportFiles';
import { useLoader } from '../lib/useLoader';

async function loadPolicy(): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}/api/privacy-policy`);
  } catch {
    throw new Error('Немає з’єднання з сервером. Перевірте інтернет і спробуйте ще раз.');
  }
  if (!resp.ok) throw new Error('Не вдалося завантажити Політику конфіденційності');
  return resp.text();
}

/** Політика конфіденційності ПІС: перегляд до авторизації і збереження як текстовий файл (п.3.3.1–3.3.1.1, 3.5.1.1). */
export default function Privacy() {
  const colors = useColors();
  const { data: text, error, loading, reload } = useLoader(loadPolicy, true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!text) return;
    setSaving(true);
    setSaveError(null);
    try {
      await shareTextFile('privacy_policy_simplexmed', text, 'Зберегти Політику конфіденційності');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Не вдалося зберегти файл');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <ErrorBox message={error ? (error instanceof Error ? error.message : String(error)) : saveError} />
      {error ? <Button title="Спробувати ще раз" variant="secondary" onPress={reload} /> : null}
      {loading && !text ? <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Завантаження" /> : null}
      {text ? (
        <>
          <Button title="Зберегти як текстовий файл (.txt)" variant="secondary" busy={saving} onPress={() => void save()}
                  accessibilityHint="Відкриває меню збереження файлу privacy_policy_simplexmed.txt" />
          <Card>
            <Text selectable style={{ fontSize: 15, lineHeight: 22, color: colors.text }}>{text}</Text>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
