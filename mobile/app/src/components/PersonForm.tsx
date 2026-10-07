import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Switch, type TextInputProps, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  type DocFields, type Option, type PersonFormValues, type PersonLocks, type Settlement,
  GENDER_FALLBACK, countrySuggestions, loadFormDictionaries, maskDate, needsCapacityDoc, normalizePhone, searchSettlements,
  settlementLabel, toOptions,
} from '../lib/personForm';
import { useLoader } from '../lib/useLoader';
import { Button, Card, Field, Muted, Text, useColors } from './ui';
import { useStyles, type Palette } from '../theme';

export type PersonFormMode = 'sign-up' | 'update';
export type PersonFormUpdater = (update: (prev: PersonFormValues) => PersonFormValues) => void;

const PREFERRED_WAYS: Option[] = [{ value: 'phone', label: 'Телефон' }, { value: 'email', label: 'Електронна пошта' }];
const GENDER_DEFAULT: Option[] = toOptions(GENDER_FALLBACK);
const SETTLEMENTS_SHOWN = 20;
const SEARCH_DELAY_MS = 350;
const NO_LOCKS: PersonLocks = { taxId: false, unzr: false };

/** Мітка для програм зчитування з екрана: «*» -> «обов’язкове поле», помилка — одразу після назви поля. */
function spokenLabel(label: string, error?: string): string {
  const base = label.replace(' *', ', обов’язкове поле');
  return error ? `${base}. Помилка: ${error}` : base;
}

function FieldError({ message }: { message?: string }) {
  const styles = useStyles(makeStyles);
  if (!message) return null;
  return <Text style={styles.fieldError}>{message}</Text>;
}

function TextField({ label, error, note, ...props }: TextInputProps & { label: string; error?: string; note?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.fieldWrap}>
      <Field label={label} accessibilityLabel={spokenLabel(label, error)} accessibilityHint={props.accessibilityHint ?? note} {...props} />
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <FieldError message={error} />
    </View>
  );
}

function DateField({ label, value, onChangeText, error, editable }: {
  label: string; value: string; onChangeText: (v: string) => void; error?: string; editable?: boolean;
}) {
  return (
    <TextField
      label={label} value={value} error={error} editable={editable}
      onChangeText={(t) => onChangeText(maskDate(t))}
      placeholder="ДД.ММ.РРРР" keyboardType="number-pad" maxLength={10}
      accessibilityHint="Формат дати: день, місяць, рік — ДД.ММ.РРРР"
    />
  );
}

