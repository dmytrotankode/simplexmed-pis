import { Redirect, Stack, router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, ErrorBox, Field, Muted, Row, Text, Title, useColors } from '../components/ui';
import { ApiError } from '../lib/api';
import {
  CONTRACT_OPTIONS, type DoctorDetails, type DoctorFilters, type DoctorRow, type Division, EMPTY_FILTERS, EMPTY_SCOPE,
  GENDER_OPTIONS, MSG_NOT_FOUND, MSG_SEARCH_HINT, OVERLIMIT_OPTIONS, type Option, type SearchScope,
  chooseDoctorConfirmations, createDeclarationRequest, declarationsText, dictLabel, doctorKey, educationLines,
  fetchDivisions, fetchDoctor, fullName, genderAgeText, loadDoctorDictionaries, nextOffset, placesLeft,
  qualificationLines, scopeForDivision, scopeForDivisionRow, scopeForLegalEntity, searchDoctors, specialityLines,
  specialityOptions,
} from '../lib/declarationFlow';
import { useSession } from '../lib/session';
import { useLoader } from '../lib/useLoader';
import { useStyles, type Palette } from '../theme';

type Results = { rows: DoctorRow[]; hasNext: boolean; offset: number };
const SCREEN_OPTIONS = { title: 'Подання декларації' };

