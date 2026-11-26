"""Package the single-file coach and printable rules. Verify release HTML against source."""
import argparse
from pathlib import Path
from shutil import copyfile
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

parser = argparse.ArgumentParser()
parser.add_argument("--verify", action="store_true")
args = parser.parse_args()
release = Path("downloads/skyjo-family-kit.zip")
files = ["skyjo-coach.html", "skyjo-strategy-card.pdf"]
if args.verify:
    with ZipFile(release) as z:
        assert z.namelist() == files
        assert z.read(files[0]) == (Path("dist") / files[0]).read_bytes()
        assert z.read(files[1]) == (release.parent / files[1]).read_bytes()
        assert z.testzip() is None
    print("Download matches rebuilt HTML and printable PDF.")
else:
    release.parent.mkdir(exist_ok=True)
    with ZipFile(release, "w") as z:
        for name in files:
            entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.external_attr = 0o644 << 16
            z.writestr(entry, (Path("dist") / name).read_bytes(), compress_type=ZIP_DEFLATED)
    copyfile(Path("dist") / files[1], release.parent / files[1])
