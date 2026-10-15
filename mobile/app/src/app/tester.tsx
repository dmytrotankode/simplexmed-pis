import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, ErrorBox, Muted, Text, Title, useColors } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';

type Scenario = { id: string; title: string; covers: string[]; steps: string[]; expect: string; platforms: string[] };
type Mark = { scenario_id: string; platform: string; status: 'ok' | 'fail' | 'skip'; note: string };

const PLATFORM = 'android';
const LABEL = { ok: 'Виконано', fail: 'Помилка', skip: 'Пропущено' } as const;

/** Розділ «Тестування» (для тестувальників): інструкції за пунктами ТВ ПІС і відмітки виконання. Сервер повертає 404 не-тестувальникам. */
export default function Tester() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { token, status, handleApiError } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [error, setError] = useState<string | null>(null);

  const { data, error: loadError, loading, reload } = useLoader(async () => {
    const [content, saved] = await Promise.all([
      api<{ scenarios: Scenario[] }>('/tester/content', { token }),
      api<{ data: Mark[] }>('/tester/marks', { token }),
    ]);
    const map: Record<string, Mark> = {};
    saved.data.filter((m) => m.platform === PLATFORM).forEach((m) => { map[m.scenario_id] = m; });
    setMarks(map);
    return content.scenarios.filter((s) => s.platforms.includes(PLATFORM));
  }, status === 'unlocked' && Boolean(token));

  async function setMark(id: string, st: Mark['status']) {
    setError(null);
    try {
      await api('/tester/marks', { method: 'PUT', token, body: { scenario_id: id, platform: PLATFORM, status: st } });
      setMarks((m) => ({ ...m, [id]: { scenario_id: id, platform: PLATFORM, status: st, note: m[id]?.note ?? '' } }));
    } catch (e) {
      setError(handleApiError(e));
    }
  }

  const done = Object.values(marks).filter((m) => m.status === 'ok').length;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.page }}
                contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
      <Title>Тестування</Title>
      <Muted>Виконуйте кроки в застосунку і ставте відмітку. Пункти ТВ ПІС № 978 вказані під назвою сценарію.</Muted>
      {data ? <Text>Виконано сценаріїв: {done} з {data.length}</Text> : null}
      <ErrorBox message={error ?? (loadError ? 'Розділ недоступний для цього облікового запису.' : null)} />
      {loading && !data ? <Muted>Завантаження…</Muted> : null}
      {(data ?? []).map((s) => {
        const mark = marks[s.id];
        const isOpen = open === s.id;
        return (
          <Card key={s.id}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }}
                       onPress={() => setOpen(isOpen ? null : s.id)} style={{ minHeight: 44, gap: 2 }}>
              <Text style={{ fontWeight: '600' }}>{s.title}</Text>
              <Muted>ТВ: {s.covers.join(', ')}{mark ? ` · ${LABEL[mark.status]}` : ' · не перевірено'}</Muted>
            </Pressable>
            {isOpen ? (
              <View style={{ gap: 8, paddingTop: 8 }}>
                {s.steps.map((t, i) => <Text key={i}>{i + 1}. {t}</Text>)}
                <Text style={{ fontWeight: '600' }}>Очікуваний результат</Text>
                <Text>{s.expect}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Button title={LABEL.ok} onPress={() => void setMark(s.id, 'ok')} />
                  <Button title={LABEL.fail} variant="secondary" onPress={() => void setMark(s.id, 'fail')} />
                  <Button title={LABEL.skip} variant="secondary" onPress={() => void setMark(s.id, 'skip')} />
                </View>
              </View>
            ) : null}
          </Card>
        );
      })}
      {loadError ? <Button title="Спробувати ще раз" variant="secondary" onPress={reload} /> : null}
    </ScrollView>
  );
}
