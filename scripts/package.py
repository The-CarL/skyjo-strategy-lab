"""Package the single-file coach and printable rules. Verify release HTML against source."""
import argparse
from pathlib import Path
from shutil import copyfile
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

parser = argparse.ArgumentParser()
parser.add_argument("--verify", action="store_true")
args = parser.parse_args()
release = Path("downloads/skyjo-family-kit.zip")
files = ["skyjo-coach.html", "skyjo-strategy-card.pdf", "skyjo-comparison-card.pdf", "skyjo-table-test.html"]
def source(name):
    return (release.parent if name == "skyjo-table-test.html" else Path("dist")) / name
if args.verify:
    with ZipFile(release) as z:
        assert z.namelist() == files
        assert z.read(files[0]) == (Path("dist") / files[0]).read_bytes()
        for name in files[1:]:
            assert z.read(name) == (release.parent / name).read_bytes()
        assert z.testzip() is None
    print("Download matches rebuilt HTML and printable PDF.")
else:
    release.parent.mkdir(exist_ok=True)
    with ZipFile(release, "w") as z:
        for name in files:
            entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.external_attr = 0o644 << 16
            z.writestr(entry, source(name).read_bytes(), compress_type=ZIP_DEFLATED)
    for name in files:
        if name.endswith(".pdf"):
            copyfile(source(name), release.parent / name)
