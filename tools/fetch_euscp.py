"""
Завантажує бібліотеку підпису АТ «ІІТ» (EndUser, euscp) і дані ЦСК у pis/web/lib/euscp.

Файли пропрієтарні й не зберігаються в git (див. .gitignore) — їх тягне цей скрипт
під час розгортання. Версія бібліотеки закріплена разом із SHA-256.

    python pis/tools/fetch_euscp.py            # завантажити все
    python pis/tools/fetch_euscp.py --check    # лише перевірити наявні файли

Бібліотека: npm-пакет @it-enterprise/digital-signature (перевірено 1.4.7:
підтримує геш ДСТУ 7564:2014 для КЕП нового зразка).
Дані ЦСК: ті самі файли, з якими працює кабінет ДПС (CAs.json з IIT, але
CACertificates.p7b саме звідти — версія з iit.com.ua валить Initialize з кодом 49).
"""

import argparse
import hashlib
import io
import json
import os
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "web", "lib", "euscp")

PACKAGE_VERSION = "1.4.7"
PACKAGE_URL = ("https://registry.npmjs.org/@it-enterprise/digital-signature/-/"
               f"digital-signature-{PACKAGE_VERSION}.tgz")
LIBRARY_FILES = {
    # шлях у npm-пакеті -> (ім'я файлу, sha256)
    "package/euscp/euscp.js": ("euscp.js",
                               "c98b0443209c27610a531eec0064d424d527810cf6f7384e1174ffb8360a61b3"),
    "package/dist/euscp.worker.js": ("euscp.worker.js",
                                     "5ee4caab852b04b0272722ba2834f7589f0ad76c655247d3f52ee4b161aa4362"),
}
CA_DATA = {
    "data/CAs.json": "https://cabinet.tax.gov.ua/ws/api/crypto/public_sign/data/CAs.json",
    "data/CACertificates.p7b": "https://cabinet.tax.gov.ua/ws/api/crypto/public_sign/data/CACertificates.p7b",
}


def _download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SimplexMed-PIS-deploy"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch():
    os.makedirs(os.path.join(DEST, "data"), exist_ok=True)
    print(f"npm @it-enterprise/digital-signature@{PACKAGE_VERSION} ...")
    with tarfile.open(fileobj=io.BytesIO(_download(PACKAGE_URL)), mode="r:gz") as tar:
        for member_path, (name, expected) in LIBRARY_FILES.items():
            data = tar.extractfile(member_path).read()
            if _sha256(data) != expected:
                raise SystemExit(f"SHA-256 {name} не збігається — файл змінено, не встановлюємо")
            with open(os.path.join(DEST, name), "wb") as f:
                f.write(data)
            print(f"  {name}: OK ({len(data)} байт)")
    for rel, url in CA_DATA.items():
        data = _download(url)
        if rel.endswith(".json"):
            json.loads(data.decode("utf-8-sig"))  # має бути валідний JSON
        with open(os.path.join(DEST, rel), "wb") as f:
            f.write(data)
        print(f"  {rel}: OK ({len(data)} байт)")


def check():
    ok = True
    for _, (name, expected) in LIBRARY_FILES.items():
        path = os.path.join(DEST, name)
        if not os.path.exists(path) or _sha256(open(path, "rb").read()) != expected:
            print(f"  {name}: відсутній або змінений")
            ok = False
    for rel in CA_DATA:
        if not os.path.exists(os.path.join(DEST, rel)):
            print(f"  {rel}: відсутній")
            ok = False
    print("Бібліотека КЕП на місці" if ok else "Запустіть: python pis/tools/fetch_euscp.py")
    return ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        sys.exit(0 if check() else 1)
    fetch()
