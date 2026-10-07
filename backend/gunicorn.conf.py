"""
gunicorn для SimplexMed ПІС (замість вбудованого dev-сервера Flask).

    venv/bin/gunicorn -c backend/gunicorn.conf.py

РІВНО ОДИН ВОРКЕР — не змінювати. У пам'яті процесу живуть:
  * незавершені входи мобільного застосунку: state і одноразові handle (/ehealth/return/app ->
    /api/auth/mobile/redeem). З кількома воркерами повернення з ЕСОЗ і обмін handle потрапляють у різні
    процеси, і вхід у застосунок випадково «застаріває»;
  * лічильники обмеження частоти запитів (rate_limit): з N воркерами реальний ліміт у N разів більший;
  * фонове оновлення кешу реєстрів (п.3.12): один потік на сервер, SQLite-кеш без конкурентних записувачів.
Паралельність дають потоки (PIS_THREADS, gthread). Іншу кількість воркерів — WEB_CONCURRENCY, PIS_WORKERS,
GUNICORN_CMD_ARGS="--workers N", -w N у командному рядку, SIGTTIN — цей файл ігнорує з попередженням
у журналі й повертає 1.

Запити до ЕСОЗ можуть тривати до 60 с (п.1.3.2), тому таймаут воркера — 120 с (nginx чекає 130 с).
"""

import os
import shlex
import sys

from dotenv import load_dotenv

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.getenv("PIS_ENV_FILE") or os.path.join(_root, ".env"), override=False)

REQUIRED_WORKERS = 1
_WORKERS_WARNING = ("SimplexMed ПІС: gunicorn має працювати рівно з 1 воркером (входи мобільного застосунку "
                    "і лічильники обмеження частоти зберігаються в пам'яті процесу); %s проігноровано. "
                    "Для паралельності збільште PIS_THREADS.")


def _cmd_args_workers():
    """Кількість воркерів із GUNICORN_CMD_ARGS (-w N, -wN, --workers N, --workers=N) або None."""
    try:
        args = shlex.split(os.getenv("GUNICORN_CMD_ARGS", ""))
    except ValueError:
        return None
    value = None
    for i, arg in enumerate(args):
        if arg in ("-w", "--workers"):
            value = args[i + 1] if i + 1 < len(args) else ""
        elif arg.startswith("--workers="):
            value = arg.split("=", 1)[1]
        elif arg.startswith("-w") and len(arg) > 2:
            value = arg[2:]
    return value


def _requested_workers():
    """Інша кількість воркерів, яку оточення намагається підставити поза цим файлом."""
    found = [f"{name}={os.getenv(name).strip()}" for name in ("WEB_CONCURRENCY", "PIS_WORKERS")
             if (os.getenv(name) or "").strip() not in ("", str(REQUIRED_WORKERS))]
    value = _cmd_args_workers()
    if value is not None and value.strip() != str(REQUIRED_WORKERS):
        found.append(f"GUNICORN_CMD_ARGS --workers {value}")
    return found


for _source in _requested_workers():
    print("WARNING: " + _WORKERS_WARNING % _source, file=sys.stderr)

chdir = os.path.dirname(os.path.abspath(__file__))
wsgi_app = "app:app"
bind = f"{os.getenv('PIS_HOST', '127.0.0.1')}:{os.getenv('PIS_PORT', '3122')}"
workers = REQUIRED_WORKERS
threads = int(os.getenv("PIS_THREADS", "8"))
worker_class = "gthread"
timeout = 120
graceful_timeout = 30
accesslog = "-"
errorlog = "-"
# X-Forwarded-* приймаються лише від nginx на цьому ж сервері
forwarded_allow_ips = "127.0.0.1"


def _force_single_worker(server, source):
    """Повертає 1 воркер, хоч би звідки прийшло інше значення (-w у командному рядку, SIGTTIN, SIGHUP)."""
    server.log.warning(_WORKERS_WARNING, source)
    server.cfg.set("workers", REQUIRED_WORKERS)
    # Атрибут, а не властивість num_workers: присвоєння властивості знову викликало б nworkers_changed
    server._num_workers = REQUIRED_WORKERS


def nworkers_changed(server, new_value, old_value):
    # Після кожної зміни кількості воркерів: запуск, перечитування (SIGHUP), SIGTTIN/SIGTTOU; 0 — штатна зупинка
    if new_value is not None and new_value > REQUIRED_WORKERS:
        _force_single_worker(server, f"workers={new_value}")


def on_starting(server):
    if server.cfg.workers != REQUIRED_WORKERS:
        _force_single_worker(server, f"workers={server.cfg.workers}")


def on_reload(server):
    # SIGHUP: конфігурацію перечитано; нові воркери запускаються за cfg.workers одразу після цього хука
    if server.cfg.workers != REQUIRED_WORKERS:
        _force_single_worker(server, f"workers={server.cfg.workers}")


def post_worker_init(worker):
    import app
    app.start_registry_refresh()
