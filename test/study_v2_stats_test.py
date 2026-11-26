"""Statistics smoke tests for the fixed-stratum paired evaluation."""
import importlib.util
import math
import unittest
from pathlib import Path

module_spec = importlib.util.spec_from_file_location(
    "study_v2_report", Path(__file__).resolve().parents[1] / "scripts" / "study_v2_report.py"
)
study = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(study)


class StudyStatistics(unittest.TestCase):
    def test_strata_are_equally_weighted_and_heterogeneity_is_not_seed_variance(self):
        stats = study.interval([[1] * 12, [0] * 4])
        self.assertEqual(stats, {"mean": 0.5, "ci95": [0.5, 0.5]})

    def test_paired_cluster_uncertainty_matches_two_stratum_closed_form(self):
        stats = study.interval([[0.0, 1.0, 0.0, 1.0], [-0.5, 0.5, -0.5, 0.5]])
        se = math.sqrt((1 / 3 / 4 + 1 / 3 / 4) / 4)
        self.assertAlmostEqual(stats["mean"], 0.25)
        self.assertAlmostEqual(stats["ci95"][0], 0.25 - 1.96 * se)
        self.assertAlmostEqual(stats["ci95"][1], 0.25 + 1.96 * se)

    def test_gate_requires_practical_and_statistical_effect_twice(self):
        good = {"mean": 0.025, "ci95": [0.001, 0.049]}
        self.assertTrue(study.gate(good, good))
        self.assertFalse(study.gate(good, {"mean": 0.019, "ci95": [0.01, 0.028]}))
        self.assertFalse(study.gate({"mean": 0.025, "ci95": [0.0, 0.05]}, good))


if __name__ == "__main__":
    unittest.main()
