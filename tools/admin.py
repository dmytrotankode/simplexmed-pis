"""
Адміністративна утилита «Плексі» (запускати на сервері, де є .env з доступом до БД):

    python pis/tools/admin.py testers                      # список тестувальників
    python pis/tools/admin.py tester-add <РНОКПП|uuid> [--days 90] [--kind qa|nszu|audit]
    python pis/tools/admin.py tester-remove <РНОКПП|uuid>
    python pis/tools/admin.py marks [--csv файл]           # протокол відміток тестування (усі тестувальники)

Утиліта не друкує персональних даних, окрім РНОКПП, який ви самі передали. Веб-адмінка — за планом docs/medone-analysis/03-admin.md.
"""
import argparse
import csv
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), "backend")
sys.path.insert(0, BACKEND)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.getenv("PIS_ENV_FILE", "/root/simplex-patient-dev/.env"))
import pis_service  # noqa: E402

UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


def resolve_user(cur, who):
    if UUID_RE.match(who):
        cur.execute("SELECT id FROM pis_core.users WHERE id = %s;", (who,))
    else:
        cur.execute("SELECT id FROM pis_core.users WHERE tax_id = %s;", (who,))
    rows = cur.fetchall()
    if len(rows) != 1:
        raise SystemExit(f"Знайдено користувачів: {len(rows)} (потрібно рівно 1). Користувач має хоча б раз увійти в кабінет.")
    return rows[0]["id"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("testers")
    a = sub.add_parser("tester-add"); a.add_argument("who"); a.add_argument("--days", type=int, default=90)
    a.add_argument("--kind", default="qa", choices=["qa", "nszu", "audit"])
    r = sub.add_parser("tester-remove"); r.add_argument("who")
    m = sub.add_parser("marks"); m.add_argument("--csv")
    args = ap.parse_args()

    conn = pis_service.get_db()
    try:
        with conn.cursor() as cur:
            if args.cmd == "testers":
                cur.execute("SELECT t.user_id, t.kind, t.valid_until, t.created_at, "
                            "(SELECT COUNT(*) FROM pis_core.tester_marks m WHERE m.user_id = t.user_id) AS marks "
                            "FROM pis_core.tester_users t ORDER BY t.created_at;")
                for row in cur.fetchall():
                    print(f"{row['user_id']}  {row['kind']:6} до {row['valid_until'] or '—'}  відміток: {row['marks']}")
            elif args.cmd == "tester-add":
                uid = resolve_user(cur, args.who)
                cur.execute("INSERT INTO pis_core.tester_users (user_id, kind, valid_until) "
                            "VALUES (%s, %s, NOW() + (%s || ' days')::interval) "
                            "ON CONFLICT (user_id) DO UPDATE SET kind = EXCLUDED.kind, valid_until = EXCLUDED.valid_until;",
                            (uid, args.kind, str(args.days)))
                conn.commit()
                print(f"Тестувальника додано: {uid} ({args.kind}, {args.days} діб)")
            elif args.cmd == "tester-remove":
                uid = resolve_user(cur, args.who)
                cur.execute("DELETE FROM pis_core.tester_users WHERE user_id = %s;", (uid,))
                conn.commit()
                print(f"Тестувальника видалено: {uid}")
            elif args.cmd == "marks":
                cur.execute("SELECT user_id, scenario_id, platform, status, note, updated_at "
                            "FROM pis_core.tester_marks ORDER BY scenario_id, platform, updated_at;")
                rows = cur.fetchall()
                out = csv.writer(open(args.csv, "w", encoding="utf-8-sig", newline="") if args.csv else sys.stdout)
                out.writerow(["сценарій", "платформа", "статус", "тестувальник", "дата", "нотатка"])
                for x in rows:
                    out.writerow([x["scenario_id"], x["platform"], x["status"], x["user_id"],
                                  x["updated_at"].isoformat() if x["updated_at"] else "", x["note"]])
                if args.csv:
                    print(f"Записано {len(rows)} рядків у {args.csv}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
