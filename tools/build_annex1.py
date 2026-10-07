"""
Генерує ehealth_pis/annex1_errors.json з текстової версії Додатку 1
("Таблиця обробки помилок") до ТВ ПІС (наказ НСЗУ № 978).

Запуск:  python pis/tools/build_annex1.py

Колонки таблиці: Метод API | Опис перевірки | Оригінальний текст помилки |
Опис помилки | Повідомлення ПІС для користувача | Дії ПІС.
Текст витягнуто з PDF построково (клітинки переносяться на кілька рядків), тому межі колонок
відновлюються так:
- рядок, що починається з HTTP-статусу (1xx–5xx), відкриває колонку тексту помилки; усе перед ним —
  опис перевірки (навіть латиницею, напр. "type = OTP");
- без статусу (помилки сервісу авторизації): помилка — перший блок рядків без кирилиці;
- далі текст помилки триває, доки рядки без кирилиці;
- опис помилки — одна клітинка: наступний рядок належить їй, якщо він є переносом (почався б
  на попередньому рядку, якби вмістився в ширину колонки) і не починає відоме повідомлення;
- повідомлення — до ключових слів дій ("КПІС", "АПІС", "ПІС повинна", "Запропонувати").
"""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "tv_pis_978_dodatok1.txt")
DST = os.path.join(ROOT, "backend", "ehealth_pis", "annex1_errors.json")

HEADER_LAST = "Дії ПІС"
METHOD_RE = re.compile(r"^(TRUSTED PIS\.|PIS\.|Logout$|Renew access token|Verify phone number$)")
STATUS_RE = re.compile(r"^([45]\d\d)(?![\d.,]\d)\b[.,:]?\s*(.*)$")
CYR_RE = re.compile(r"[А-Яа-яІіЇїЄєҐґ]")
UPPER_START_RE = re.compile(r"^[А-ЯІЇЄҐA-Z\"«]")
ACTION_RE = re.compile(r"^(КПІС|АПІС|ПІС повинна|ПІС має|Запропонувати)")
# Назви методів, що в PDF переносяться на наступний рядок
METHOD_FIXUPS = {
    "PIS. Exchange oAuth Code Grant to Access": "PIS. Exchange oAuth Code Grant to Access Token",
    "PIS. Resend authorization OTP for": "PIS. Resend authorization OTP for authentication method request",
    "TRUSTED PIS. Initialize Update Person": "TRUSTED PIS. Initialize Update Person details",
    "PIS. Get declarations limit and declarations":
        "PIS. Get declarations limit and declarations count per practitioner (Bulk data export)",
}
METHOD_TAILS = {"Token", "authentication method request", "details", "count per practitioner (Bulk data export)"}
# Ширина колонки "Опис помилки" у символах (найдовші рядки клітинок — 40–41 символ)
DESCRIPTION_WIDTH = 38
# Початки повідомлень для користувача (колонка 5), які можуть іти одразу після довгого рядка опису
MESSAGE_OPENINGS = (
    "Сталася помилка", "Увага! Персональні дані", "Неможливо однозначно ідентифікувати", "Пацієнта не знайдено в системі",
    "Недійсний електронний підпис.", "Знайдений за даними електронного", "Увійти у свій особистий",
    "Помилка авторизації:", "Ваш електронний підпис не може", "Лікар обраної спеціалізації",
    "Подати декларацію цьому лікареві", "Неможливо подати заявку", "Статус заяви на подання",
    "Декларація з таким номером", "Наразі не вдалось завантажити", "Запис про пацієнта оновлювався",
    "Цей суб’єкт господарювання", "Цей суб'єкт господарювання", "Цей номер телефону перевищив",
    "Це місце надання послуг", "Самостійно зареєструватись може",
)
# Типові початки колонки "Опис помилки" (для рядків, де всі клітинки кириличні)
DESCRIPTION_OPENINGS = ("Помилка даних пацієнтської", "Некоректні дані для", "Для вашої ролі")


