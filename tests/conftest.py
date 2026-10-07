"""Спільні налаштування тестів: кеш реєстрів у тимчасовій теці, без фонового оновлення."""

import os
import tempfile

os.environ.setdefault("PIS_REGISTRY_DB", os.path.join(tempfile.mkdtemp(prefix="pis-tests-"), "registry.sqlite3"))
os.environ.setdefault("PIS_REGISTRY_REFRESH", "0")
