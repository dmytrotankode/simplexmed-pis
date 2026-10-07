"""
Помилки eHealth та їх обробка згідно з Додатком 1 до ТВ ПІС ("Таблиця обробки помилок").

Таблиця лежить у annex1_errors.json (генерується pis/tools/build_annex1.py).
Користувачу показуємо текст із колонки "Повідомлення ПІС для користувача" (п.1.5.4),
підставляючи назву і контакти підтримки ПІС.
"""

import json
import os
import re

ANNEX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "annex1_errors.json")
GENERIC_MESSAGE = "Сталася помилка. Зверніться до технічної підтримки [назва ПІС]: [контакти підтримки ПІС]"
DEFAULT_SUPPORT_CONTACTS = "support@simplex-med.com"
NETWORK_MESSAGE = "Сервіс ЕСОЗ тимчасово недоступний. Спробуйте, будь ласка, пізніше."


class EhealthApiError(Exception):
    """Помилка виклику API ЕСОЗ із підготовленим повідомленням для користувача."""

    def __init__(self, api_method, status, message="", error_type="", invalid=None,
                 payload=None, user_message="", action=""):
        self.api_method = api_method
        self.status = status
        self.message = message or ""
        self.error_type = error_type or ""
        self.invalid = invalid or []
        self.payload = payload
        self.user_message = user_message or GENERIC_MESSAGE
        self.action = action
        super().__init__(f"{api_method}: HTTP {status} {error_type} {message}".strip())

    def to_dict(self):
        return {
            "error": self.user_message,
            "api_method": self.api_method,
            "status": self.status,
            "error_type": self.error_type,
            # Технічний текст помилки (мережа, TLS) клієнту не передаємо — лише в журнал
            "error_message": self.message if self.error_type != "network" else None,
            "invalid": self.invalid,
            # Дія ПІС за Додатком 1 (напр. запропонувати перейти до зміни персональних даних)
            "action": self.action,
            "next_step": next_step(self.action),
        }


# Текст помилки від ЕСОЗ або сервісу авторизації обрізаємо: зіставлення — регулярними виразами
MAX_ERROR_TEXT = 2000
# Плейсхолдери в тексті помилки таблиці: %{property}, # {limit}, <<types>>, <type>, [Назва]
PLACEHOLDER_RE = re.compile(r"%\{[^}]*\}|#\s*\{[^}]*\}|<<?[^<>]*>>?|\[[^\]]*\]")


def _norm(text):
    text = str(text or "")[:MAX_ERROR_TEXT].lower()
    text = re.sub(r"[‘’'\"`«»]", "", text)
    return re.sub(r"\s+", " ", text).strip(" .")


def _pattern(error_text):
    """Текст помилки з таблиці -> regex; плейсхолдери — обмежений фрагмент (без катастрофічного перебору)."""
    text = re.sub(r"^(message|error)\s*:\s*", "", _norm(error_text))
    parts = [p.strip() for p in PLACEHOLDER_RE.split(text)]
    return re.compile(r".{0,200}?".join(re.escape(p) for p in parts if p) or r"(?!)")


def next_step(action):
    """Машинна підказка клієнту з тексту «Дії ПІС» Додатку 1: person-edit | sign-up | None."""
    text = (action or "").lower()
    if "оновлення даних" in text:
        return "person-edit"
    if "процедури реєстрації" in text:
        return "sign-up"
    return None


class Annex1:
    def __init__(self, path=ANNEX_PATH, pis_name="SimplexMed", support_contacts="", support_url=""):
        with open(path, encoding="utf-8") as f:
            self.rows = json.load(f)
        for row in self.rows:
            row["_pattern"] = _pattern(row["error"]) if row["error"] else None
        self.pis_name = pis_name
        self.support_contacts = support_contacts
        self.support_url = support_url

    def generic_message(self):
        return self._render(GENERIC_MESSAGE)

    def _render(self, text):
        text = (text.replace("[назва ПІС]", self.pis_name)
                    .replace("[контакти підтримки ПІС]", self.support_contacts or DEFAULT_SUPPORT_CONTACTS))
        if self.support_url:
            text = re.sub(r"\[url переходу на[^\]]*\]", self.support_url, text)
        return text

    def resolve(self, api_method, status=None, message="", error_type=""):
        """
        Повертає (user_message, action) для помилки; якщо збігу немає — загальне повідомлення.
        Шукаємо лише серед рядків цього методу; з кількох збігів — найконкретніший (найдовший текст помилки).
        """
        texts = [_norm(t) for t in (message, error_type) if t]
        candidates = [r for r in self.rows if r["method"] == api_method]
        best, best_len = None, -1
        for row in candidates:
            if status is not None and row["status"] not in (None, status):
                continue
            if row["_pattern"] and any(row["_pattern"].search(t) for t in texts):
                if len(row["error"]) > best_len:
                    best, best_len = row, len(row["error"])
        if best is None and not texts:
            best = next((r for r in candidates if r["status"] == status), None)
        if best is None:
            return self._render(GENERIC_MESSAGE), ""
        return self._render(best["user_message"] or GENERIC_MESSAGE), best["action"]
