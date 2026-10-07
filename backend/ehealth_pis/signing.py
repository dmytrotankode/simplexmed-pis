"""
Допоміжні функції для підписаного контенту (п.1.6 ТВ ПІС).

Сам ЕП (CAdES-X Long) накладається на стороні користувача засобом КЕП (бібліотека ІІТ /
Дія.Підпис). Сервер лише готує дані до підпису і нормалізує base64 перед відправкою.
"""

import base64
import binascii
import json

BOM = "﻿"


def content_to_sign(data):
    """Дані для підпису: JSON у UTF-8 без BOM (п.1.6.3), закодований у base64."""
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return base64.b64encode(text.replace(BOM, "").encode("utf-8")).decode("ascii")


def strip_bom_from_base64(b64_text):
    """
    п.1.6.3: перевірити контент, закодований в BASE64, і видалити символ U+FEFF.
    Застосовується до непідписаних даних перед накладанням ЕП.
    """
    raw = base64.b64decode(b64_text, validate=True)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return b64_text  # бінарний контент (наприклад, вже підписаний CMS) не змінюємо
    if BOM not in text:
        return b64_text
    return base64.b64encode(text.replace(BOM, "").encode("utf-8")).decode("ascii")


def is_base64(value):
    try:
        base64.b64decode(value, validate=True)
        return True
    except (binascii.Error, ValueError, TypeError):
        return False
