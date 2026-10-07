"""
Генерує ehealth_pis/annex1_errors.json з текстової версії Додатку 1
("Таблиця обробки помилок") до ТВ ПІС (наказ НСЗУ № 978).

Запуск:  python pis/tools/build_annex1.py

Колонки таблиці: Метод API | Опис перевірки | Оригінальний текст помилки |
Опис помилки | Повідомлення ПІС для користувача | Дії ПІС.
Текст витягнуто з PDF построково, тому межі колонок відновлюються евристикою:
- код HTTP-статусу (або латинський рядок для sign-in/sign-up) відділяє перевірку від тексту помилки;
- опис помилки — перший кириличний рядок і його продовження з малої літери;
- повідомлення — наступні рядки до ключових слів дій ("КПІС", "АПІС", "ПІС повинна", "Запропонувати").
"""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "tv_pis_978_dodatok1.txt")
DST = os.path.join(ROOT, "backend", "ehealth_pis", "annex1_errors.json")

HEADER_LAST = "Дії ПІС"
METHOD_RE = re.compile(r"^(TRUSTED PIS\.|PIS\.|Logout$|Renew access token)")
STATUS_RE = re.compile(r"^(\d{3})\b[,\s]*(.*)$")
CYR_RE = re.compile(r"[А-Яа-яІіЇїЄєҐґ]")
UPPER_START_RE = re.compile(r"^[А-ЯІЇЄҐA-Z\"«]")
ACTION_RE = re.compile(r"^(КПІС|АПІС|ПІС повинна|ПІС має|Запропонувати)")
# Назви методів, що в PDF переносяться на наступний рядок
METHOD_FIXUPS = {
    "PIS. Exchange oAuth Code Grant to Access": "PIS. Exchange oAuth Code Grant to Access Token",
    "PIS. Resend authorization OTP for": "PIS. Resend authorization OTP for authentication method request",
    "TRUSTED PIS. Initialize Update Person": "TRUSTED PIS. Initialize Update Person details",
}
METHOD_TAILS = {"Token", "authentication method request", "details"}


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


def _starts_new_cell(line, prev):
    # "Користувач" у таблиці — термін із великої літери, а не початок нової клітинки
    if line.startswith("Користувач") and not re.search(r"[.!?]$", prev):
        return False
    return bool(UPPER_START_RE.match(line))


def _split_texts(rest):
    if not rest:
        return "", "", ""
    i = 1
    while i < len(rest) and not _starts_new_cell(rest[i], rest[i - 1]):
        i += 1
    description = rest[:i]
    j = i
    while j < len(rest) and not ACTION_RE.match(rest[j]):
        j += 1
    message, action = rest[i:j], rest[j:]
    if not message:  # повідомлення збігається з описом
        message = description
    join = lambda xs: re.sub(r"\s+", " ", " ".join(xs)).strip()
    return join(description), join(message), join(action)


def parse_row(row):
    lines = row["lines"]
    check, i = [], 0
    status = None
    while i < len(lines) and not STATUS_RE.match(lines[i]) and CYR_RE.search(lines[i]):
        check.append(lines[i])
        i += 1
    error = []
    if i < len(lines) and STATUS_RE.match(lines[i]):
        m = STATUS_RE.match(lines[i])
        status = int(m.group(1))
        if m.group(2):
            error.append(m.group(2))
        i += 1
    while i < len(lines) and not CYR_RE.search(lines[i]):
        error.append(lines[i])
        i += 1
    if status is None and not error:
        # Помилки сервісу авторизації без коду і латинського тексту: усі клітинки кириличні,
        # тому ділимо за рядками, що починаються з великої літери
        cells, cur = [], []
        for k, line in enumerate(check):
            if cur and _starts_new_cell(line, check[k - 1]):
                cells.append(cur)
                cur = []
            cur.append(line)
        if cur:
            cells.append(cur)
        if len(cells) >= 3:
            check = cells[0]
            error = cells[1]
            lines = sum(cells[2:], [])
            i = 0
    if status is None:
        m = re.search(r"\b(\d{3})\b", " ".join(error))
        status = int(m.group(1)) if m else None
    description, message, action = _split_texts(lines[i:])
    return {
        "method": row["method"],
        "check": re.sub(r"\s+", " ", " ".join(check)).strip(),
        "status": status,
        "error": re.sub(r"\s+", " ", " ".join(error)).strip(" '\","),
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
