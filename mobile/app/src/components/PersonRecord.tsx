import { type ReactNode, useState } from 'react';
import { Linking, Platform, Pressable, View, StyleSheet } from 'react-native';

import type { Rec } from '../lib/personForm';
import {
  type RecordDicts, type VerificationItem, dictText, fullName, groupDocuments, lacksResidence, maskSecret, noTaxIdText,
  preferredWayText, splitLinks, verificationReasonText, verificationStatusText,
} from '../lib/personRecord';
import { Card, formatDate, Muted, Row, Text, Title } from './ui';
import { useStyles, type Palette } from '../theme';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}

function Raw({ title, data }: { title: string; data: unknown }) {
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }}
                 accessibilityLabel={`${title}: ${open ? 'сховати' : 'показати'} усі відомості`} style={styles.link}>
        <Text style={styles.linkText}>{open ? 'Сховати усі відомості' : 'Усі відомості'}</Text>
      </Pressable>
      {open ? <Text selectable style={styles.raw}>{JSON.stringify(data, null, 2)}</Text> : null}
    </View>
  );
}

/** Повідомлення з посиланням на портал підтримки НСЗУ (п.3.9.3.3): посилання відкривається натисканням. */
export function LinkedText({ text, style }: { text: string; style?: object }) {
  const styles = useStyles(makeStyles);
  return (
    <Text style={style}>
      {splitLinks(text).map((part, i) => (part.url ? (
        <Text key={i} style={styles.inlineLink} accessibilityRole="link" onPress={() => void Linking.openURL(part.url!)}>{part.text}</Text>
      ) : <Text key={i}>{part.text}</Text>))}
    </Text>
  );
}

/** п.3.9.2: усі атрибути запису про пацієнта; відсутні значення — порожні («—»). */
export function PersonRecord({ person, dicts }: { person: Rec; dicts: RecordDicts }) {
  const styles = useStyles(makeStyles);
  const [secretShown, setSecretShown] = useState(false);
  const docs = groupDocuments(person.documents);
  const addresses: Rec[] = Array.isArray(person.addresses) ? person.addresses : [];
  const phones: Rec[] = Array.isArray(person.phones) ? person.phones : [];
  const ec: Rec = person.emergency_contact ?? {};
  const ecPhones: Rec[] = Array.isArray(ec.phones) ? ec.phones : [];

  const documentList = (list: Rec[]) => (list.length ? list.map((d, i) => (
    <View key={`${d.type}-${i}`} style={styles.box}>
      <Row label="Тип документа" value={dictText(dicts, 'DOCUMENT_TYPE', d.type)} />
      <Row label="Серія та номер" value={d.number} />
      <Row label="Дата видачі" value={formatDate(d.issued_at)} />
      <Row label="Дійсний до" value={formatDate(d.expiration_date)} />
      <Row label="Ким виданий" value={d.issued_by} />
    </View>
  )) : <Muted>—</Muted>);

  return (
    <Card>
      <Title>{fullName(person) || 'Пацієнт'}</Title>
      <Section title="Персональні дані">
        <Row label="Ім'я" value={person.first_name} />
        <Row label="Прізвище" value={person.last_name} />
        <Row label="По батькові" value={person.second_name} />
        <Row label="Дата народження" value={formatDate(person.birth_date)} />
        <Row label="Стать" value={dictText(dicts, 'GENDER', person.gender)} />
        <Row label="Країна народження" value={dictText(dicts, 'COUNTRY', person.birth_country)} />
        <Row label="Місце народження" value={person.birth_settlement} />
        <Row label="РНОКПП" value={person.tax_id} />
        <Row label="Відмова від РНОКПП" value={noTaxIdText(person.no_tax_id)} />
        <Row label="УНЗР" value={person.unzr} />
        <View style={styles.secretRow}>
          <View style={{ flex: 1 }}>
            <Row label="Кодове слово" value={secretShown ? person.secret : maskSecret(person.secret)} />
          </View>
          {person.secret ? (
            <Pressable onPress={() => setSecretShown((v) => !v)} accessibilityRole="button" style={styles.link}
                       accessibilityLabel={secretShown ? 'Сховати кодове слово' : 'Показати кодове слово'}>
              <Text style={styles.linkText}>{secretShown ? 'сховати' : 'показати'}</Text>
            </Pressable>
          ) : null}
        </View>
        <Row label="Бажаний спосіб зв'язку" value={preferredWayText(person.preferred_way_communication)} />
        <Row label="Електронна пошта" value={person.email} />
      </Section>

      <Section title="Адреси">
        {lacksResidence(addresses) ? (
          <Text style={styles.warning} accessibilityRole="alert">Вам необхідно вказати адресу фактичного місця проживання</Text>
        ) : null}
        {addresses.length ? addresses.map((a, i) => (
          <View key={`${a.type}-${i}`} style={styles.box}>
            <Row label="Тип адреси" value={dictText(dicts, 'ADDRESS_TYPE', a.type)} />
            <Row label="Країна" value={dictText(dicts, 'COUNTRY', a.country)} />
            <Row label="Область" value={a.area} />
            <Row label="Район" value={a.region} />
            <Row label="Населений пункт" value={a.settlement} />
            <Row label="Тип населеного пункту" value={dictText(dicts, 'SETTLEMENT_TYPE', a.settlement_type)} />
            <Row label="Тип вулиці" value={dictText(dicts, 'STREET_TYPE', a.street_type)} />
            <Row label="Вулиця" value={a.street} />
            <Row label="Будинок" value={a.building} />
            <Row label="Квартира" value={a.apartment} />
            <Row label="Поштовий індекс" value={a.zip} />
          </View>
        )) : <Muted>—</Muted>}
      </Section>

      <Section title="Документи, що посвідчують особу">{documentList(docs.identity)}</Section>
      <Section title="Документи про набуття цивільної дієздатності">{documentList(docs.capacity)}</Section>

      <Section title="Контактні телефони">
        {phones.length ? phones.map((ph, i) => (
          <Row key={`${ph.number}-${i}`} label={dictText(dicts, 'PHONE_TYPE', ph.type) || 'Телефон'} value={ph.number} />
        )) : <Muted>—</Muted>}
      </Section>

      <Section title="Особа для екстреного зв'язку">
        <Row label="Ім'я" value={ec.first_name} />
        <Row label="Прізвище" value={ec.last_name} />
        <Row label="По батькові" value={ec.second_name} />
        {ecPhones.length ? ecPhones.map((ph, i) => (
          <Row key={`${ph.number}-${i}`} label={dictText(dicts, 'PHONE_TYPE', ph.type) || 'Телефон'} value={ph.number} />
        )) : <Row label="Телефон" value="" />}
      </Section>
      <Raw title="Запис про пацієнта в ЕСОЗ" data={person} />
    </Card>
  );
}

