"""
gunicorn для SimplexMed ПІС (замість вбудованого dev-сервера Flask).

    venv/bin/gunicorn -c backend/gunicorn.conf.py

Один воркер із потоками: фонове оновлення кешу реєстрів (п.3.12) має працювати в одному процесі,
а SQLite-кеш — без конкурентних записувачів. Запити до ЕСОЗ можуть тривати до 60 с (п.1.3.2),
тому таймаут воркера — 120 с.
"""

import os

from dotenv import load_dotenv

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.getenv("PIS_ENV_FILE") or os.path.join(_root, ".env"), override=False)

chdir = os.path.dirname(os.path.abspath(__file__))
wsgi_app = "app:app"
bind = f"{os.getenv('PIS_HOST', '127.0.0.1')}:{os.getenv('PIS_PORT', '3122')}"
workers = 1
threads = int(os.getenv("PIS_THREADS", "8"))
worker_class = "gthread"
timeout = 120
graceful_timeout = 30
accesslog = "-"
errorlog = "-"
forwarded_allow_ips = "127.0.0.1"


def post_worker_init(worker):
    import app
    app.start_registry_refresh()
