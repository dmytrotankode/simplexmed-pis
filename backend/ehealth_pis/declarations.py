"""Подання Декларації через КПІС (п.3.11.1 ТВ ПІС)."""

import json

# Тексти повідомлень, визначені ТВ ПІС
MSG_OVERLIMIT = ("Обраний лікар уже має рекомендовану кількість пацієнтів. Запит на декларацію буде надіслано лікарю "
                 "на погодження — це займе до 7 календарних днів, і лікар може його відхилити.")
MSG_NO_CONTRACT = ("Щоб отримувати медичні послуги безоплатно за Програмою медичних гарантій, оберіть заклад, який має "
                   "договір з НСЗУ. Обраний вами медичний заклад не має договору з НСЗУ або це місце надання послуг не "
                   "входить до такого договору. Через це держава не зможе оплачувати надані вам послуги первинної "
                   "медичної допомоги за декларацією. Радимо сконтактувати з закладом та уточнити, чи можна подати "
                   "декларацію саме тут.")
MSG_APPROVED = ("Обраний Вами лікар вже має рекомендовану кількість пацієнтів. Ми надіслали лікарю Вашу декларацію на "
                "погодження. Це займе до 7 календарних днів.")
MSG_SIGNED = "Вітаємо з вибором лікаря! Декларацію № {declaration_number} лікарю {doctor} успішно подано."
MSG_TERMINATE_CONFIRM = "Увага! Припинення дії Декларації є незворотною дією. Ви впевнені?"
NEAR_LIMIT_THRESHOLD = 20   # п.3.11.1.10: попередження, якщо до ліміту лишається менше 20


def declaration_sign_content(request_data):
    """
    Дані для підпису "PIS. Sign Declaration request": data_to_be_signed з відповіді створення
    (або деталей) запиту, з person.patient_signed = true.
    """
    to_sign = dict((request_data or {}).get("data_to_be_signed") or {})
    if not to_sign:
        raise ValueError("ЕСОЗ не повернула дані для підпису декларації")
    person = dict(to_sign.get("person") or {})
    person["patient_signed"] = True
    to_sign["person"] = person
    return json.dumps(to_sign, ensure_ascii=False, separators=(",", ":"))


def limit_warning(declarations_limit, declarations_count):
    """п.3.11.1.6 / 3.11.1.10: попередження за станом ліміту декларацій лікаря."""
    if declarations_limit is None:
        return None
    left = declarations_limit - (declarations_count or 0)
    if left <= 0:
        return MSG_OVERLIMIT
    if left < NEAR_LIMIT_THRESHOLD:
        return f"У лікаря залишилося {left} місць до рекомендованого ліміту декларацій."
    return None


def sign_result_message(sign_response_data, doctor_name=""):
    """п.3.11.1.11: повідомлення за статусом запиту після підпису."""
    status = str((sign_response_data or {}).get("status") or "").upper()
    if status == "APPROVED":
        return MSG_APPROVED
    if status == "SIGNED":
        return MSG_SIGNED.format(declaration_number=(sign_response_data or {}).get("declaration_number") or "",
                                 doctor=doctor_name or "")
    return None