function confirmAsync(title: string, message: string, okText: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Скасувати', style: 'cancel', onPress: () => resolve(false) },
      { text: okText, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** Вибір одного значення (аналог select у веб-кабінеті): кнопки-перемикачі. */
function Choice({ label, value, options, onChange }: {
  label: string; value: string; options: Option[]; onChange: (value: string) => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.choice}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value || 'any'}
              onPress={() => onChange(o.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={o.label}
              style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Посилання-кнопка у картці лікаря (заклад / МНП). */
function LinkButton({ title, hint, onPress }: { title: string; hint: string; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint}
               style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
      <Text style={styles.linkText}>{title}</Text>
    </Pressable>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.listBlock}>
      <Text style={styles.subheader} accessibilityRole="header">{title}</Text>
      {items.length === 0 ? <Text style={styles.listItem}>—</Text>
        : items.map((item, i) => <Text key={i} style={styles.listItem}>{`• ${item}`}</Text>)}
    </View>
  );
}

/** Подання декларації: пошук лікаря в кеші реєстрів ЕСОЗ (п.3.11.1.2–3.11.1.8). */
export default function DeclarationNew() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const { status, token, handleApiError, signOut } = useSession();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const seq = useRef(0);
  const divisionsFor = useRef<string | null>(null);
  const [filters, setFilters] = useState<DoctorFilters>(EMPTY_FILTERS);
  const [moreFilters, setMoreFilters] = useState(false);
  const [scope, setScope] = useState<SearchScope>(EMPTY_SCOPE);
  const [divisions, setDivisions] = useState<Division[] | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ehealthRequired, setEhealthRequired] = useState(false);
  const [doctor, setDoctor] = useState<{ row: DoctorRow; details: DoctorDetails } | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { data: dictData } = useLoader(loadDoctorDictionaries, true);
  const dicts = dictData ?? {};

  if (status === 'signedOut' || status === 'needsPin') return <Redirect href="/" />;

  function setFilter<K extends keyof DoctorFilters>(key: K, value: DoctorFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function fail(e: unknown) {
    setError(handleApiError(e));
    setEhealthRequired(e instanceof ApiError && e.ehealthRequired);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }

  async function runSearch(step: -1 | 0 | 1, nextScope: SearchScope = scope) {
    if (!token) return;
    const offset = nextOffset(results?.offset ?? 0, step);
    const mine = ++seq.current;
    setSearching(true);
    setError(null);
    try {
      const page = await searchDoctors(token, filters, nextScope, offset);
      if (mine === seq.current) setResults({ ...page, offset });
    } catch (e) {
      if (mine === seq.current) {
        setResults(null);
        fail(e);
      }
    } finally {
      if (mine === seq.current) setSearching(false);
    }
  }

  function clearScope() {
    divisionsFor.current = null;
    setScope(EMPTY_SCOPE);
    setDivisions(null);
  }

  function resetSearch() {
    setFilters(EMPTY_FILTERS);
    clearScope();
  }

  function resetScope() {
    clearScope();
    void runSearch(0, EMPTY_SCOPE);
  }

  async function scopeLegalEntity(d: DoctorRow) {
    if (!token) return;
    const next = scopeForLegalEntity(d);
    divisionsFor.current = d.legal_entity_id;
    setScope(next);
    setDivisions(null);
    void runSearch(0, next);
    try {
      const list = await fetchDivisions(token, d.legal_entity_id);
      if (divisionsFor.current === d.legal_entity_id) setDivisions(list);
    } catch (e) {
      fail(e);
    }
  }

  function scopeDivision(next: SearchScope) {
    setScope(next);
    void runSearch(0, next);
  }

  async function showDoctor(row: DoctorRow) {
    if (!token || busyKey) return;
    setBusyKey(`about:${doctorKey(row)}`);
    try {
      const details = await fetchDoctor(token, row.employee_id);
      setShowRaw(false);
      setDoctor({ row, details });
    } catch (e) {
      fail(e);
    } finally {
      setBusyKey(null);
    }
  }

  async function chooseDoctor(d: DoctorRow) {
    if (!token || busyKey) return;
    for (const message of chooseDoctorConfirmations(d)) {
      if (!(await confirmAsync('Подання декларації', `${message}\n\nПродовжити?`, 'Продовжити'))) return;
    }
    setBusyKey(`choose:${doctorKey(d)}`);
    setError(null);
    try {
      const created = await createDeclarationRequest(token, d);
      if (!created.id) throw new Error('Не вдалося створити запит на декларацію. Спробуйте пізніше.');
      setDoctor(null);
      const left = placesLeft(d.declarations_limit, d.declarations_count);
      router.replace({
        pathname: '/declaration-request',
        params: left == null ? { id: created.id } : { id: created.id, left: String(left) },
      });
    } catch (e) {
      setDoctor(null);
      fail(e);
    } finally {
      setBusyKey(null);
    }
  }

  const specialities = specialityOptions(dicts);
  const details = doctor?.details;
  const doctorName = details ? fullName(details) : '';

  return (
    <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={SCREEN_OPTIONS} />
      {ehealthRequired ? (
        <Card tone="warning">
          <Text style={styles.text}>Доступ до ЕСОЗ у цій сесії завершився. Увійдіть через ЕСОЗ знову.</Text>
          <Button title="Увійти знову" onPress={() => void signOut().then(() => router.replace('/'))} />
        </Card>
      ) : null}
      <ErrorBox message={error} />

      <Card>
        <Title>Пошук лікаря для декларації</Title>
        <Field label="ПІБ лікаря" value={filters.name} onChangeText={(v) => setFilter('name', v)}
               autoCorrect={false} returnKeyType="search" onSubmitEditing={() => void runSearch(0)} />
        <Choice label="Спеціальність" value={filters.speciality} options={specialities}
                onChange={(v) => setFilter('speciality', v)} />
        <Pressable onPress={() => setMoreFilters((m) => !m)} accessibilityRole="button"
                   accessibilityState={{ expanded: moreFilters }}
                   style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
          <Text style={styles.linkText}>{moreFilters ? 'Менше фільтрів' : 'Більше фільтрів'}</Text>
        </Pressable>
        {moreFilters ? (
          <>
            <Choice label="Стать лікаря" value={filters.gender} options={GENDER_OPTIONS} onChange={(v) => setFilter('gender', v)} />
            <Field label="Назва закладу (СГуСОЗ)" value={filters.legalEntity} onChangeText={(v) => setFilter('legalEntity', v)}
                   autoCorrect={false} returnKeyType="search" onSubmitEditing={() => void runSearch(0)} />
            <Field label="Назва місця надання послуг (МНП)" value={filters.division} onChangeText={(v) => setFilter('division', v)}
                   autoCorrect={false} returnKeyType="search" onSubmitEditing={() => void runSearch(0)} />
            <Field label="Адреса МНП" placeholder="Населений пункт, вулиця" value={filters.address}
                   onChangeText={(v) => setFilter('address', v)} autoCorrect={false} returnKeyType="search"
                   onSubmitEditing={() => void runSearch(0)} />
            <Choice label="Ліміт декларацій" value={filters.overlimit} options={OVERLIMIT_OPTIONS}
                    onChange={(v) => setFilter('overlimit', v)} />
            <Choice label="Договір з НСЗУ (ПМГ)" value={filters.inContract} options={CONTRACT_OPTIONS}
                    onChange={(v) => setFilter('inContract', v)} />
          </>
        ) : null}
        <View style={styles.actions}>
          <View style={styles.flex}><Button title="Очистити" variant="secondary" onPress={resetSearch} /></View>
          <View style={styles.flex}><Button title="Знайти" onPress={() => void runSearch(0)} busy={searching} /></View>
        </View>
      </Card>

      {scope.label ? (
        <Card>
          <Text style={styles.text}>{scope.label}</Text>
          <Button title="Скинути" variant="secondary" onPress={resetScope}
                  accessibilityHint="Прибрати обмеження пошуку закладом або місцем надання послуг" />
        </Card>
      ) : null}

      {divisions ? (
        <Card>
          <Text style={styles.subheader} accessibilityRole="header">Місця надання послуг закладу:</Text>
          {divisions.length === 0 ? <Muted>—</Muted> : divisions.map((v) => {
            const text = `${v.name ?? ''} — ${v.address_text ?? ''}`;
            return (
              <Pressable key={v.id} onPress={() => scopeDivision(scopeForDivisionRow(scope, v))} accessibilityRole="button"
                         accessibilityLabel={`${text}${v.in_contract ? '' : ' (без договору з НСЗУ)'}`}
                         accessibilityHint="Показати лікарів цього місця надання послуг"
                         style={({ pressed }) => [styles.division, pressed && styles.pressed]}>
                <Text style={styles.text}><Text style={styles.bold}>{v.name}</Text>{` — ${v.address_text ?? ''}`}</Text>
                {v.in_contract ? null : <Text style={styles.warnText}>(без договору з НСЗУ)</Text>}
              </Pressable>
            );
          })}
        </Card>
      ) : null}

      <Text style={styles.subheader} accessibilityRole="header">Результати пошуку</Text>
      <View accessibilityLiveRegion="polite">
        {searching ? (
          <View style={styles.statusRow}>
            <ActivityIndicator color={colors.primary} />
            <Muted>Пошук...</Muted>
          </View>
        ) : !results ? (
          error ? null : <Muted>{MSG_SEARCH_HINT}</Muted>
        ) : results.rows.length === 0 ? (
          <Muted>{MSG_NOT_FOUND}</Muted>
        ) : null}
      </View>

      {!searching && results?.rows.map((d) => {
        const key = doctorKey(d);
        const name = fullName(d);
        return (
          <Card key={key}>
            <Text style={styles.name}>{name}</Text>
            <Muted>{genderAgeText(d, dicts.GENDER)}</Muted>
            <Row label="Спеціальність" value={dictLabel(dicts.SPECIALITY_TYPE, d.speciality)} />
            <View style={styles.rowBlock}>
              <Text style={styles.rowLabel}>Заклад</Text>
              <LinkButton title={d.legal_entity_name || '—'} onPress={() => void scopeLegalEntity(d)}
                          hint="Показати лікарів цього закладу і його місця надання послуг" />
            </View>
            <View style={styles.rowBlock}>
              <Text style={styles.rowLabel}>Місце надання послуг</Text>
              <LinkButton title={d.division_name || '—'} onPress={() => scopeDivision(scopeForDivision(scope, d))}
                          hint="Показати лікарів цього місця надання послуг" />
            </View>
            <Row label="Адреса МНП" value={d.address_text} />
            <Row label="Декларації" value={declarationsText(d.declarations_limit, d.declarations_count)} />
            {d.overlimit ? <Text style={styles.dangerText}>Ліміт перевищено</Text> : null}
            <Row label="Договір з НСЗУ" value={d.in_contract ? 'Є' : 'Немає'} />
            <View style={styles.actions}>
              <View style={styles.flex}>
                <Button title="Про лікаря" variant="secondary" onPress={() => void showDoctor(d)}
                        busy={busyKey === `about:${key}`} disabled={Boolean(busyKey)}
                        accessibilityHint={`Відомості про лікаря ${name}`} />
              </View>
              <View style={styles.flex}>
                <Button title="Обрати" onPress={() => void chooseDoctor(d)}
                        busy={busyKey === `choose:${key}`} disabled={Boolean(busyKey)}
                        accessibilityHint={`Подати декларацію з лікарем ${name}`} />
              </View>
            </View>
          </Card>
        );
      })}

      {!searching && results && (results.offset > 0 || results.hasNext) ? (
        <View style={styles.actions}>
          <View style={styles.flex}>
            {results.offset > 0 ? <Button title="← Попередні" variant="secondary" onPress={() => void runSearch(-1)} /> : null}
          </View>
          <View style={styles.flex}>
            {results.hasNext ? <Button title="Наступні →" variant="secondary" onPress={() => void runSearch(1)} /> : null}
          </View>
        </View>
      ) : null}

      <Modal visible={doctor !== null} animationType="slide" onRequestClose={() => setDoctor(null)}>
        <View style={[styles.modal, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
          <ScrollView contentContainerStyle={styles.modalContent}>
            <Title>{doctorName || 'Лікар'}</Title>
            {details ? (
              <>
                <Row label="Стать" value={dictLabel(dicts.GENDER, details.gender)} />
                <Row label="Вік" value={details.age ? String(details.age) : null} />
                {details.working_experience ? <Row label="Стаж" value={`${details.working_experience} р.`} /> : null}
                {details.declarations_limit != null
                  ? <Row label="Декларації" value={declarationsText(details.declarations_limit, details.declarations_count)} /> : null}
                {details.warning ? <Card tone="warning"><Text style={styles.text}>{details.warning}</Text></Card> : null}
                <List title="Спеціальності" items={specialityLines(details, dicts)} />
                <List title="Освіта" items={educationLines(details, dicts)} />
                <List title="Кваліфікації" items={qualificationLines(details, dicts)} />
                {details.about_myself ? (
                  <View style={styles.listBlock}>
                    <Text style={styles.subheader} accessibilityRole="header">Про себе</Text>
                    <Text style={styles.text}>{details.about_myself}</Text>
                  </View>
                ) : null}
                <Pressable onPress={() => setShowRaw((s) => !s)} accessibilityRole="button" accessibilityState={{ expanded: showRaw }}
                           style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
                  <Text style={styles.linkText}>Усі відомості</Text>
                </Pressable>
                {showRaw ? <Text style={styles.raw} selectable>{JSON.stringify(details, null, 2)}</Text> : null}
              </>
            ) : null}
          </ScrollView>
          <View style={styles.modalActions}>
            {doctor ? (
              <Button title="Обрати" onPress={() => void chooseDoctor(doctor.row)}
                      busy={busyKey === `choose:${doctorKey(doctor.row)}`} disabled={Boolean(busyKey)}
                      accessibilityHint={`Подати декларацію з лікарем ${doctorName}`} />
            ) : null}
            <Button title="Закрити" variant="secondary" onPress={() => setDoctor(null)} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  text: { fontSize: 15, color: colors.text, lineHeight: 21 },
  bold: { fontWeight: '700' },
  name: { fontSize: 17, fontWeight: '700', color: colors.text },
  label: { fontSize: 14, fontWeight: '600', color: colors.ink },
  subheader: { fontSize: 17, fontWeight: '700', color: colors.text },
  choice: { gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: colors.border,
          backgroundColor: colors.surface, justifyContent: 'center' },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 15, color: colors.text },
  chipTextSelected: { color: colors.onAccent, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { fontSize: 16, color: colors.primary, textDecorationLine: 'underline' },
  actions: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  division: { minHeight: 44, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.hairline, gap: 2, justifyContent: 'center' },
  warnText: { fontSize: 14, color: colors.attention },
  dangerText: { fontSize: 14, color: colors.danger, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBlock: { gap: 2, paddingVertical: 4 },
  rowLabel: { fontSize: 13, color: colors.muted },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalContent: { padding: 16, gap: 10 },
  modalActions: { paddingHorizontal: 16, paddingTop: 8, gap: 10 },
  listBlock: { gap: 4 },
  listItem: { fontSize: 15, color: colors.text, lineHeight: 21 },
  raw: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, color: colors.text, backgroundColor: colors.surface, borderWidth: 1,
         borderColor: colors.hairline, borderRadius: 8, padding: 10 },
});
