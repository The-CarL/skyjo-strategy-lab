"""Write a reproducible AWS Lambda zip from the hosted game's build."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1] / "online-dist"
with ZipFile(root / "skyjo-online.zip", "w") as package:
    for name in ("index.mjs", "public/index.html", "public/app.js", "public/style.css"):
        entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        entry.external_attr = 0o100644 << 16
        package.writestr(entry, (root / "lambda" / name).read_bytes(), compress_type=ZIP_DEFLATED)
print(root / "skyjo-online.zip")
