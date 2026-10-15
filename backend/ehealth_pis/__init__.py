"""
eHealth PIS API — переносимий клієнт для кваліфікованої пацієнтської інформаційної системи.

    from ehealth_pis import PisClient, PisConfig
    client = PisClient(PisConfig.from_env())
    url = client.sign_in_url(state="...", user_data=signed_nonce_b64)
    tokens = client.exchange_code(code)
    person = client.get_person(tokens.access_token)
"""

__version__ = "2.3.0"

from .client import PisClient, TokenSet, validate_document_file
from .config import DEFAULT_SCOPES, PisConfig
from .errors import Annex1, EhealthApiError

__all__ = ["__version__", "PisClient", "PisConfig", "TokenSet", "EhealthApiError", "Annex1",
           "DEFAULT_SCOPES", "validate_document_file"]
