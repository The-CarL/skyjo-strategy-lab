/** Reader-facing metadata shared by the online table and the physical coach. */
export interface StrategyDetails {
  name: string
  description: string
  family:
    | 'Family rules'
    | 'Board and table evaluators'
    | 'Learned models'
    | 'All-moves evaluators'
  uses: string
  decision: string
  example: string
  coachMode: string | null
  coachLabel: string | null
}

const ownCards =
  'Its own face-up cards, the locations still hidden, and the card on offer.'
const modelCards =
  'Its own board, the card on offer, and the proposed move. It scores up to four options. Each exchange must uncover a card, lower a visible value, or complete a column.'

export const strategyGuide: Readonly<Record<string, StrategyDetails>> = {
  'family-value-upgrade': {
    name: 'Clear or trade',
    description:
      'Compares the points saved by clearing a column with the points saved by an ordinary exchange.',
    family: 'Family rules',
    uses: ownCards,
    decision:
      'Usually it puts a 3 or lower on its highest visible 4 or higher, then considers a hidden spot. After drawing blind, any card can replace a visible one if it saves at least four points. It values a hidden card at five when comparing a clear with its other choice. A tie goes to the clear.',
    example:
      'A column shows two 1s and a hidden card. A 12 sits elsewhere and the discard is 1. Clearing would save an estimated seven points. Replacing the 12 saves eleven, so it takes the 1 for the 12.',
    coachMode: 'value',
    coachLabel: 'Family rule · clear or trade',
  },
  'threshold-3+clear': {
    name: 'Clear, then keep 3',
    description:
      'Takes the first available column clear, then looks for a 3 or lower to keep.',
    family: 'Family rules',
    uses: ownCards,
    decision:
      'A card that completes a column always comes first, even for a negative triple. Otherwise a 3 or lower replaces the highest visible 4 or higher, or goes into a hidden spot if there is no such card. It passes on higher discards. After a blind draw it discards an unwanted card and flips a hidden one.',
    example:
      'A column shows two 1s and a hidden card. A 12 sits elsewhere and the discard is 1. It puts the 1 into the hidden spot and clears the column. The 12 stays on its board.',
    coachMode: 'family',
    coachLabel: 'Family rule · clear, then 3',
  },
  board: {
    name: 'Board evaluator',
    description:
      'Scores immediate point savings, hidden-card reveals and the value of a pair in the same column.',
    family: 'Board and table evaluators',
    uses: ownCards,
    decision:
      'It ranks up to four moves with fixed rules. A swap gets credit for points saved, a reveal, and a pair it creates. Breaking a valuable pair costs points. The score for drawing blind rises when there is a high visible card to replace.',
    example:
      'Its last column contains a 1, a 2 and one hidden card. Offered a 3, the evaluator takes it for the hidden spot and closes the round.',
    coachMode: 'board',
    coachLabel: 'Board evaluator',
  },
  table: {
    name: 'Table evaluator',
    description:
      'Uses the visible table to decide whether revealing its last hidden card risks a doubled score.',
    family: 'Board and table evaluators',
    uses: 'The board evaluator’s inputs plus opponents’ face-up cards, their hidden-card counts and whether anyone has already closed.',
    decision:
      'It starts with the board evaluator’s shortlist. Before ending the round, it estimates everyone’s points using the deck average for hidden cards. It marks down a closing move if the lowest estimated rival score could tie or beat its own.',
    example:
      'Its last column shows 1, 2 and a hidden card. A rival’s last column shows 0, 0 and a hidden card. Offered a 3, it draws blind and keeps the round open.',
    coachMode: null,
    coachLabel: null,
  },
  counter: {
    name: 'Card counter',
    description:
      'Tracks the remaining copies of each value to price a blind draw and the chance of finding a match.',
    family: 'Board and table evaluators',
    uses: 'The table evaluator’s public information plus a count of cards still unseen across the stock and all face-down boards.',
    decision:
      'It starts with the same shortlist and closing-risk check as the table evaluator. It updates the expected value of unseen cards from the count. A positive pair earns more credit when more copies of its value are still unseen.',
    example:
      'If several 9s have already appeared, fewer remain available to finish a pair of 9s. The counter can use that fact even when its own grid has stayed the same.',
    coachMode: null,
    coachLabel: null,
  },
  'match-mlp-11': {
    name: 'Match-trained neural network',
    description:
      'Ranks moves by what they contributed to winning an entire simulated match.',
    family: 'Learned models',
    uses: modelCards,
    decision:
      'The network learned from alternative moves played through to 100 points on the same sampled deals. A sole winner earned full credit and tied winners shared it. At the table the network ranks its options using that training.',
    example:
      'A 1 and a 7 are showing at the tops of the first and second columns. Every other card is hidden. With a 3 on the discard pile, this network takes it for the 7.',
    coachMode: 'match',
    coachLabel: 'Full-match neural network',
  },
  'match-tree-11': {
    name: 'Match-trained decision tree',
    description:
      'Uses a learned sequence of yes-or-no tests to rank moves by their contribution to a match win.',
    family: 'Learned models',
    uses: modelCards,
    decision:
      'This tree trained on the same full-match outcomes as the match-trained neural network. Each move follows a path of tests on its board and card features. The tree assigns a score at the end of the path and plays the highest-ranked move.',
    example:
      'Only an 8 and a 12 are showing, at the tops of the first and second columns. After drawing a 4 blind, this tree replaces the 8. The round-trained tree facing the same choice replaces the 12.',
    coachMode: null,
    coachLabel: null,
  },
  'matched-round-mlp-11': {
    name: 'Matched-round neural network',
    description:
      'Uses the same simulated decisions as the match-trained network and learns from the score at the end of the current round.',
    family: 'Learned models',
    uses: modelCards,
    decision:
      'Training reused the same hidden deals, follow-up players and starting positions as the match-trained network. Each move earned a score based on its lead in total points over the best rival after the round, with an extra win or loss reward if the match ended there.',
    example:
      'Only a 1 and a 7 are showing, at the tops of the first and second columns. Offered a 3, this network draws blind. The match-trained network takes the 3 for its 7.',
    coachMode: null,
    coachLabel: null,
  },
  mlp: {
    name: 'Original round neural network',
    description:
      'Learns from the first study’s simulated round endings, with an extra reward for a match-ending win.',
    family: 'Learned models',
    uses: modelCards,
    decision:
      'In the original training games, a fixed keep-5 rule played out the rest of each sampled round. The network learned which moves tended to improve its lead in total points over the best rival. At play time it combines board features such as hidden cards, pairs and points saved.',
    example:
      'Only an 8 and a 12 are showing, at the tops of the first and second columns. After drawing a 4 blind, this network puts it into the hidden spot directly below the 8.',
    coachMode: 'mlp',
    coachLabel: 'Round-trained neural network',
  },
  tree: {
    name: 'Round-trained decision tree',
    description:
      'Uses a short sequence of learned tests to rank moves by their simulated round-end value.',
    family: 'Learned models',
    uses: modelCards,
    decision:
      'It learned from the same first-study round simulations as the original round neural network. A move follows a path of up to six yes-or-no tests to a score. Training rewarded a lead over the best rival and gave a win or loss adjustment when the round ended the match.',
    example:
      'Only an 8 and a 12 are showing, at the tops of the first and second columns. After drawing a 4 blind, this tree keeps the 4 and replaces the 12, saving eight visible points.',
    coachMode: 'tree',
    coachLabel: 'Round-trained decision tree',
  },
  'expanded-board': {
    name: 'All-moves board evaluator',
    description:
      'Scores every legal move, including a trade that raises the visible total to build a pair.',
    family: 'All-moves evaluators',
    uses: 'Its own board, the available card and the standard deck’s starting frequencies.',
    decision:
      'Every legal draw, exchange or flip in the current phase gets a score. The weights for savings, pairs and reveals were tuned in simulated full matches. A flip beside a visible pair can earn extra credit for its chance of making a triple.',
    example:
      'A 7 sits above a 6 in one column. The only other face-up card is a 2. Offered a 7, it takes it for the 6. The one-point increase buys a pair of 7s.',
    coachMode: null,
    coachLabel: null,
  },
  'expanded-table': {
    name: 'All-moves table evaluator',
    description:
      'Scores every legal move and adjusts for opponents’ remaining cards, closing risk and the match score.',
    family: 'All-moves evaluators',
    uses: 'Its own board and available card, public rival boards, hidden-card counts, and everyone’s running score.',
    decision:
      'It keeps the all-moves board weights and adds three table signals. A rival with at most one hidden card adds urgency to reveals. On a possible close it estimates the risk of doubling its score. Once anyone has 70 points, its projected match lead also affects that choice.',
    example:
      'Its last column shows 0, 1 and a hidden card. A rival’s last column shows 0, 0 and a hidden card. With a 1 on the discard pile and match totals of 30 and 27, it takes the 1 into the hidden spot and closes.',
    coachMode: null,
    coachLabel: null,
  },
}
