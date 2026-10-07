#!/usr/bin/env python3
"""
Перевірка актуальності технічних вимог до ПІС і специфікації PIS API.

НСЗУ змінює вимоги новими наказами (нова редакція — новий документ на ehealth.gov.ua), а eHealth —
специфікацію API (github.com/ehealth-ua/pis-api). Скрипт порівнює опубліковане з pis/docs/tz-manifest.json:
  - перелік документів ПІС на сторінці технічних вимог (нові або прибрані редакції);
  - вміст відомих документів (sha256 — документ могли перезалити за тією ж адресою);
  - apiary.apib PIS API.

    python pis/tools/check_tz_updates.py            # звіт; код виходу 1, якщо щось змінилося
    python pis/tools/check_tz_updates.py --update   # прийняти поточний стан як відомий (після аудиту)

Лише стандартна бібліотека: працює і локально, і на сервері.
"""
import hashlib
import html
import json
import os
import re
import sys
import urllib.request
from datetime import date

TV_PAGE = "https://ehealth.gov.ua/technichni_vymogy/"
API_RAW = "https://raw.githubusercontent.com/ehealth-ua/pis-api/main/apiary.apib"
MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "tz-manifest.json")
# Сайт ЕСОЗ відповідає 402 клієнтам без браузерного User-Agent
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def pis_documents(page_html):
    """Посилання на документи сторінки технічних вимог, що стосуються ПІС (назва посилання -> URL)."""
    docs = {}
    for href, text in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page_html, re.S | re.I):
        title = html.unescape(" ".join(re.sub(r"<[^>]+>", "", text).split()))
        if not re.search(r"\.(pdf|docx?|zip)$", href, re.I):
            continue
        if re.search(r"ПІС|PIS", title + " " + href) or re.search(r"TV-do-PIS|-PIS-", href, re.I):
            docs[href if href.startswith("http") else "https:" + href] = title
    return docs


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    update = "--update" in sys.argv
    with open(MANIFEST, encoding="utf-8") as f:
        manifest = json.load(f)
    changes = []

    published = pis_documents(fetch(TV_PAGE).decode("utf-8", "replace"))
    known = {d["url"]: d for d in manifest["documents"]}
    for url, title in published.items():
        if url not in known:
            changes.append(f"НОВИЙ документ ПІС: {title}\n    {url}")
    for url, d in known.items():
        if url not in published:
            changes.append(f"Документ зник зі сторінки (замінено новою редакцією?): {d['title']}\n    {url}")

    new_docs = []
    for url, title in published.items():
        digest = sha256(fetch(url))
        old = known.get(url)
        if old and old["sha256"] != digest:
            changes.append(f"Документ змінено за тією ж адресою: {title}\n    {url}")
        new_docs.append({"title": title, "url": url, "sha256": digest})

    api_digest = sha256(fetch(API_RAW))
    if api_digest != manifest["api"]["sha256"]:
        changes.append(f"Специфікацію PIS API змінено: {API_RAW}\n    порівняйте з pis/docs/ehealth-pis-api.apib")

    print(f"Чинна редакція за маніфестом: {manifest['current_edition']}")
    if changes:
        print("ЗМІНИ — потрібен аудит ПІС (веб, BFF, мобільний застосунок):")
        for c in changes:
            print(" - " + c)
    else:
        print(f"Змін немає: {len(published)} документів ПІС і PIS API відповідають маніфесту.")

    if update:
        manifest["documents"] = sorted(new_docs, key=lambda d: d["url"])
        manifest["api"]["sha256"] = api_digest
        manifest["checked_at"] = date.today().isoformat()
        with open(MANIFEST, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print("Маніфест оновлено.")
    return 1 if changes and not update else 0


if __name__ == "__main__":
    sys.exit(main())
