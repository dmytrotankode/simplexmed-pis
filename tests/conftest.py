"""Спільні налаштування тестів: кеш реєстрів у тимчасовій теці, без фонового оновлення."""

import atexit
import os
import shutil
import tempfile

_TMP = tempfile.mkdtemp(prefix="pis-tests-")
atexit.register(shutil.rmtree, _TMP, True)
os.environ.setdefault("PIS_REGISTRY_DB", os.path.join(_TMP, "registry.sqlite3"))
os.environ.setdefault("PIS_REGISTRY_REFRESH", "0")
