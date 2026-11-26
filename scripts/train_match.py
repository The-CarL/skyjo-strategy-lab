"""Fit board-only predictors of relative match win share from public counterfactuals."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import time
import warnings

import numpy as np
import sklearn
from sklearn.exceptions import ConvergenceWarning
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeRegressor
from threadpoolctl import threadpool_limits


SEEDS = (11, 29, 47)
PRIMARY = SEEDS[0]
FEATURES = (
    "draw", "flip", "incoming", "target", "hiddenTarget", "hiddenLeft",
    "ownEstimate", "highest", "columnMatches", "pairBroken", "clearValue",
    "gain", "revealsLast", "mateUnknown", "mateSum", "pairValue",
    "bestVisibleGain", "boardSize",
)
EPSILON = 1e-10


def read_dataset(path):
    digest = sha256()
    states = []
    with path.open("rb") as stream:
        header_bytes = stream.readline()
        digest.update(header_bytes)
        header = json.loads(header_bytes)
        if header["features"] != list(FEATURES):
            raise ValueError("Dataset feature schema differs from the coach model schema.")
        for number, raw in enumerate(stream, start=2):
            digest.update(raw)
            row = json.loads(raw)
            x = np.asarray(row["x"], dtype=float)
            y = np.asarray(row["y"], dtype=float)
            if (x.ndim != 2 or x.shape[1] != len(FEATURES)
                    or not 1 <= len(x) <= 4 or y.shape != (len(x),)
                    or not np.all(np.isfinite(x)) or not np.all(np.isfinite(y))
                    or np.max(np.abs(y)) > 1 + EPSILON or abs(y.mean()) > EPSILON):
                raise ValueError(f"Invalid candidate or non-centered win-share target on line {number}.")
            eligible = ((x[:, 0] != 0) | (x[:, 1] != 0) | (x[:, 4] != 0)
                        | (x[:, 2] < x[:, 3]) | (x[:, 8] == 2))
            if not np.all(eligible):
                raise ValueError(f"Dataset contains an action excluded by the progress rule on line {number}.")
            round_y = np.asarray(row["yRound"], dtype=float)
            if (round_y.shape != y.shape or not np.all(np.isfinite(round_y))
                    or abs(round_y.mean()) > EPSILON):
                raise ValueError(f"Invalid matched round targets on line {number}.")
            states.append((row["seed"], x, y, round_y))
    return header, states, digest.hexdigest()


def arrays(states):
    x = np.vstack([row[1] for row in states])
    y = np.concatenate([row[2] for row in states])
    return x, y


def evaluate(states, predictions=None):
    """Score the prior-order first move or the predicted best move against sampled credit."""
    regrets, correct, informative = [], [], []
    offset = 0
    for _, _, targets in states:
        if predictions is None:
            choice = 0  # The generator preserves the hand-ranked shortlist order.
        else:
            choice = np.argmax(predictions[offset:offset + len(targets)])
        regret = max(0.0, float(np.max(targets) - targets[choice]))
        regrets.append(regret)
        correct.append(regret < EPSILON)
        informative.append(float(np.ptp(targets)) > EPSILON)
        offset += len(targets)
    mask = np.asarray(informative, dtype=bool)
    return {
        "teacherBestFraction": float(np.mean(correct)),
        "meanTeacherRegret": float(np.mean(regrets)),
        "decisionsWithUnequalTargets": int(np.sum(mask)),
        "teacherBestFractionOnUnequalTargets": (
            float(np.mean(np.asarray(correct)[mask])) if np.any(mask) else None
        ),
    }


def fit_replica(seed, train_x, train_y, valid_x, valid_y, validation, scaler, target_scaler):
    tree = DecisionTreeRegressor(max_depth=6, min_samples_leaf=30, random_state=seed)
    tree.fit(train_x, train_y)
    mlp = MLPRegressor(
        hidden_layer_sizes=(24, 12), activation="relu", solver="adam",
        learning_rate_init=0.002, max_iter=150, tol=0.001, random_state=seed,
    )
    with warnings.catch_warnings(record=True) as notices:
        warnings.simplefilter("always", ConvergenceWarning)
        mlp.fit(scaler.transform(train_x), target_scaler.transform(train_y[:, None]).ravel())

    # Fold the outcome normalization into the affine output layer so existing
    # TypeScript inference returns advantage in win-share units without a new schema.
    weights = [w.copy() for w in mlp.coefs_]
    biases = [b.copy() for b in mlp.intercepts_]
    weights[-1] *= target_scaler.scale_[0]
    biases[-1] = biases[-1] * target_scaler.scale_[0] + target_scaler.mean_[0]
    t = tree.tree_
    bundle = {
        "version": 1, "features": list(FEATURES),
        "tree": {
            "type": "tree", "childrenLeft": t.children_left.tolist(),
            "childrenRight": t.children_right.tolist(), "feature": t.feature.tolist(),
            "threshold": t.threshold.tolist(), "value": t.value[:, 0, 0].tolist(),
        },
        "mlp": {
            "type": "mlp", "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
            "weights": [w.tolist() for w in weights], "biases": [b.tolist() for b in biases],
        },
    }

    predictions = {
        "tree": tree.predict(valid_x),
        "mlp": target_scaler.inverse_transform(
            mlp.predict(scaler.transform(valid_x))[:, None]
        ).ravel(),
    }
    metrics = {}
    for name, preds in predictions.items():
        metrics[name] = evaluate(validation, preds)
        metrics[name]["mae"] = float(np.mean(np.abs(preds - valid_y)))
    fixtures = []
    for i in np.unique(np.linspace(0, len(valid_x) - 1, min(len(valid_x), 16), dtype=int)):
        fixtures.append({"x": valid_x[i].tolist(), **{k: float(v[i]) for k, v in predictions.items()}})
    details = {
        "seed": seed, "validation": metrics, "treeNodes": int(t.node_count),
        "treeLeaves": int(tree.get_n_leaves()), "mlpIterations": mlp.n_iter_,
        "mlpWarnings": [str(n.message) for n in notices], "parity": fixtures,
    }
    return bundle, details


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("work/match-training.jsonl"))
    parser.add_argument("--out-dir", type=Path, default=Path("models"))
    parser.add_argument("--report", type=Path, default=Path("reports/match-training.json"))
    args = parser.parse_args()

    header, states, dataset_sha = read_dataset(args.data)
    train = [(seed, x, y) for seed, x, y, _ in states if seed % 5]
    validation = [(seed, x, y) for seed, x, y, _ in states if not seed % 5]
    round_train = [(seed, x, y_round) for seed, x, _, y_round in states if seed % 5]
    round_validation = [(seed, x, y_round) for seed, x, _, y_round in states if not seed % 5]
    if not train or not validation:
        parser.error("Provide source game seeds in both split groups.")
    train_x, train_y = arrays(train)
    valid_x, valid_y = arrays(validation)
    scaler = StandardScaler().fit(train_x)
    target_scaler = StandardScaler().fit(train_y[:, None])
    prior = evaluate(validation)
    report = {
        "generator": header, "datasetSha256": dataset_sha,
        "sklearn": sklearn.__version__, "numpy": np.__version__,
        "split": "validation game seed % 5 == 0; other game seeds train",
        "trainGames": len({s[0] for s in train}), "validationGames": len({s[0] for s in validation}),
        "trainStates": len(train), "validationStates": len(validation),
        "trainActionRows": len(train_y), "validationActionRows": len(valid_y),
        "primarySeed": PRIMARY, "replicaSeeds": list(SEEDS),
        "neuralFit": {"hidden": [24, 12], "activation": "relu", "optimizer": "adam",
                      "learningRate": 0.002, "maxEpochs": 150, "tol": 0.001,
                      "featureScaling": "standardize on training rows",
                      "targetScaling": "standardize on training rows; invert on export",
                      "targetMean": float(target_scaler.mean_[0]),
                      "targetScale": float(target_scaler.scale_[0])},
        "treeFit": {"criterion": "squared_error", "maxDepth": 6, "minLeaf": 30},
        "guardedPriorValidation": prior, "replicas": {},
    }
    with threadpool_limits(limits=1):
        for seed in SEEDS:
            start = time.perf_counter()
            bundle, details = fit_replica(seed, train_x, train_y, valid_x, valid_y, validation,
                                         scaler, target_scaler)
            for metrics in details["validation"].values():
                metrics["regretReductionVsPrior"] = prior["meanTeacherRegret"] - metrics["meanTeacherRegret"]
            report["replicas"][str(seed)] = details
            save_json(args.out_dir / f"match-s{seed}.json", bundle)
            print(f"Seed {seed} fit and validation took {time.perf_counter() - start:.2f}s; "
                  f"epochs {details['mlpIterations']}; {json.dumps(details['validation'])}",
                  flush=True)
        # The control changes only the reward observed along the same trajectories.
        # Keep preprocessing, train/validation games, primary seed and fit budget fixed.
        start = time.perf_counter()
        round_y = np.concatenate([state[2] for state in round_train])
        round_vy = np.concatenate([state[2] for state in round_validation])
        round_target_scaler = StandardScaler().fit(round_y[:, None])
        round_bundle, round_details = fit_replica(
            PRIMARY, train_x, round_y, valid_x, round_vy, round_validation, scaler, round_target_scaler
        )
        round_prior = evaluate(round_validation)
        for metrics in round_details["validation"].values():
            metrics["regretReductionVsPrior"] = round_prior["meanTeacherRegret"] - metrics["meanTeacherRegret"]
        round_details.update({"target": "centered first-round lead from the same simulated trajectories",
                              "targetMean": float(round_target_scaler.mean_[0]),
                              "targetScale": float(round_target_scaler.scale_[0]),
                              "guardedPriorValidation": round_prior})
        report["matchedRoundControl"] = round_details
        save_json(args.out_dir / f"matched-round-s{PRIMARY}.json", round_bundle)
        print(f"Matched round control took {time.perf_counter() - start:.2f}s; "
              f"epochs {round_details['mlpIterations']}; {json.dumps(round_details['validation'])}",
              flush=True)
    save_json(args.report, report)


if __name__ == "__main__":
    main()