def _clean_lines(path):
    lines, skip = [], False
    for raw in open(path, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("=== PAGE") or re.fullmatch(r"\d+", line):
            continue
        if line.startswith("Додаток №1"):
            skip = True
        if skip:
            if line == HEADER_LAST:
                skip = False
            continue
        lines.append(line)
    return lines


def _split_rows(lines):
    rows, cur = [], None
    for line in lines:
        if METHOD_RE.match(line):
            if cur:
                rows.append(cur)
            glued = re.match(r"^(.*?\(Bulk data export\))\s+(.*)$", line)
            method = glued.group(1) if glued else line
            cur = {"method": METHOD_FIXUPS.get(method, method), "lines": [glued.group(2)] if glued else []}
        elif cur is not None:
            if not cur["lines"] and line in METHOD_TAILS:
                continue  # хвіст перенесеної назви методу
            cur["lines"].append(line)
    if cur:
        rows.append(cur)
    return rows


def _first_word(line):
    return line.split(" ", 1)[0]


def _is_wrap(prev, line):
    """Чи може line бути переносом тексту клітинки prev (слово не вмістилося б на попередньому рядку)."""
    return len(prev.rstrip()) + 1 + len(_first_word(line)) > DESCRIPTION_WIDTH


def _starts_new_cell(line, prev):
    """Межа "Опис помилки" -> "Повідомлення": для рядка, що йде після prev у колонці опису."""
    if line.startswith(MESSAGE_OPENINGS):
        return True
    if not UPPER_START_RE.match(line):
        return False
    # "Користувач" у таблиці — термін із великої літери, а не початок нової клітинки
    if line.startswith("Користувач") and not re.search(r"[.!?]$", prev):
        return False
    return not _is_wrap(prev, line)


def _split_texts(rest):
    if not rest:
        return "", "", ""
    i = 1
    while i < len(rest) and not ACTION_RE.match(rest[i]) and not _starts_new_cell(rest[i], rest[i - 1]):
        i += 1
    description = rest[:i]
    j = i
    while j < len(rest) and not ACTION_RE.match(rest[j]):
        j += 1
    message, action = rest[i:j], rest[j:]
    if not message:  # повідомлення збігається з описом
        message = description
    join = lambda xs: re.sub(r"\s+", " ", " ".join(xs)).strip()  # noqa: E731
    return join(description), join(message), join(action)


def parse_row(row):
    lines = row["lines"]
    status, check, error = None, [], []
    status_at = next((k for k, line in enumerate(lines) if STATUS_RE.match(line)), None)
    if status_at is not None:
        check = lines[:status_at]
        m = STATUS_RE.match(lines[status_at])
        status = int(m.group(1))
        if m.group(2):
            error.append(m.group(2))
        i = status_at + 1
    else:
        i = 0
        while i < len(lines) and CYR_RE.search(lines[i]):
            check.append(lines[i])
            i += 1
    while i < len(lines) and not CYR_RE.search(lines[i]):
        error.append(lines[i])
        i += 1
    if status is None and not error:
        # Помилки сервісу авторизації без коду і латинського тексту: усі клітинки кириличні,
        # тому ділимо за рядками, що починають нову клітинку
        cells, cur = [], []
        for k, line in enumerate(check):
            if cur and (line.startswith(DESCRIPTION_OPENINGS + MESSAGE_OPENINGS)
                        or (UPPER_START_RE.match(line) and not _is_wrap(check[k - 1], line))):
                cells.append(cur)
                cur = []
            cur.append(line)
        if cur:
            cells.append(cur)
        if len(cells) >= 3:
            check, error = cells[0], cells[1]
            lines = sum(cells[2:], [])
            i = 0
    if status is None:
        m = re.search(r"\b([45]\d\d)\b", " ".join(error))
        status = int(m.group(1)) if m else None
    description, message, action = _split_texts(lines[i:])
    return {
        "method": row["method"],
        "check": re.sub(r"\s+", " ", " ".join(check)).strip(),
        "status": status,
        "error": re.sub(r"\s+", " ", " ".join(error)).strip(" '\",.‘’"),
        "description": description,
        "user_message": message,
        "action": action,
    }


def build():
    rows = [parse_row(r) for r in _split_rows(_clean_lines(SRC))]
    with open(DST, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    return rows


if __name__ == "__main__":
    out = build()
    print(f"{len(out)} rows -> {DST}")