/** п.3.9.3: статуси верифікації за напрямами (правила показу — на сервері), причина, коментар і повідомлення. */
export function VerificationCard({ items, dicts }: { items: VerificationItem[]; dicts: RecordDicts }) {
  const styles = useStyles(makeStyles);
  return (
    <Card>
      <Text style={styles.sectionTitle} accessibilityRole="header">Статуси верифікації</Text>
      {items.length === 0 ? <Muted>Відомості про верифікацію відсутні.</Muted> : null}
      {items.map((v) => (
        <View key={v.direction} style={styles.box}>
          <Text style={styles.itemTitle}>{v.label}</Text>
          <Text style={[styles.status, v.status === 'NOT_VERIFIED' && styles.statusBad]}>{verificationStatusText(dicts, v.status)}</Text>
          <Row label="Причина" value={verificationReasonText(dicts, v.reason)} />
          {v.comment ? <Row label="Коментар" value={v.comment} /> : null}
          {v.message ? <LinkedText text={v.message} style={[styles.message, v.status === 'NOT_VERIFIED' && styles.statusBad]} /> : null}
        </View>
      ))}
      {/* п.3.9.3.8: загальний статус і напрями, не передбачені ТВ, не показуються */}
    </Card>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  section: { gap: 4, paddingTop: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  box: { borderWidth: 1, borderColor: colors.hairline, borderRadius: 10, padding: 10, gap: 2, backgroundColor: colors.page },
  secretRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  warning: { color: colors.attention, backgroundColor: colors.attentionTint, borderColor: colors.attentionBorder, borderWidth: 1, borderRadius: 8, padding: 8, fontSize: 15 },
  link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { color: colors.primary, textDecorationLine: 'underline', fontSize: 15 },
  inlineLink: { color: colors.primary, textDecorationLine: 'underline' },
  raw: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, color: colors.text, backgroundColor: colors.surface,
         borderWidth: 1, borderColor: colors.hairline, borderRadius: 8, padding: 10 },
  itemTitle: { fontWeight: '600', fontSize: 15, color: colors.text },
  status: { fontSize: 15, color: colors.muted },
  statusBad: { color: colors.attention },
  message: { fontSize: 14, color: colors.text, lineHeight: 20 },
});
