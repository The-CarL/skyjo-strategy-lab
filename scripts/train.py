"""Fit CPU-only action-value regressors to simulated public-information rollouts."""
import argparse
import json
from pathlib import Path
import warnings

import numpy as np
import sklearn
from sklearn.exceptions import ConvergenceWarning
from sklearn.metrics import mean_absolute_error
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeRegressor

parser = argparse.ArgumentParser()
parser.add_argument("--data", default="work/training.jsonl")
parser.add_argument("--out", default="models/policies.json")
parser.add_argument("--report", default="reports/training.json")
args = parser.parse_args()
with open(args.data) as f:
    header = json.loads(next(f))
    states = [json.loads(line) for line in f]

def arrays(group):
    return np.vstack([v["x"] for v in group]), np.concatenate([v["y"] for v in group])

train = [v for v in states if v["seed"] % 5]
valid = [v for v in states if not v["seed"] % 5]
x, y = arrays(train)
vx, vy = arrays(valid)
tree = DecisionTreeRegressor(max_depth=6, min_samples_leaf=30, random_state=42).fit(x, y)
net = make_pipeline(StandardScaler(), MLPRegressor(hidden_layer_sizes=(24, 12), max_iter=150,
                    learning_rate_init=0.002, random_state=42, tol=0.001))
with warnings.catch_warnings(record=True) as notes:
    warnings.simplefilter("always", ConvergenceWarning)
    net.fit(x, y)
scaler, mlp = net.steps[0][1], net.steps[1][1]
t = tree.tree_
bundle = {"version": 1, "features": header["features"], "tree": {"type": "tree",
          "childrenLeft": t.children_left.tolist(), "childrenRight": t.children_right.tolist(),
          "feature": t.feature.tolist(), "threshold": t.threshold.tolist(), "value": t.value[:, 0, 0].tolist()},
          "mlp": {"type": "mlp", "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
                  "weights": [w.tolist() for w in mlp.coefs_], "biases": [b.tolist() for b in mlp.intercepts_]}}
report = {"generator": header, "sklearn": sklearn.__version__, "trainGames": len({v["seed"] for v in train}),
          "validationGames": len({v["seed"] for v in valid}), "trainStates": len(train),
          "validationStates": len(valid), "actionRows": len(y), "mlpIterations": mlp.n_iter_,
          "mlpWarnings": [str(n.message) for n in notes], "validation": {}, "parity": []}
for name, model in [("tree", tree), ("mlp", net)]:
    predictions = model.predict(vx)
    offset, optimal, regret = 0, [], []
    for v in valid:
        ys = v["y"]
        eligible = [i for i, f in enumerate(v["x"]) if f[0] or f[1] or f[4] or f[2] < f[3] or f[8] == 2]
        choice = max(eligible, key=lambda i: predictions[offset + i])
        regret.append(max(ys) - ys[choice])
        optimal.append(regret[-1] < 1e-8)
        offset += len(ys)
    report["validation"][name] = {"mae": mean_absolute_error(vy, predictions),
        "teacherBestFraction": float(np.mean(optimal)), "meanTeacherRegret": float(np.mean(regret))}
for row in vx[:12]:
    report["parity"].append({"x": row.tolist(), "tree": tree.predict([row])[0], "mlp": net.predict([row])[0]})
for path, data in [(args.out, bundle), (args.report, report)]:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(p)
print(json.dumps(report["validation"], indent=2))
