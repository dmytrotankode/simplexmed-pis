"""Конфігурація клієнта eHealth PIS API."""

import os
from dataclasses import dataclass, field

# Повний набір скоупів ПІС зі специфікації (pis/docs/ehealth-pis-api.apib).
# Згідно п.1.4.3 ТВ ПІС запитуємо лише ті, що потрібні для роботи кабінету.
DEFAULT_SCOPES = (
    "app:read_pis",
    "app:delete_pis",
    "person:details_pis",
    "person_verification:details_pis",
    "person_documents:write_pis",
    "authentication_method:read_pis",
    "authentication_method:write_pis",
    "authentication_method:deactivate_pis",
    "authentication_method_request:write_pis",
    "person_request:read_pis",
    "person_request:details_pis",
    "person_request:write_pis",
    "person_request:reject_pis",
    "declaration:read_pis",
    "declaration:details_pis",
    "declaration:terminate_pis",
    "declaration_request:read_pis",
    "declaration_request:details_pis",
    "declaration_request:write_pis",
    "declaration_request:sign_pis",
    "declaration_request:reject_pis",
)

# API ПІС на preprod обслуговує окремий шлюз pis-preprod (на api-preprod маршрутів /api/pis/* немає)
PREPROD = {
    "api_host": "https://pis-preprod.ehealth.gov.ua",
    "auth_host": "https://auth-preprod.ehealth.gov.ua",
    "login_host": "https://pis-auth-preprod.ehealth.gov.ua",
}


@dataclass
class PisConfig:
    client_id: str
    client_secret: str  # він же API-key (обов'язковий заголовок для всіх викликів)
    redirect_uri: str
    api_host: str = PREPROD["api_host"]      # /api/pis/*, /api/uaddresses, /api/v2/dictionaries
    auth_host: str = PREPROD["auth_host"]    # /oauth/nonce, /oauth/tokens, /auth/logout
    login_host: str = PREPROD["login_host"]  # UI сервісу авторизації: /sign-in, /sign-up
    scopes: tuple = field(default_factory=lambda: DEFAULT_SCOPES)
    psk: str = ""                            # X-Custom-PSK для проходження WAF preprod
    timeout: int = 60                        # п.1.3.2: не менше 60 секунд
    pis_name: str = "SimplexMed"
    support_contacts: str = ""
    # Портал підтримки НСЗУ/ЕСОЗ для повідомлень ТВ із "[url переходу на створення запиту ...]"
    # Сторінка НСЗУ «Процедура отримання інформації або внесення змін до Реєстрів ЦБД ЕСОЗ» (звернення щодо даних про себе)
    nhsu_support_url: str = ("https://nszu.gov.ua/gromadianam/onlain-formi/"
                             "procedura-otrimannia-informaciyi-abo-vnesennia-zmin-d-1")
    user_agent: str = "SimplexMed-PIS/2.1"

    def __post_init__(self):
        if self.timeout < 60:
            raise ValueError("Таймаут запитів до ЕСОЗ має бути не менше 60 секунд (п.1.3.2 ТВ ПІС)")

    @property
    def scope_string(self):
        return " ".join(self.scopes)

    @classmethod
    def from_env(cls, prefix="PIS_", **overrides):
        """
        Читає змінні оточення:
        PIS_CLIENT_ID, PIS_CLIENT_SECRET (або файл PIS_CRED_FILE з парами key=value),
        PIS_REDIRECT_URI, PIS_API_HOST, PIS_AUTH_HOST, PIS_LOGIN_HOST, PIS_SCOPES,
        PIS_EHEALTH_PSK, PIS_NAME, PIS_SUPPORT_CONTACTS.
        """
        env = lambda key, default="": os.getenv(prefix + key, default)
        client_id, client_secret = env("CLIENT_ID"), env("CLIENT_SECRET")
        if not (client_id and client_secret) and env("CRED_FILE"):
            file_id, file_secret = read_credentials_file(env("CRED_FILE"))
            client_id, client_secret = client_id or file_id, client_secret or file_secret
        values = {
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": env("REDIRECT_URI", "https://simplex-med.com"),
            "api_host": env("API_HOST", PREPROD["api_host"]),
            "auth_host": env("AUTH_HOST", PREPROD["auth_host"]),
            "login_host": env("LOGIN_HOST", PREPROD["login_host"]),
            "psk": env("EHEALTH_PSK"),
            "pis_name": env("NAME", "Плексі"),
            "support_contacts": env("SUPPORT_CONTACTS", "support@simplex-med.com"),
        }
        if env("NHSU_SUPPORT_URL"):
            values["nhsu_support_url"] = env("NHSU_SUPPORT_URL")
        if env("SCOPES"):
            values["scopes"] = tuple(env("SCOPES").split())
        values.update(overrides)
        return cls(**values)


def read_credentials_file(path):
    """Файл видачі доступу ЕСОЗ: рядки key=value (client_id, client_secret / mis_api_key)."""
    client_id = client_secret = ""
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if "=" not in line:
                    continue
                key, value = (part.strip() for part in line.split("=", 1))
                key = key.lower()
                if key == "client_id":
                    client_id = value
                elif "secret" in key or "api_key" in key:
                    client_secret = value
    return client_id, client_secret
