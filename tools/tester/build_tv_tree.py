"""Дерево вимог ТВ ПІС №978 із тексту наказу: docs/tv_pis_978.txt -> web/tester/tv-tree.json.

    python pis/tools/tester/build_tv_tree.py

Вузол: {"id": "3.5.4.8", "text": "...", "parent": "3.5.4"}. Розділи 3.2 і 3.4 (АПІС) позначаються applies=false —
Плексі є КПІС.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PIS = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(PIS, "docs", "tv_pis_978.txt")
OUT = os.path.join(PIS, "backend", "tester_data", "tv-tree.json")

ITEM = re.compile(r"^(\d{1,2}(?:\.\d{1,3}){0,6})\.?\s+(\S.*)$")
NOT_APPLICABLE = ("3.2", "3.4")


def parse(text):
    started = False
    nodes, cur = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("=== PAGE") or re.fullmatch(r"\d{1,3}", line):
            continue
        # зміст і преамбула — до першого «1. ЗАГАЛЬНІ ВИМОГИ» у тілі документа
        m = ITEM.match(line)
        if m and (started or re.match(r"1\.?\s+ЗАГАЛЬН", line, re.I)):
            started = True
            item_id, body = m.group(1), m.group(2)
            if "." not in item_id and item_id not in ("1", "2", "3"):
                m = None
            else:
                if item_id in nodes:      # повторення заголовка (зміст) — не затираємо
                    cur = None
                    continue
                nodes[item_id] = {"id": item_id, "text": body}
                cur = item_id
                continue
        if started and cur and not ITEM.match(line):
            nodes[cur]["text"] += " " + line
    return nodes


def main():
    with open(SRC, encoding="utf-8") as f:
        nodes = parse(f.read())
    out = []
    for item_id in sorted(nodes, key=lambda s: [int(p) for p in s.split(".")]):
        n = nodes[item_id]
        parent = item_id.rsplit(".", 1)[0] if "." in item_id else None
        n["text"] = re.sub(r"\s+", " ", n["text"]).strip()
        n["parent"] = parent if parent in nodes else None
        n["applies"] = not any(item_id == p or item_id.startswith(p + ".") for p in NOT_APPLICABLE)
        out.append(n)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"source": "Наказ НСЗУ №978 від 08.12.2025, ТВ до ПІС v2", "nodes": out}, f, ensure_ascii=False, indent=0)
    leaves = [n for n in out if not any(o["parent"] == n["id"] for o in out) and n["applies"]]
    print(f"вузлів: {len(out)}, листків (застосовних): {len(leaves)} -> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
