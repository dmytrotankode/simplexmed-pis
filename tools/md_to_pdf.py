"""Документи пакета для НСЗУ: Markdown -> PDF (A4) через headless Chrome/Edge.

    python pis/tools/md_to_pdf.py pis/docs/submission/user_guide.md [ще файли...]

PDF зберігається поруч із вихідним файлом.
"""
import html
import os
import subprocess
import sys
import tempfile

import markdown

BROWSERS = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            "google-chrome", "chromium"]

STYLE = """
@page { size: A4; margin: 18mm 16mm; }
body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #121926; }
h1 { font-size: 18pt; margin: 0 0 8pt; } h2 { font-size: 13.5pt; margin: 16pt 0 6pt; page-break-after: avoid; }
h3 { font-size: 11.5pt; margin: 12pt 0 4pt; page-break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; page-break-inside: auto; }
th, td { border: 1px solid #CDD5DF; padding: 4pt 6pt; vertical-align: top; text-align: left; }
th { background: #EEF1F6; } tr { page-break-inside: avoid; }
code { font-family: Consolas, monospace; font-size: 9pt; background: #F5F7FA; padding: 0 2pt; }
pre { background: #F5F7FA; padding: 6pt; font-size: 8.5pt; white-space: pre-wrap; }
hr { border: 0; border-top: 1px solid #E3E8EF; margin: 12pt 0; }
a { color: #273FCC; text-decoration: none; }
figure { margin: 8pt 0 12pt; page-break-inside: avoid; text-align: center; }
img.shot { max-width: 100%; max-height: 120mm; border: 1px solid #E3E8EF; border-radius: 4pt; }
img.shot.phone { max-height: 110mm; }
figcaption { font-size: 8.5pt; color: #4B5565; margin-top: 3pt; }
"""


def browser():
    for b in BROWSERS:
        if os.path.isabs(b) and os.path.exists(b):
            return b
    return BROWSERS[-1]


def convert(md_path):
    with open(md_path, encoding="utf-8") as f:
        text = f.read()
    title = next((l.lstrip("# ").strip() for l in text.splitlines() if l.startswith("# ")), os.path.basename(md_path))
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
    base = "file:///" + os.path.dirname(os.path.abspath(md_path)).replace("\\", "/") + "/"
    page = (f"<!doctype html><html lang='uk'><head><meta charset='utf-8'><base href='{base}'><title>{html.escape(title)}</title>"
            f"<style>{STYLE}</style></head><body>{body}</body></html>")
    pdf_path = os.path.splitext(os.path.abspath(md_path))[0] + ".pdf"
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as tmp:
        tmp.write(page)
    try:
        subprocess.run([browser(), "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--allow-file-access-from-files",
                        f"--print-to-pdf={pdf_path}", "file:///" + tmp.name.replace("\\", "/")],
                       check=True, capture_output=True, timeout=120)
    finally:
        os.unlink(tmp.name)
    return pdf_path


if __name__ == "__main__":
    for path in sys.argv[1:]:
        print(convert(path))
