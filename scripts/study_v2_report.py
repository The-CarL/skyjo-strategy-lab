"""Summarize the frozen league from paired shuffle blocks, or re-render its published blocks."""
import argparse
import gzip
import io
import json
import math
import subprocess
from pathlib import Path
from statistics import fmean, variance
from tempfile import NamedTemporaryFile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "reports" / "phase2"
CACHE = ROOT / "work" / "phase2-study"
PRIMARY = "match-mlp-11"
FAMILY = "family-nominee"
BASE = "threshold-3+clear"
MODEL_COMPARATORS = [BASE, "guarded-prior", "mlp"]
COMPARISONS = [
    (FAMILY, BASE), *((PRIMARY, a) for a in [*MODEL_COMPARATORS, "board", "matched-round-mlp-11"]),
    ("match-mlp-29", BASE), ("match-mlp-47", BASE), ("match-tree-11", BASE),
    ("match-tree-11", "mlp"), ("mlp", "guarded-prior"),
]


def read(path):
    return json.loads(path.read_text())


def encode(value):
    return (json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode()


def serialize(value):
    return json.dumps(value, indent=2, allow_nan=False) + "\n"


def interval(strata):
    """Equal-weight fixed strata. One datum is one mean across a single shuffle's seat rotations."""
    k = len(strata)
    estimate = fmean(fmean(group) for group in strata)
    v = sum(variance(group) / len(group) for group in strata) / k**2
    margin = 1.96 * math.sqrt(v)
    return {"mean": estimate, "ci95": [estimate - margin, estimate + margin]}


def gate(primary, confirmation):
    return all(cell["mean"] >= 0.02 and cell["ci95"][0] > 0.0 for cell in (primary, confirmation))


def gather(protocol):
    subprocess.run(["node", "scripts/study-v2-check-cache.mjs"], check=True, cwd=ROOT)
    raw = {"schema": 1, "dimensions": ["win credit per seat", "mean final score per seat"], "cohorts": {}}
    for cohort, spec in protocol["cohorts"].items():
        group = raw["cohorts"][cohort] = {}
        for i, (stratum, pool) in enumerate(protocol["pools"][spec["pools"]].items()):
            first = spec["baseSeed"] + i * spec["stride"]
            cell = group[stratum] = {"start": first, "seats": spec["seats"], "pool": pool, "arms": {}}
            for arm in protocol["arms"]:
                path = CACHE / cohort / stratum / (arm + ".json.gz")
                data = json.loads(gzip.decompress(path.read_bytes()))
                expected = {"cohort": cohort, "stratum": stratum, "arm": arm, "n": spec["perStratum"],
                            "start": first, "seats": spec["seats"], "pool": pool}
                if data["job"] != expected or len(data["blocks"]) != spec["perStratum"]:
                    raise ValueError(f"Cached job differs from protocol: {path}")
                if any(not 0 <= w <= 1 or not math.isfinite(p) for w, p in data["blocks"]):
                    raise ValueError(f"Invalid block: {path}")
                cell["arms"][arm] = {k: data[k] for k in ("policy", "fingerprint", "decisions", "blocks")}
    return raw


def analyze(raw, protocol):
    cohorts = {}
    games = 0
    decisions = 0
    for cohort, strata in raw["cohorts"].items():
        spec = protocol["cohorts"][cohort]
        result = cohorts[cohort] = {"seats": spec["seats"], "strata": {},
                "gamesPerArm": spec["seats"] * len(strata) * spec["perStratum"]}
        games += result["gamesPerArm"] * len(protocol["arms"])
        summary = result["summary"] = {}
        differences = result["differences"] = {}
        for arm in protocol["arms"]:
            cells = [s["arms"][arm] for s in strata.values()]
            decisions += sum(c["decisions"] for c in cells)
            summary[arm] = {
                "winShare": interval([[r[0] for r in c["blocks"]] for c in cells]),
                "finalScore": interval([[r[1] for r in c["blocks"]] for c in cells]),
            }
        for name, table in strata.items():
            result["strata"][name] = {
                "winShare": {a: interval([[b[0] for b in c["blocks"]]]) for a,c in table["arms"].items()},
                "differences": {},
            }
        for first, second in COMPARISONS:
            groups = []
            key = f"{first} minus {second}"
            for name, table in strata.items():
                v = [a[0] - b[0] for a,b in zip(table["arms"][first]["blocks"], table["arms"][second]["blocks"], strict=True)]
                result["strata"][name]["differences"][key] = interval([v])
                groups.append(v)
            differences[key] = interval(groups)
    def passes(first, second):
        key = f"{first} minus {second}"
        return gate(cohorts["primary"]["differences"][key], cohorts["confirmation"]["differences"][key])
    gates = {"family": {"passes": passes(FAMILY, BASE), "comparator": BASE},
             "model": {"byComparator": {b: passes(PRIMARY,b) for b in MODEL_COMPARATORS}}}
    gates["model"]["passes"] = all(gates["model"]["byComparator"].values())
    return {"version": 1, "games": games, "decisions": decisions, "cohorts": cohorts, "gates": gates}


def pp(x):
    return f"{100*x:+.2f}"


def change(c):
    lo, hi = c["ci95"]
    return f"{pp(c['mean'])} [{pp(lo)}, {pp(hi)}]"


def study_text(results, protocol, nominee):
    c = results["cohorts"]
    gate_f = results["gates"]["family"]["passes"]
    gate_m = results["gates"]["model"]["passes"]
    sections = [f"""# Phase-two policy league

This preregistered comparison ran **{results['games']:,} complete matches**. Each row of the four-seat study faced the same opponent tables. Primary estimates average 3,072 independent deal clusters. The independent confirmation uses 1,536 additional clusters and a different fixed opponent mix. In each cluster the focal policy plays all four seats. Separate two- and six-seat cohorts each use 384 clusters. Win credit is fractional for tied matches.

The nominated paper policy was **{nominee}**. Its promotion decision is **{'pass' if gate_f else 'hold'}**. The seed-11 full-match neural policy's promotion decision is **{'pass' if gate_m else 'hold'}**. Promotion requires at least a 2 percentage point improvement with a positive paired 95% lower bound in each of both four-seat experiments. The paper policy competes against the original family rule; the primary model must pass against every prespecified comparator.

## Win shares

| Focal policy | Four seats, primary | Four seats, confirmation | Two seats | Six seats |
|---|---:|---:|---:|---:|"""]
    for arm in protocol["arms"]:
        cells = [f"{100*c[k]['summary'][arm]['winShare']['mean']:.2f}%" for k in ("primary","confirmation","duel","six")]
        sections.append("| " + " | ".join([nominee if arm == FAMILY else arm, *cells]) + " |")
    sections.append("""
## Paired differences

Entries are percentage points with two-sided 95% seed-cluster intervals. A gain within a single stratum or a single cohort does not satisfy the promotion criterion.

| Difference | Four seats, primary | Four seats, confirmation | Two seats | Six seats |
|---|---:|---:|---:|---:|""")
    for a, b in COMPARISONS:
        key = f"{a} minus {b}"
        vals = [change(c[k]["differences"][key]) for k in ("primary","confirmation","duel","six")]
        sections.append("| " + " | ".join([key.replace(FAMILY, nominee), *vals]) + " |")
    sections.append("""
The seed-11 neural model is the primary fit frozen in advance. Seeds 29 and 47 show sensitivity to model fitting. The matched-round model shares training observations, candidate moves, sampled worlds, simulated continuation policies and fit seed with the full-match model. Its training target uses end-of-round advantage. Their paired comparison tests changing the target in this fixed training design.

## Opponent mix

Each stratum has a quarter of its cohort's weight. The diagnostic differences below compare the family nominee and primary neural model with the published family rule. Exact opponent lists and behavioral definitions appear in the [frozen protocol](protocol.json). The [summary file](league-summary.json) includes each arm's stratum win shares, all paired differences, and mean final scores.

| Cohort | Opponent stratum | Nominee minus original family | Neural minus original family |
|---|---|---:|---:|""")
    for cohort in protocol["cohorts"]:
        for name, r in c[cohort]["strata"].items():
            f = change(r["differences"][f"{FAMILY} minus {BASE}"])
            m = change(r["differences"][f"{PRIMARY} minus {BASE}"])
            sections.append(f"| {cohort} | {name} | {f} | {m} |")
    sections.append("""
The five evaluator-only opponent styles test fast reveals, pair chasing, accepting large score reductions, denying a neighbor a visible triple, and cautious finishing. Every opponent is simulated. Intervals quantify variation between shuffled deals in these specific populations. They do not establish the prevalence of any style at a human table. The two sensitivity fits do not give tight estimates of variation across training runs.

Reproduce with Node 24 and Python 3.12 from the repository root:

```sh
node scripts/study-v2.mjs --workers 2
python3 scripts/study_v2_report.py
```

For a fast independent statistical check, run `python3 scripts/study_v2_report.py --from-published`. The [compressed evidence](league-blocks.json.gz) contains paired values for every shuffle block, effective policy names, source fingerprints, decision counts and the full opponent composition. Within each stratum the block index plus its recorded starting seed recovers the exact deal seed.
""")
    return "\n".join(sections).rstrip() + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-published",action="store_true")
    args = parser.parse_args()
    protocol = read(OUT / "protocol.json")
    name = read(OUT / "nomination.json")["policy"]
    evidence = OUT / "league-blocks.json.gz"
    if args.from_published:
        raw = json.loads(gzip.decompress(evidence.read_bytes()))
    else:
        raw = gather(protocol)
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf,mode="wb",filename="",mtime=0) as f:
            f.write(encode(raw))
        with NamedTemporaryFile(dir=OUT,delete=False) as tmp:
            tmp.write(buf.getvalue())
        Path(tmp.name).replace(evidence)
    result = analyze(raw,protocol)
    summary = OUT / "league-summary.json"
    rendered = OUT / "league.md"
    if args.from_published:
        if serialize(result) != summary.read_text() or study_text(result,protocol,name) != rendered.read_text():
            raise SystemExit("Published statistics differ from block evidence")
    else:
        summary.write_text(serialize(result))
        rendered.write_text(study_text(result,protocol,name))
    print(f"{result['games']:,} matches, {result['decisions']:,} policy decisions; family gate {result['gates']['family']['passes']}, model gate {result['gates']['model']['passes']}")


if __name__ == "__main__":
    main()