/** Вибір зі списку (аналог <select> веб-кабінету): кнопка відкриває перелік варіантів. */
function SelectField({ label, value, options, onSelect, error, disabled }: {
  label: string; value: string; options: Option[]; onSelect: (v: string) => void; error?: string; disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  // Значення з ЕСОЗ, якого немає в довіднику, показується як є (setField у веб)
  const current = value ? options.find((o) => o.value === value)?.label ?? value : '—';
  const title = label.replace(' *', '');
  const items: Option[] = [{ value: '', label: '—' }, ...options];
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${spokenLabel(label, error)}: ${value ? current : 'не обрано'}`}
        accessibilityHint="Відкриває список для вибору"
        accessibilityState={{ disabled: Boolean(disabled), expanded: open }}
        style={({ pressed }) => [styles.select, disabled && styles.disabled, pressed && styles.pressed]}
      >
        <Text style={[styles.selectText, !value && styles.placeholder]} numberOfLines={2}>{current}</Text>
        <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">▾</Text>
      </Pressable>
      <FieldError message={error} />
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modal}>
          <Text style={styles.modalTitle} accessibilityRole="header">{title}</Text>
          <FlatList
            data={items}
            keyExtractor={(o) => o.value || '__empty'}
            renderItem={({ item }) => {
              const selected = item.value === value;
              return (
                <Pressable
                  onPress={() => { onSelect(item.value); setOpen(false); }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={item.value ? item.label : 'Не обрано'}
                  style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{item.label}</Text>
                  {selected ? <Text style={styles.check} accessibilityElementsHidden importantForAccessibility="no">✓</Text> : null}
                </Pressable>
              );
            }}
          />
          <View style={styles.modalFooter}>
            <Button title="Закрити" variant="secondary" onPress={() => setOpen(false)} />
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

/** Невеликий перелік варіантів — перемикачі (radio). */
function ChoiceGroup({ label, value, options, onSelect, error, disabled }: {
  label: string; value: string; options: Option[]; onSelect: (v: string) => void; error?: string; disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={spokenLabel(label, error)} style={styles.chips}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onSelect(o.value)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: Boolean(disabled) }}
              accessibilityLabel={o.label}
              style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <FieldError message={error} />
    </View>
  );
}

/** Перемикач з підписом; уся смуга — ціль дотику не менше 48 dp. */
export function SwitchRow({ label, value, onValueChange, disabled }: {
  label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      style={[styles.switchRow, disabled && styles.disabled]}
    >
      <Switch value={value} onValueChange={onValueChange} disabled={disabled}
              accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text style={styles.switchText}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, error, tone, children }: { title: string; error?: string; tone?: 'default' | 'warning'; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <Card tone={tone}>
      <Text style={styles.sectionTitle} accessibilityRole="header">{title}</Text>
      <FieldError message={error} />
      {children}
    </Card>
  );
}

function DocumentFields({ prefix, value, options, errors, onChange, editable }: {
  prefix: 'doc' | 'cap'; value: DocFields; options: Option[]; errors: Record<string, string>;
  onChange: (patch: Partial<DocFields>) => void; editable: boolean;
}) {
  return (
    <>
      <SelectField label="Тип документа *" value={value.type} options={options} error={errors[`${prefix}.type`]}
                   onSelect={(type) => onChange({ type })} disabled={!editable} />
      <TextField label="Серія та номер *" value={value.number} error={errors[`${prefix}.number`]} editable={editable}
                 onChangeText={(number) => onChange({ number })} autoCapitalize="characters" autoCorrect={false} />
      <DateField label="Дата видачі *" value={value.issued_at} error={errors[`${prefix}.issued_at`]} editable={editable}
                 onChangeText={(issued_at) => onChange({ issued_at })} />
      <TextField label="Ким виданий" value={value.issued_by} error={errors[`${prefix}.issued_by`]} editable={editable}
                 onChangeText={(issued_by) => onChange({ issued_by })} />
      <DateField label="Дійсний до" value={value.expiration_date} error={errors[`${prefix}.expiration_date`]} editable={editable}
                 onChangeText={(expiration_date) => onChange({ expiration_date })} />
    </>
  );
}

type Props = {
  /** 'sign-up' — реєстрація (п.3.5), 'update' — запит на зміну даних (п.3.10.1). */
  mode: PersonFormMode;
  values: PersonFormValues;
  /** Оновлення значень функцією від попереднього стану (сумісно з setState). */
  onChange: PersonFormUpdater;
  /** Помилки біля полів: ключі з mapFieldErrors / validateDates. */
  errors?: Record<string, string>;
  locks?: PersonLocks;
  token?: string | null;
  disabled?: boolean;
};

/**
 * Форма персональних даних пацієнта — спільна для реєстрації в ЕСОЗ і зміни даних (як у веб-кабінеті).
 * Довідники і адреси ЕСОЗ на сервері публічні, тому форма працює і до входу (реєстрація).
 */
export function PersonForm({ mode, values, onChange, errors = {}, locks = NO_LOCKS, token, disabled }: Props) {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const { data: dicts, loading: dictsLoading, reload: reloadDicts } = useLoader(() => loadFormDictionaries(token), true);
  const [settlements, setSettlements] = useState<Settlement[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [countryEdited, setCountryEdited] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    searchSeq.current += 1;
  }, []);

  const editable = !disabled;
  const set = (patch: Partial<PersonFormValues>) => onChange((prev) => ({ ...prev, ...patch }));
  const setDoc = (key: 'doc' | 'cap') => (patch: Partial<DocFields>) =>
    onChange((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const setAddr = (patch: Partial<PersonFormValues['addr']>) => onChange((prev) => ({ ...prev, addr: { ...prev.addr, ...patch } }));
  const setEc = (patch: Partial<PersonFormValues['ec']>) => onChange((prev) => ({ ...prev, ec: { ...prev.ec, ...patch } }));
  const normalizeOnBlur = (pick: (v: PersonFormValues) => string, put: (v: PersonFormValues, phone: string) => PersonFormValues) => () =>
    onChange((prev) => {
      const next = normalizePhone(pick(prev));
      return next === pick(prev) ? prev : put(prev, next);
    });

  function cancelSearch() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    searchSeq.current += 1;
    setSettlements(null);
    setSearching(false);
    setSearchError(null);
  }

  // onRegion у веб: зміна області скидає обраний населений пункт
  function onRegion(region: string) {
    cancelSearch();
    set({ region, settlement: null, settlement_query: '' });
  }

  // searchSettlements у веб: пошук від 2 символів із затримкою 350 мс
  function onSettlementQuery(query: string) {
    cancelSearch();
    set({ settlement_query: query, settlement: null });
    const region = values.region;
    const name = query.trim();
    if (!region || name.length < 2) return;
    const seq = searchSeq.current;
    timer.current = setTimeout(() => {
      setSearching(true);
      searchSettlements(region, name, token).then(
        (list) => {
          if (seq !== searchSeq.current) return;
          setSettlements(list);
          setSearching(false);
        },
        () => {
          if (seq !== searchSeq.current) return;
          setSearchError('Не вдалося виконати пошук населеного пункту. Спробуйте ще раз.');
          setSearching(false);
        },
      );
    }, SEARCH_DELAY_MS);
  }

  // onSettlement у веб
  function onSettlementPick(s: Settlement) {
    cancelSearch();
    set({ settlement: s, settlement_query: s.name });
  }

  const capacityShown = needsCapacityDoc(values);
  const taxIdLocked = mode === 'update' && locks.taxId;
  const unzrLocked = mode === 'update' && locks.unzr;
  const suggestions = countryEdited ? countrySuggestions(dicts?.countries ?? [], values.birth_country) : [];
  const typeLabels = dicts?.settlementTypes ?? {};
  const regionOptions = (dicts?.regions ?? []).map((r) => ({ value: r, label: r }));

  return (
    <View style={styles.form}>
      {dictsLoading && !dicts ? (
        <View style={styles.inline} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.primary} />
          <Muted>Завантаження довідників ЕСОЗ…</Muted>
        </View>
      ) : null}
      {dicts?.failed ? (
        <Card tone="warning">
          <Text style={styles.warningText} accessibilityRole="alert">
            Не вдалося завантажити довідники ЕСОЗ (типи документів, області). Перевірте з’єднання з інтернетом.
          </Text>
          <Button title="Завантажити довідники ще раз" variant="secondary" busy={dictsLoading} onPress={reloadDicts} />
        </Card>
      ) : null}

      <Section title="Персональні дані">
        <TextField label="Прізвище *" value={values.last_name} error={errors.last_name} editable={editable}
                   onChangeText={(last_name) => set({ last_name })} autoComplete="name-family" textContentType="familyName" />
        <TextField label="Ім'я *" value={values.first_name} error={errors.first_name} editable={editable}
                   onChangeText={(first_name) => set({ first_name })} autoComplete="name-given" textContentType="givenName" />
        <TextField label="По батькові" value={values.second_name} error={errors.second_name} editable={editable}
                   onChangeText={(second_name) => set({ second_name })} autoComplete="name-middle" textContentType="middleName" />
        <DateField label="Дата народження *" value={values.birth_date} error={errors.birth_date} editable={editable}
                   onChangeText={(birth_date) => set({ birth_date })} />
        <ChoiceGroup label="Стать *" value={values.gender} options={dicts?.gender ?? GENDER_DEFAULT} error={errors.gender}
                     onSelect={(gender) => set({ gender })} disabled={!editable} />
        <View>
          <TextField label="Країна народження *" value={values.birth_country} error={errors.birth_country} editable={editable}
                     onChangeText={(birth_country) => { setCountryEdited(true); set({ birth_country }); }} />
          {suggestions.length > 0 ? (
            <View style={styles.list} accessibilityLabel="Підказки країни народження">
              {suggestions.map((c) => (
                <Pressable key={c} onPress={() => { setCountryEdited(false); set({ birth_country: c }); }}
                           accessibilityRole="button" accessibilityLabel={`Обрати країну: ${c}`}
                           style={({ pressed }) => [styles.listItem, pressed && styles.pressed]}>
                  <Text style={styles.listItemText}>{c}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
        <TextField label="Місце народження *" value={values.birth_settlement} error={errors.birth_settlement} editable={editable}
                   onChangeText={(birth_settlement) => set({ birth_settlement })} />
        <TextField label="УНЗР" value={values.unzr} error={errors.unzr} editable={editable && !unzrLocked}
                   onChangeText={(unzr) => set({ unzr })} placeholder="РРРРММДД-ХХХХХ" keyboardType="numbers-and-punctuation"
                   maxLength={14} autoCorrect={false} note={unzrLocked ? 'УНЗР, внесений раніше, змінити неможливо' : undefined} />
        <TextField label="РНОКПП" value={values.tax_id} error={errors.tax_id} editable={editable && !taxIdLocked && !values.no_tax_id}
                   onChangeText={(t) => set({ tax_id: t.replace(/\D/g, '') })} keyboardType="number-pad" maxLength={10}
                   placeholder={values.no_tax_id ? 'Не вказується (відмова від РНОКПП)' : undefined}
                   note={taxIdLocked ? 'РНОКПП, внесений раніше, змінити неможливо' : undefined} />
        <SwitchRow label="Відмовився(-лась) від РНОКПП" value={values.no_tax_id} disabled={!editable || taxIdLocked}
                   onValueChange={(v) => set(v ? { no_tax_id: true, tax_id: '' } : { no_tax_id: false })} />
        <TextField label="Кодове слово *" value={values.secret} error={errors.secret} editable={editable}
                   onChangeText={(secret) => set({ secret })} placeholder="6–20 літер або цифр"
                   autoCapitalize="none" autoCorrect={false} autoComplete="off" />
        <TextField label="Електронна пошта" value={values.email} error={errors.email} editable={editable}
                   onChangeText={(email) => set({ email })} keyboardType="email-address" autoCapitalize="none"
                   autoCorrect={false} autoComplete="email" textContentType="emailAddress" />
        <ChoiceGroup label="Бажаний спосіб зв'язку *" value={values.preferred_way_communication} options={PREFERRED_WAYS}
                     error={errors.preferred_way_communication} disabled={!editable}
                     onSelect={(preferred_way_communication) => set({ preferred_way_communication })} />
      </Section>

      <Section title="Документ, що посвідчує особу *" error={errors.documents}>
        <DocumentFields prefix="doc" value={values.doc} options={dicts?.identityDocs ?? []} errors={errors}
                        onChange={setDoc('doc')} editable={editable} />
      </Section>
      {capacityShown ? (
        <Section title="Документ, що посвідчує дієздатність (для пацієнтів до повної дієздатності)" tone="warning">
          <DocumentFields prefix="cap" value={values.cap} options={dicts?.capacityDocs ?? []} errors={errors}
                          onChange={setDoc('cap')} editable={editable} />
        </Section>
      ) : null}

      <Section title="Адреса фактичного місця проживання *" error={errors.addresses}>
        <SelectField label="Область *" value={values.region} options={regionOptions} error={errors.region}
                     onSelect={onRegion} disabled={!editable} />
        <View>
          <TextField label="Населений пункт * (почніть вводити назву)" value={values.settlement_query} error={errors.settlement}
                     editable={editable} onChangeText={onSettlementQuery} placeholder="Назва населеного пункту" autoCorrect={false}
                     accessibilityHint={values.region ? 'Після введення двох літер з’явиться перелік населених пунктів' : 'Спочатку оберіть область'} />
          {!values.region && values.settlement_query ? <Muted>Спочатку оберіть область.</Muted> : null}
          {searching ? (
            <View style={styles.inline} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.primary} />
              <Muted>Пошук…</Muted>
            </View>
          ) : null}
          {searchError ? <Text style={styles.fieldError} accessibilityLiveRegion="polite">{searchError}</Text> : null}
          {settlements && settlements.length === 0 ? (
            <Text style={styles.note} accessibilityLiveRegion="polite">Населений пункт не знайдено. Перевірте назву та область.</Text>
          ) : null}
          {settlements && settlements.length > 0 ? (
            <View style={styles.list} accessibilityLabel="Знайдені населені пункти">
              {settlements.slice(0, SETTLEMENTS_SHOWN).map((s, i) => (
                <Pressable key={`${s.id}-${i}`} onPress={() => onSettlementPick(s)} accessibilityRole="button"
                           accessibilityLabel={`Обрати: ${settlementLabel(s, typeLabels)}`}
                           style={({ pressed }) => [styles.listItem, pressed && styles.pressed]}>
                  <Text style={styles.listItemText}>{settlementLabel(s, typeLabels)}</Text>
                </Pressable>
              ))}
              {settlements.length > SETTLEMENTS_SHOWN ? (
                <Text style={styles.note}>Показано перші {SETTLEMENTS_SHOWN}. Уточніть назву, щоб знайти потрібний.</Text>
              ) : null}
            </View>
          ) : null}
          {values.settlement ? (
            <Text style={styles.selected} accessibilityLiveRegion="polite">Обрано: {settlementLabel(values.settlement, typeLabels)}</Text>
          ) : null}
        </View>
        <SelectField label="Тип вулиці" value={values.addr.street_type} options={dicts?.streetTypes ?? []}
                     onSelect={(street_type) => setAddr({ street_type })} disabled={!editable} />
        <TextField label="Вулиця" value={values.addr.street} editable={editable} onChangeText={(street) => setAddr({ street })} />
        <TextField label="Будинок" value={values.addr.building} editable={editable} onChangeText={(building) => setAddr({ building })} />
        <TextField label="Квартира" value={values.addr.apartment} editable={editable} onChangeText={(apartment) => setAddr({ apartment })} />
        <TextField label="Поштовий індекс" value={values.addr.zip} editable={editable} keyboardType="number-pad" maxLength={5}
                   onChangeText={(zip) => setAddr({ zip })} autoComplete="postal-code" textContentType="postalCode" />
      </Section>

      <Section title="Контакти">
        <TextField label="Мобільний телефон *" value={values.phone} error={errors.phone} editable={editable}
                   onChangeText={(phone) => set({ phone })} placeholder="+380XXXXXXXXX" keyboardType="phone-pad"
                   autoComplete="tel" textContentType="telephoneNumber"
                   onEndEditing={normalizeOnBlur((v) => v.phone, (v, phone) => ({ ...v, phone }))} />
        {mode === 'sign-up' ? (
          <TextField label="Телефон для автентифікації (SMS) *" value={values.auth_phone} error={errors.auth_phone} editable={editable}
                     onChangeText={(auth_phone) => set({ auth_phone })} placeholder="+380XXXXXXXXX — мобільний оператор України"
                     keyboardType="phone-pad" note="Якщо не заповнено, використовується мобільний телефон."
                     onEndEditing={normalizeOnBlur((v) => v.auth_phone, (v, auth_phone) => ({ ...v, auth_phone }))} />
        ) : null}
        <Text style={styles.subTitle} accessibilityRole="header">{'Особа для екстреного зв’язку *'}</Text>
        <FieldError message={errors.ec} />
        <TextField label="Прізвище *" value={values.ec.last_name} editable={editable} onChangeText={(last_name) => setEc({ last_name })} />
        <TextField label="Ім'я *" value={values.ec.first_name} editable={editable} onChangeText={(first_name) => setEc({ first_name })} />
        <TextField label="По батькові" value={values.ec.second_name} editable={editable}
                   onChangeText={(second_name) => setEc({ second_name })} />
        <TextField label="Телефон *" value={values.ec.phone} error={errors['ec.phone']} editable={editable}
                   onChangeText={(phone) => setEc({ phone })} placeholder="+380XXXXXXXXX" keyboardType="phone-pad"
                   onEndEditing={normalizeOnBlur((v) => v.ec.phone, (v, phone) => ({ ...v, ec: { ...v.ec, phone } }))} />
      </Section>
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  form: { gap: 12 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldWrap: { gap: 4 },
  label: { fontSize: 14, fontWeight: '600', color: colors.ink },
  note: { fontSize: 13, color: colors.muted },
  fieldError: { fontSize: 14, color: colors.danger },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  subTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 8 },
  warningText: { fontSize: 15, color: colors.attention },
  select: {
    minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12,
    backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  selectText: { flex: 1, fontSize: 16, color: colors.text, paddingVertical: 10 },
  placeholder: { color: colors.muted },
  chevron: { fontSize: 16, color: colors.muted },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.8 },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalTitle: { fontSize: 20, fontWeight: '700', color: colors.text, padding: 16 },
  modalFooter: { padding: 16 },
  option: {
    minHeight: 52, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: 1, borderBottomColor: colors.hairline, backgroundColor: colors.surface,
  },
  optionSelected: { backgroundColor: colors.accentTint },
  optionText: { flex: 1, fontSize: 16, color: colors.text, paddingVertical: 12 },
  optionTextSelected: { fontWeight: '700', color: colors.primary },
  check: { fontSize: 18, color: colors.primary, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 48, minWidth: 96, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 16, color: colors.text },
  chipTextSelected: { color: colors.onAccent, fontWeight: '600' },
  switchRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { flex: 1, fontSize: 15, color: colors.text },
  list: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface, marginTop: 4 },
  listItem: { minHeight: 48, paddingHorizontal: 12, justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: colors.hairline },
  listItemText: { fontSize: 15, color: colors.text, paddingVertical: 10 },
  selected: { fontSize: 14, color: colors.success, fontWeight: '600', marginTop: 4 },
});
