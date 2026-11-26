"""Render the published tournament summary from the retained seat-balanced results."""
import json
import math
from pathlib import Path
from statistics import mean, stdev

root = Path("reports")
def load(name):
    return json.loads((root / (name + ".json")).read_text())
def pct(value):
    return f"{100*value:.1f}"
def diff(report, first, second):
    names = report["config"]["agents"]
    i, j = names.index(first), names.index(second)
    xs = [b["values"][i]["win"] - b["values"][j]["win"] for b in report["blocks"]]
    d = mean(xs)
    rad = 1.96 * stdev(xs) / math.sqrt(len(xs))
    return f"{pct(d)} pp (95% interval {100*(d-rad):.2f} to {100*(d+rad):.2f} pp)"
res = load("final")
total = sum(json.loads(p.read_text()).get("totalGames", 0) for p in root.glob("*.json"))
text = [f"""# Strategy results

The retained experiment suite contains **{total:,} complete games**, including the cutoff selection run and the head-to-head battery. The final four-player experiment contributes {res['totalGames']:,} games. A win shared by two players counts as half a win each.

## A rule for the table

Take an available vertical clear. Otherwise take a 3 or lower to replace your highest visible 4 or higher, or put it in a hidden slot if you have no such card. Pass on a higher discard and draw. After a blind draw, apply the same rule; if you pass, flip a hidden card.

On the final deals, the paired improvement over the original keep-5 rule was **{diff(res,'threshold-3+clear','threshold-5')}**. Adding only the clear exception to the original rule yielded {diff(res,'threshold-5+clear','threshold-5')}. The family rule minus the neural policy was {diff(res,'threshold-3+clear','mlp')}. The card counter minus the otherwise equivalent table evaluator was {diff(res,'counter','table')}.

## Frozen four-player comparison

Each row plays against the same three opponents: a keep-3 player that clears and protects pairs, a keep-4 player that clears, and a keep-6 player. Every agent plays every seat for each of {res['config']['count']} untouched shuffle seeds. Different rows can all exceed 25% because each faces its own copy of that table.

| Focal policy | Game win share | Approx. 95% interval | Mean final points |
|---|---:|---:|---:|"""]
for row in res["results"]:
    w = row["winShare"]
    text.append(f"| {row['name']} | {pct(w['mean'])}% | {pct(w['ci95'][0])}–{pct(w['ci95'][1])}% | {row['finalScore']['mean']:.1f} |")
text.append("""
Intervals use independent shuffle seeds as clusters. The four seat rotations for each seed stay together. Paired differences reuse those same clusters. Intervals describe simulated deals under the specified lineups. Human opponents can behave differently.

## Head-to-head games

Each cell gives the row player's percentage of wins against the column player across 60 deals, with both seat orders per deal. These 28 matchups include the two recorded model-loop regression seeds. Use the frozen four-player experiment for an independent test of the final learned policies.

""")
duels = load("duels")["duels"]
names = list(dict.fromkeys([duels[0]["first"]] + [d["second"] for d in duels]))
cells = {}
for d in duels:
    a,b = d["first"],d["second"]
    cells[a,b] = d["firstWinShare"]
    cells[b,a] = 1-d["firstWinShare"]
text.extend(["| Row vs column | " + " | ".join(names) + " |", "|---|" + "---:|"*len(names)])
for a in names:
    text.append("| "+a+" | "+" | ".join("—" if a==b else pct(cells[a,b]) for b in names)+" |")
text.append("""
## Other tables and follow-up questions

| Experiment | Games | Purpose |
|---|---:|---|""")
for file,why in [("selection","Choose a family cutoff using its own seeds"),("cutoffs","Compare keep-4, 5, 6, and 7"),("four-player","Four seats against the original hand-written pool"),("two-player","Two seats with rotating opponents"),("six-player","Six seats with a different opponent mix"),("learned-opponents","Mixed table including learned policies"),("lookahead","Four-sample search pilot"),("confirmation","New family-rule deals also inspected while developing the model safeguards"),("final","Fresh deals with all models and safeguards frozen"),("duels","All pairs in both seat orders")]:
    text.append(f"| [{file}]({file}.json) | {load(file)['totalGames']:,} | {why} |")
text.append("""
The rollout pilot is small and its continuation policy plays only to the end of the current round. The full-game tournaments expose errors in that approximation. Larger search budgets, other opponent populations, opening layouts, and human game logs are natural follow-up experiments. Reserve new seeds before optimizing again.

## Training

Both models rank up to four legal candidate actions using 18 board-only features. The teacher samples eight hidden worlds consistent with a card counter's observations, compares the candidates to round end, and scores each by its margin against the leading rival, with a match-end bonus. Each target is centered within the decision. The student receives only its own visible board and the available card. A progress rule admits visible exchanges that lower the value or complete a column. It prevents the learned policies from spending a duel trading the same cards.

The 360 source games supplied 8,640 decisions. Whole games were split 80/20 before fitting. The decision tree has depth at most six. The neural net has two ReLU hidden layers of 24 and 12 units. Its 150-epoch training budget expired before the optimizer signaled convergence. The final evaluation measures the exported weights and the deployed action rule together. Per-model teacher agreement, prediction errors, and cross-language parity fixtures appear in [training.json](training.json).
""")
(root/"README.md").write_text("\n".join(text).rstrip()+"\n")
