import { readFileSync, writeFileSync } from 'node:fs'

const root = 'reports/phase2/expanded'
const read = (suffix) => JSON.parse(readFileSync(root + suffix + '.json'))
const fitted = read('-training'),
  benchmark = read(''),
  portable = read('-portable')
const fmt = (x) => (x * 100).toFixed(1)
const delta = (c) =>
  fmt(c.mean) + ' [' + fmt(c.ci95[0]) + ', ' + fmt(c.ci95[1]) + ']'
const lines = [
  '# Expanded-action models',
  '',
  'A CPU-only search fitted six own-board action weights directly to split win credit in complete games to 100. The scorer evaluates every legal move, including visible uphill exchanges that build pairs and alternatives to a negative clear. One untrained control uses the same scoring formula with the initial weights. The deployed board evaluator and family rule supply additional controls.',
  '',
  'Four generations evaluated 14 weight vectors apiece. Each generation used 48 matched deals in all four seats. Its four highest-scoring vectors set the next sampling distribution. The best vector per generation, the initial vector, and the final center advanced to another 200 deals for selection. Training mixed two four-player opponent populations at equal weight. The three public-context coefficients were then fitted with the board weights frozen: risk of doubling on closure, near-closure reveal urgency, and pace when a player approaches 100. These training and validation stages used ' +
    fitted.totalGames.toLocaleString('en-US') +
    ' full matches combined. No neural-network training data or cloud service was needed for these fits.',
  '',
  'The urgency-only variant receives a single extra signal: at least one other player has at most one hidden card. It shares the fitted table model’s urgency coefficient. The full-table model additionally consumes public opponent board estimates and match standings. None of these policies reads hidden cards or the order of the deck.',
  '',
  '## Effect of tuning and public information',
  '',
  'Values are paired percentage-point differences in win share with nominal 95% intervals. Each independent shuffle seed contributes the mean of its seat rotations. Primary deals use a training-style opponent mix; the other panels use distinct profiles that include existing learned models.',
  '',
  '| Panel | Fitted board minus raw board | Fitted board minus existing board | Fitted board minus family | Table minus fitted board | Urgency-only minus fitted board |',
  '|---|---:|---:|---:|---:|---:|',
]
for (const p of benchmark.panels) {
  const row = (a, b) => delta(p.contrasts.find((c) => c.a === a && c.b === b))
  lines.push(
    '| ' +
      p.label +
      ' | ' +
      [
        row('expanded-board', 'raw-board'),
        row('expanded-board', 'board'),
        row('expanded-board', 'family'),
        row('expanded-table', 'expanded-board'),
        row('expanded-urgency', 'expanded-board'),
      ].join(' | ') +
      ' |',
  )
}
lines.push(
  '',
  '## Independent portable-coach gate',
  '',
  'Each four-player deal used all seat rotations. Within both the primary and confirmation panels, two lineups contributed equal numbers of deals. A portable contender had to exceed every registered control by at least two percentage points and have a positive lower interval bound on each panel. The urgency contender also had to clear that bar against the same fitted board without the extra input.',
  '',
  '| Panel | Fixed opponent mixtures | Expanded board win share | Family | Family nominee | Board evaluator | Original neural net | Full-match neural net | Urgency minus fitted board (pp) |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
)
for (const p of portable.panels) {
  const win = (n) => fmt(p.results[n].mean) + '%'
  lines.push(
    '| ' +
      p.label +
      ' | ' +
      p.blocks +
      ' deals | ' +
      [
        'expanded-board',
        'family',
        'family-nominee',
        'board',
        'mlp',
        'match-mlp-11',
      ]
        .map(win)
        .join(' | ') +
      ' | ' +
      delta(
        p.gates['expanded-urgency'].comparisons.find(
          (c) => c.b === 'expanded-board',
        ),
      ) +
      ' |',
  )
}
lines.push(
  '',
  'Passing portable variants: ' +
    (portable.passing.length ? portable.passing.join(', ') : 'none') +
    '. The machine-readable report includes each required paired contrast and the criterion applied.',
  '',
  '## Effect of opening the shortlist',
  '',
  'Here each fitted scorer uses identical weights and legal-order tie breaking. Only the pool it ranks changes: all legal actions versus the original hand-picked shortlist of at most four. The comparison measures the inference-time restriction for these fitted weights. Training a model from scratch under the restricted action space would be a different experiment.',
  '',
  '| Panel | All-action board minus shortlisted board (pp) | All-action table minus shortlisted table (pp) |',
  '|---|---:|---:|',
)
for (const p of portable.panels)
  lines.push('| ' + p.label + ' | ' + p.shortlist.map(delta).join(' | ') + ' |')
lines.push(
  '',
  '[Training history](expanded-training.json) · [Research panels](expanded.json) · [Frozen portable protocol](expanded-portable-protocol.json) · [Portable contrasts and deal blocks](expanded-portable.json) · [Released weights](../../models/expanded.json)',
  '',
  'Reproduce from the repository root:',
  '',
  '```sh',
  'node scripts/expanded-study.mjs',
  'node scripts/expanded-portable.mjs',
  'node scripts/expanded-report.mjs',
  '```',
  '',
)
writeFileSync(root + '.md', lines.join('\n'))
