import type {
  EngineInfo,
  MatchCommand,
  PublicMatch,
  RoundResult,
  TurnEvent,
} from '../src/online-match.ts'

type Game = PublicMatch & { id: string; createdAt: string; updatedAt: string }
type Player = Game['players'][number]
type Finished = {
  id: string
  createdAt: string
  finishedAt: string
  players: (Pick<Player, 'seat' | 'engineId' | 'name' | 'total'> & {
    place: number
  })[]
  rounds: RoundResult[]
  winners: number[]
}
type Page = 'table' | 'history' | 'detail'
type Pending = {
  path: string
  body: {
    requestId: string
    opponents?: string[]
    expectedRevision?: number
    action?: MatchCommand
  }
}
const KEY_STORE = 'skyjo-online-profile-v1'
const PENDING_STORE = 'skyjo-online-pending-v1'
const GONE = -9
const app = document.querySelector<HTMLElement>('#app')!
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!
const dialogContent = document.querySelector<HTMLElement>('#dialog-content')!
const html = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ]!,
  )
function randomKey() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
function validKey(s: string) {
  return /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(s)
}
function readStorage(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 15) | 64
  b[8] = (b[8] & 63) | 128
  const h = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('')
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ].join('-')
}
let key = readStorage(KEY_STORE) ?? ''
if (!validKey(key)) key = randomKey()
const persistent = writeStorage(KEY_STORE, key)
let selected: string[] = []
let engines: EngineInfo[] = []
let game: Game | null = null,
  detail: Game | null = null,
  page: Page = 'table'
let historyRows: Finished[] = [],
  cursor: string | null = null
let historyLoaded = false,
  loadingHistory = false,
  loading = true,
  busy = false
let notice = '',
  bootFailed = false
let pending: Pending | null = null
try {
  const saved = JSON.parse(readStorage(PENDING_STORE) ?? 'null')
  if (
    saved?.key === key &&
    typeof saved.request?.body?.requestId === 'string' &&
    typeof saved.request?.path === 'string' &&
    /^\/api\/games(?:\/[a-zA-Z0-9_-]+\/moves)?$/.test(saved.request.path)
  )
    pending = saved.request
} catch {
  /* A damaged local retry record can be ignored. */
}
let openSlots: number[] = []
let mode: 'none' | 'take' | 'swap' | 'flip' = 'none'
let historyEpoch = 0,
  tableEpoch = 0
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
async function api<T>(
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<T> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(path, {
      method: opts.body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        ...(path === '/api/engines'
          ? {}
          : { Authorization: 'Bearer ' + (opts.token ?? key) }),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
    let data
    try {
      data = await response.json()
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        'The game service returned an unreadable response.',
      )
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        data?.error?.code ?? 'request_failed',
        data?.error?.message ??
          'The game service could not complete the request.',
      )
    return data as T
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(
      0,
      'network',
      'Could not reach the game service. Check your connection and try again.',
    )
  } finally {
    clearTimeout(timer)
  }
}
function message(e: unknown) {
  return e instanceof Error
    ? e.message
    : 'The game service could not complete the request.'
}
function pendingSet(q: Pending | null) {
  pending = q
  writeStorage(PENDING_STORE, q ? JSON.stringify({ key, request: q }) : null)
}
const disabled = (v: boolean) => (v ? ' disabled' : '')
function btn(action: string, label: string, cls = 'quiet', off = false) {
  return (
    '<button class="' +
    cls +
    '" data-action="' +
    action +
    '"' +
    disabled(off) +
    '>' +
    html(label) +
    '</button>'
  )
}
function playerLabel(p: Pick<Player, 'seat' | 'name'>) {
  return p.seat === 0 ? 'You' : p.name
}
function who(g: Game, seat: number) {
  return playerLabel(g.players[seat])
}
function seatName(g: Game, seat: number) {
  return seat === 0 ? 'You' : who(g, seat) + ' · seat ' + (seat + 1)
}
function displayDate(value: string) {
  const d = new Date(value)
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(d)
    : ''
}
function heading(title: string, subtitle: string, extra = '', className = '') {
  return (
    '<div class="heading ' +
    className +
    '">' +
    (extra ? '<span class="eyebrow">' + html(extra) + '</span>' : '') +
    '<h1>' +
    html(title) +
    '<span>.</span></h1>' +
    (subtitle ? '<p>' + html(subtitle) + '</p>' : '') +
    '</div>'
  )
}
function tone(x: number) {
  return x < 0
    ? 'tone-neg'
    : x === 0
      ? 'tone-zero'
      : x <= 4
        ? 'tone-low'
        : x <= 8
          ? 'tone-mid'
          : 'tone-high'
}
function rank(x: number | null) {
  if (x === null) return '<span class="back-mark" aria-hidden="true"></span>'
  if (x === GONE) return '<span class="rank" aria-hidden="true">—</span>'
  return (
    '<span class="corner" aria-hidden="true">' +
    x +
    '</span><span class="rank">' +
    x +
    '</span>'
  )
}
function faceClass(x: number | null) {
  return x === null ? 'back' : x === GONE ? 'gone' : tone(x)
}
function cardName(x: number | null) {
  return x === null ? 'hidden' : x === GONE ? 'cleared' : String(x)
}
function boardGrid(
  b: (number | null)[],
  variant: 'human' | 'rival' | 'preview',
  g?: Game,
) {
  let cells = ''
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 4; col++) {
      const index = col * 3 + row,
        x = b[index],
        name = 'Column ' + (col + 1) + ', row ' + (row + 1) + ', ' + cardName(x)
      if (variant !== 'human') {
        cells +=
          '<span class="slot ' +
          faceClass(x) +
          '" aria-label="' +
          name +
          '">' +
          rank(x) +
          '</span>'
        continue
      }
      const opening = g!.phase === 'opening',
        selected = opening && openSlots.includes(index)
      const eligible =
        (opening && x === null && (selected || openSlots.length < 2)) ||
        (g!.phase === 'source' && mode === 'take' && x !== GONE) ||
        (g!.phase === 'held' && (mode === 'flip' ? x === null : x !== GONE))
      cells +=
        '<button class="slot ' +
        faceClass(x) +
        (selected ? ' selected' : '') +
        (eligible ? ' pickable' : '') +
        '" data-slot="' +
        index +
        '" data-testid="slot-' +
        index +
        '" aria-label="' +
        name +
        '"' +
        (opening ? ' aria-pressed="' + selected + '"' : '') +
        disabled(!eligible || busy || !!pending || page === 'detail') +
        '>' +
        rank(x) +
        '</button>'
    }
  return (
    '<div class="grid ' +
    (variant === 'rival'
      ? 'rival-grid'
      : variant === 'preview'
        ? 'preview-board'
        : '') +
    '">' +
    cells +
    '</div>'
  )
}
function setNotice() {
  const box = document.querySelector('#notice')!
  const msg =
    notice ||
    (!persistent
      ? 'Browser storage is unavailable. Copy your recovery key to keep access after closing this page.'
      : '')
  box.innerHTML = msg
    ? '<div class="notice-box">' +
      html(msg) +
      (pending && !busy
        ? btn('retry', 'Retry saved move', '')
        : bootFailed && !loading
          ? btn('reload', 'Retry connection', '')
          : '') +
      '</div>'
    : ''
}
function setup() {
  const options = (id: string) =>
    engines
      .map(
        (e) =>
          '<option value="' +
          html(e.id) +
          '"' +
          (e.id === id ? ' selected' : '') +
          '>' +
          html(e.name) +
          '</option>',
      )
      .join('')
  const opponents = selected
    .map((id, i) => {
      const engine = engines.find((e) => e.id === id)
      return (
        '<div class="opponent"><label for="op-' +
        i +
        '">Opponent ' +
        (i + 1) +
        '</label><div class="select-line"><select id="op-' +
        i +
        '" data-opponent="' +
        i +
        '"' +
        disabled(busy || loading || !!pending || !engines.length) +
        '>' +
        options(id) +
        '</select>' +
        (selected.length > 1
          ? '<button class="remove" aria-label="Remove opponent ' +
            (i + 1) +
            '" data-remove="' +
            i +
            '"' +
            disabled(busy || !!pending) +
            '>×</button>'
          : '') +
        '</div><p>' +
        html(engine?.description ?? '') +
        '</p></div>'
      )
    })
    .join('')
  return (
    heading(
      'Set your table',
      'Choose your opponents and play a full match to 100 points.',
    ) +
    '<div class="two-col setup-layout"><section class="tabletop preview" aria-label="Table preview"><div class="row-between"><h2 class="board-title">Table preview</h2><span class="board-meta">Four columns of three</span></div>' +
    boardGrid(
      [-2, null, 4, null, 7, null, 3, null, 0, 12, null, null],
      'preview',
    ) +
    '<p class="preview-note">Three matching cards in a column clear together.</p></section>' +
    '<section class="panel setup-panel"><div class="panel-head"><h2>Opponents</h2><span class="count">' +
    (selected.length + 1) +
    ' seats</span></div><div class="opponents">' +
    (opponents ||
      (loading
        ? '<p class="subtle">Loading strategy engines…</p>'
        : '<p class="subtle">Strategy engines are unavailable.</p>')) +
    '</div>' +
    btn(
      'add',
      'Add opponent',
      'add',
      selected.length >= 7 || loading || busy || !!pending || !engines.length,
    ) +
    btn(
      'start',
      busy ? 'Starting game…' : 'Start game',
      'primary wide',
      loading || busy || !!pending || !selected.length || !engines.length,
    ) +
    '<details class="match-info"><summary>How this match works</summary><p>You play against 1–7 strategy engines. Everyone starts with 12 hidden cards. The lowest total wins when someone reaches 100.</p></details></section></div>'
  )
}
function pile(
  action: string,
  value: number | null,
  label: string,
  stock: boolean,
  enabled: boolean,
  pressed = false,
) {
  return (
    '<button class="pile-control" data-action="' +
    action +
    '" aria-label="' +
    html(label) +
    '"' +
    (action === 'take' && value !== null
      ? ' aria-description="Top discard is ' + value + '."'
      : '') +
    (enabled ? ' aria-pressed="' + pressed + '"' : '') +
    disabled(!enabled || busy || !!pending) +
    '><span class="slot ' +
    (stock ? 'back stock' : faceClass(value)) +
    '">' +
    rank(stock ? null : value) +
    '</span><span class="caption">' +
    html(label) +
    '</span></button>'
  )
}
function resultTitle(g: Game) {
  if (g.winners.includes(0))
    return g.winners.length === 1 ? 'You won' : 'You tied for first'
  return g.winners.length === 1 ? who(g, g.winners[0]) + ' won' : 'Shared win'
}
function phaseCopy(g: Game) {
  if (g.phase === 'opening')
    return [
      'Choose your opening cards',
      'Select any two hidden cards, then reveal them together.',
    ]
  if (g.phase === 'source')
    return [
      'Your turn',
      mode === 'take'
        ? 'Choose a spot on your board for the top discard.'
        : 'Take the top discard or draw a card blind.',
    ]
  if (g.phase === 'held')
    return [
      'You drew ' + g.held,
      mode === 'flip'
        ? 'Choose a hidden card to flip. Your drawn card goes on the discard pile.'
        : 'Choose a card to replace, or discard your draw and flip a hidden card.',
    ]
  if (g.phase === 'roundOver')
    return [
      'Round complete',
      who(g, g.closer!) +
        ' closed the round. The scores below include every final turn.',
    ]
  return [
    resultTitle(g),
    'Final totals from ' +
      g.round +
      ' round' +
      (g.round === 1 ? '' : 's') +
      '.',
  ]
}
function recentEvent(g: Game, e: TurnEvent) {
  const actor = e.seat === 0 ? 'You' : who(g, e.seat)
  const slot =
    e.slot === undefined ? '' : ' in column ' + (Math.floor(e.slot / 3) + 1)
  let text = actor + ' '
  if (e.kind === 'open') text += 'revealed two opening cards'
  else if (e.kind === 'draw') text += 'drew blind'
  else if (e.kind === 'flip')
    text += 'discarded ' + e.discarded + ' and revealed ' + e.value + slot
  else
    text +=
      (e.kind === 'take' ? 'took ' : 'kept ') +
      e.value +
      ' and discarded ' +
      e.discarded +
      slot
  return (
    text +
    (e.cleared?.length
      ? ' · cleared column ' + e.cleared.map((c) => c + 1).join(', ')
      : '')
  )
}
function totalsTable(g: Game) {
  if (!g.history.length) return ''
  return (
    '<details class="round-details"><summary>Round-by-round scores</summary><div class="history-wrap"><table class="data-table"><thead><tr><th>Round</th>' +
    g.players
      .map(
        (p) =>
          '<th>' +
          html(p.seat === 0 ? 'You' : 'Seat ' + (p.seat + 1)) +
          '</th>',
      )
      .join('') +
    '</tr></thead><tbody>' +
    g.history
      .map(
        (r) =>
          '<tr><td>' +
          r.round +
          '</td>' +
          r.points.map((x) => '<td>' + x + '</td>').join('') +
          '</tr>',
      )
      .join('') +
    '</tbody></table></div></details>'
  )
}
function scoreboard(g: Game) {
  return (
    '<aside class="side"><section class="panel" id="scores"><div class="panel-head"><h2>Scoreboard</h2><span class="count">To 100</span></div><ol class="score-list">' +
    g.players
      .map(
        (p) =>
          '<li class="score-row"><span class="score-name">' +
          html(playerLabel(p)) +
          '<small>Seat ' +
          (p.seat + 1) +
          '</small></span><span class="score">' +
          p.total +
          '</span></li>',
      )
      .join('') +
    '</ol>' +
    totalsTable(g) +
    '</section>' +
    (g.recent.length
      ? '<details class="panel"><summary>Recent moves</summary><ol class="events">' +
        g.recent
          .slice()
          .reverse()
          .map((e) => '<li>' + html(recentEvent(g, e)) + '</li>')
          .join('') +
        '</ol></details>'
      : '') +
    '</aside>'
  )
}
function breakdown(g: Game) {
  const r = g.history.at(-1)
  if (!r) return ''
  return (
    '<section class="panel end-panel"><div class="row-between"><h2>Round ' +
    r.round +
    ' scores</h2>' +
    (page === 'detail' && game && game.phase !== 'gameOver'
      ? btn('table', 'Resume game', 'primary')
      : btn(
          g.phase === 'gameOver' ? 'new' : 'next',
          g.phase === 'gameOver' ? 'New game' : 'Next round',
          'primary',
          busy || !!pending,
        )) +
    '</div><div class="history-wrap"><table class="data-table"><thead><tr><th>Player</th><th>Cards</th><th>Round</th><th>Total</th></tr></thead><tbody>' +
    g.players
      .map((p, i) => {
        const raw = p.board.reduce<number>(
          (sum, x) => sum + (x === null || x === GONE ? 0 : x),
          0,
        )
        const doubled = i === r.closer && raw > 0 && r.points[i] === raw * 2
        return (
          '<tr><td>' +
          html(playerLabel(p)) +
          (i === r.closer ? ' · closed' : '') +
          '</td><td>' +
          raw +
          '</td><td>' +
          r.points[i] +
          (doubled ? ' (×2)' : '') +
          '</td><td>' +
          r.totals[i] +
          '</td></tr>'
        )
      })
      .join('') +
    '</tbody></table></div></section>'
  )
}
function live(g: Game) {
  const end = g.phase === 'roundOver' || g.phase === 'gameOver',
    copy = phaseCopy(g),
    human = g.players[0]
  const rivals = g.players
    .slice(1)
    .map(
      (p) =>
        '<div class="rival" aria-label="Seat ' +
        (p.seat + 1) +
        ', ' +
        html(p.name) +
        '">' +
        boardGrid(p.board, 'rival') +
        '<div class="rival-info"><span class="rival-name">' +
        html(p.name) +
        '</span><span class="rival-points">Seat ' +
        (p.seat + 1) +
        ' · ' +
        p.total +
        ' pts</span></div></div>',
    )
    .join('')
  const sources = g.phase !== 'opening' && !end
  const boardStatus = human.board.filter((x) => x === null).length + ' hidden'
  const enabled = page !== 'detail' && g.phase === 'source'
  const actions =
    g.phase === 'opening'
      ? '<p>' +
        openSlots.length +
        ' of 2 selected</p>' +
        btn(
          'open',
          'Reveal 2 cards',
          'felt-button',
          openSlots.length !== 2 || busy || !!pending,
        )
      : g.phase === 'held'
        ? '<p>Drawn card · ' +
          g.held +
          '</p><button class="tab-action" data-action="swap" aria-pressed="' +
          (mode !== 'flip') +
          '"' +
          disabled(busy || !!pending) +
          '>Swap drawn card</button><button class="tab-action" data-action="flip" aria-pressed="' +
          (mode === 'flip') +
          '"' +
          disabled(busy || !!pending) +
          '>Discard and flip</button>'
        : g.phase === 'source'
          ? '<p>' +
            (mode === 'take'
              ? 'Select the card to replace.'
              : 'Choose a pile above.') +
            '</p>' +
            (mode === 'take'
              ? btn(
                  'cancel-take',
                  'Cancel selection',
                  'tab-action',
                  busy || !!pending,
                )
              : '')
          : ''
  return (
    heading(
      copy[0],
      copy[1],
      'Round ' + g.round + ' · ' + g.players.length + ' players',
      'play-masthead',
    ) +
    (page === 'detail' ? btn('history', 'Back to history', 'quiet') : '') +
    (end ? breakdown(g) : '') +
    '<div class="two-col play-layout"><section class="tabletop" aria-label="Playing table"><div class="rivals">' +
    rivals +
    '</div>' +
    (sources
      ? '<div class="piles">' +
        pile('draw', null, 'Draw blind', true, enabled) +
        pile(
          'take',
          g.discard,
          'Take discard',
          false,
          enabled,
          mode === 'take',
        ) +
        (g.held !== null
          ? '<span class="separator"></span>' +
            pile('held', g.held, 'Your draw', false, false)
          : '') +
        '</div>'
      : '') +
    '<div class="your-area"><div class="row-between"><h2 class="board-title">Your board</h2><span class="board-meta">' +
    boardStatus +
    '</span></div>' +
    boardGrid(human.board, 'human', g) +
    '</div>' +
    (actions ? '<div class="action-bar">' + actions + '</div>' : '') +
    '</section>' +
    scoreboard(g) +
    '</div>'
  )
}
let settingUp = false
function matchHistory() {
  const active =
    game && game.phase !== 'gameOver'
      ? '<div class="panel current-tile row-between"><div><h2>Current match</h2><p class="subtle">Round ' +
        game.round +
        ' · ' +
        game.players.length +
        ' players</p></div>' +
        btn('table', 'Resume game', 'secondary') +
        '</div>'
      : ''
  const rows = historyRows
    .map((item) => {
      const human = item.players.find((p) => p.seat === 0)!
      const won = item.winners.includes(0)
      const title = won
        ? item.winners.length === 1
          ? 'You won'
          : 'You tied for first'
        : 'You placed ' + human.place + ' of ' + item.players.length
      return (
        '<article class="panel history-entry"><div class="row-between"><div><h2>' +
        html(title) +
        '</h2><p>' +
        html(displayDate(item.finishedAt)) +
        ' · ' +
        item.rounds.length +
        ' rounds · ' +
        human.total +
        ' points</p></div><button class="quiet" data-detail="' +
        html(item.id) +
        '"' +
        disabled(busy) +
        '>Game details</button></div></article>'
      )
    })
    .join('')
  return (
    heading('Match history', 'Your completed games and final standings.') +
    '<div class="history-list">' +
    active +
    rows +
    '</div>' +
    (loadingHistory
      ? '<p class="empty">Loading history…</p>'
      : !historyRows.length && historyLoaded
        ? '<section class="panel"><h2>No completed games yet</h2><p>Finish a match to see the round scores and standings here.</p></section>'
        : '') +
    (cursor
      ? btn('more-history', 'Load more', 'quiet', loadingHistory)
      : !historyLoaded && !loadingHistory
        ? btn('history', 'Retry history', 'quiet')
        : '')
  )
}
function render(restoreFocus = false) {
  const focused =
    restoreFocus && document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.slot
      : undefined
  const g = page === 'detail' ? detail : game
  document
    .querySelector('#nav-table')!
    .setAttribute('aria-current', page === 'table' ? 'page' : 'false')
  document
    .querySelector('#nav-history')!
    .setAttribute('aria-current', page !== 'table' ? 'page' : 'false')
  app.dataset.phase =
    page === 'history'
      ? 'history'
      : g && (!settingUp || page === 'detail')
        ? g.phase
        : 'setup'
  app.innerHTML =
    page === 'history'
      ? matchHistory()
      : g && (!settingUp || page === 'detail')
        ? live(g)
        : setup()
  setNotice()
  if (focused !== undefined)
    app
      .querySelector<HTMLElement>(
        '[data-slot="' + focused + '"]:not(:disabled)',
      )
      ?.focus({ preventScroll: true })
}
function clearChoices() {
  openSlots = []
  mode = 'none'
}
function acceptGame(next: Game) {
  game = next
  detail = null
  settingUp = false
  page = 'table'
  clearChoices()
  if (next.phase === 'held') mode = 'swap'
  if (next.phase === 'gameOver') {
    historyLoaded = false
    historyEpoch++
  }
}
let fetchingCurrent = false
async function bootstrap() {
  if (fetchingCurrent) return
  fetchingCurrent = true
  const epoch = ++tableEpoch,
    token = key
  loading = true
  bootFailed = false
  notice = ''
  render()
  try {
    const [catalog, current] = await Promise.all([
      api<{ engines: EngineInfo[] }>('/api/engines'),
      api<{ game: Game | null }>('/api/games/current', { token }),
    ])
    if (epoch !== tableEpoch || token !== key) return
    engines = catalog.engines
    selected = selected.filter((id) => engines.some((e) => e.id === id))
    if (!selected.length && engines.length) selected = [engines[0].id]
    if (current.game) {
      game = current.game
      clearChoices()
      if (game.phase === 'held') mode = 'swap'
    } else game = null
    if (pending)
      notice = 'A saved move is waiting for confirmation. Retry it to continue.'
  } catch (e) {
    if (epoch === tableEpoch && token === key) {
      bootFailed = true
      notice = message(e)
    }
  } finally {
    fetchingCurrent = false
    if (epoch === tableEpoch) {
      loading = false
      render()
    }
  }
}
async function submit(request: Pending) {
  if (busy || loading) return
  busy = true
  const token = key
  pendingSet(request)
  notice = ''
  render()
  try {
    const res = await api<{ game: Game }>(request.path, {
      token,
      body: request.body,
    })
    if (token !== key) return
    pendingSet(null)
    acceptGame(res.game)
  } catch (e) {
    if (token !== key) return
    if (e instanceof ApiError && e.status === 409) {
      pendingSet(null)
      const id = request.path.match(/^\/api\/games\/([^/]+)\/moves$/)?.[1]
      if (id) {
        try {
          const res = await api<{ game: Game }>(
            '/api/games/' + encodeURIComponent(id),
            { token },
          )
          acceptGame(res.game)
          notice =
            'This game changed in another tab. The latest position is shown.'
        } catch (readError) {
          bootFailed = true
          notice = message(readError)
        }
      } else notice = message(e)
    } else if (
      e instanceof ApiError &&
      e.status >= 400 &&
      e.status < 500 &&
      e.status !== 429
    ) {
      pendingSet(null)
      notice = message(e)
    } else notice = message(e) + ' Your request is saved for retry.'
  } finally {
    busy = false
    render()
  }
}
function move(action: MatchCommand) {
  if (!game || page !== 'table' || busy || pending || settingUp) return
  void submit({
    path: '/api/games/' + encodeURIComponent(game.id) + '/moves',
    body: { requestId: uuid(), expectedRevision: game.revision, action },
  })
}
function start() {
  if (
    !selected.length ||
    busy ||
    pending ||
    loading ||
    (!settingUp && game && game.phase !== 'gameOver')
  )
    return
  void submit({
    path: '/api/games',
    body: { requestId: uuid(), opponents: [...selected] },
  })
}
function selectSlot(slot: number) {
  if (!game || page !== 'table' || pending || busy || slot < 0 || slot > 11)
    return
  const card = game.players[0].board[slot]
  if (card === GONE) return
  if (game.phase === 'opening' && card === null) {
    if (openSlots.includes(slot))
      openSlots = openSlots.filter((x) => x !== slot)
    else if (openSlots.length < 2) openSlots.push(slot)
    render(true)
  } else if (game.phase === 'source' && mode === 'take')
    move({ kind: 'take', slot })
  else if (game.phase === 'held' && (mode !== 'flip' || card === null))
    move({ kind: mode === 'flip' ? 'flip' : 'swap', slot })
}
async function showHistory(append = false) {
  if (busy || (!append && page === 'history' && loadingHistory)) return
  const token = key,
    epoch = ++historyEpoch
  page = 'history'
  detail = null
  notice = ''
  loadingHistory = true
  render()
  try {
    const path =
      '/api/history?limit=10' +
      (append && cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    const res = await api<{ items: Finished[]; nextCursor: string | null }>(
      path,
      { token },
    )
    if (epoch !== historyEpoch || token !== key) return
    const items = append ? [...historyRows, ...res.items] : res.items
    historyRows = [...new Map(items.map((r) => [r.id, r])).values()]
    cursor = res.nextCursor
    historyLoaded = true
  } catch (e) {
    if (epoch === historyEpoch) {
      notice = message(e)
      if (!append) historyLoaded = false
    }
  } finally {
    if (epoch === historyEpoch) {
      loadingHistory = false
      render()
    }
  }
}
async function showDetail(id: string) {
  if (busy) return
  busy = true
  const token = key,
    epoch = ++historyEpoch
  notice = ''
  render()
  try {
    const res = await api<{ game: Game }>(
      '/api/games/' + encodeURIComponent(id),
      { token },
    )
    if (token !== key || epoch !== historyEpoch) return
    detail = res.game
    page = 'detail'
  } catch (e) {
    if (epoch === historyEpoch) notice = message(e)
  } finally {
    busy = false
    render()
  }
}
function openDialog(body: string, title: string) {
  if (dialog.open) dialog.close()
  dialogContent.innerHTML =
    '<div class="dialog-head"><h2 id="dialog-title">' +
    html(title) +
    '</h2><button class="close" data-action="close" aria-label="Close">×</button></div>' +
    body
  dialog.setAttribute('aria-labelledby', 'dialog-title')
  dialog.showModal()
}
function recovery() {
  openDialog(
    '<p>This private key opens your table and match history on another device. Keep a copy somewhere safe.</p><div class="key-fields"><label class="field-label" for="own-key">Your recovery key</label><input id="own-key" readonly type="password" value="' +
      html(key) +
      '" autocomplete="off" spellcheck="false"><div class="key-actions">' +
      btn('copy-key', 'Copy key', 'secondary') +
      btn('show-key', 'Show key', 'quiet') +
      '</div></div>' +
      '<form class="restore-form" id="restore-form"><label class="field-label" for="restore-key">Recovery key to restore</label><input id="restore-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required><p>Restoring switches this browser to that profile. Copy your current key first to keep access to this table.</p><button class="primary" type="submit">Restore key</button></form><div class="dialog-feedback" id="dialog-feedback" role="status" aria-live="polite"></div>',
    'Recovery key',
  )
}
function rules() {
  openDialog(
    '<ol><li>Reveal two of your 12 cards. The highest opening sum starts the first round.</li><li>Take the discard and swap it for one of your cards, or draw blind. You can swap a blind draw into your board, or discard it and flip a hidden card.</li><li>Three equal face-up cards in a vertical column clear automatically.</li><li>Revealing your last hidden card gives everyone else one final turn. Add your remaining cards. If another player ties or beats the closer’s positive score, the closer doubles their round points.</li><li>After any player reaches 100 total points, the lowest total wins. Players tied for the lowest total share the win.</li></ol>',
    'How to play',
  )
}
function feedback(text: string) {
  const box = document.querySelector('#dialog-feedback')
  if (box) box.textContent = text
}
async function copyKey() {
  try {
    await navigator.clipboard.writeText(key)
    feedback('Recovery key copied.')
  } catch {
    const input = document.querySelector<HTMLInputElement>('#own-key')
    if (input) {
      input.type = 'text'
      input.focus()
      input.select()
      const toggle = dialog.querySelector('[data-action="show-key"]')
      if (toggle) toggle.textContent = 'Hide key'
    }
    feedback('Select and copy the key shown above.')
  }
}
let restoring = false
async function restoreKey() {
  if (restoring || busy || pending) {
    feedback('Finish or retry the current move before switching profiles.')
    return
  }
  const input = document.querySelector<HTMLInputElement>('#restore-key')!
  const candidate = input.value.trim()
  if (!validKey(candidate)) {
    feedback('Enter a complete 43-character recovery key.')
    input.focus()
    return
  }
  restoring = true
  const button = dialog.querySelector<HTMLButtonElement>('[type=submit]')!
  button.disabled = true
  feedback('Restoring your profile…')
  try {
    const res = await api<{ game: Game | null }>('/api/games/current', {
      token: candidate,
    })
    key = candidate
    writeStorage(KEY_STORE, key)
    pendingSet(null)
    tableEpoch++
    historyEpoch++
    loadingHistory = false
    historyRows = []
    historyLoaded = false
    cursor = null
    game = res.game
    settingUp = false
    page = 'table'
    detail = null
    clearChoices()
    if (game?.phase === 'held') mode = 'swap'
    loading = false
    bootFailed = false
    notice = 'Recovery key restored.'
    if (dialog.open) dialog.close()
    render()
    if (!engines.length) void bootstrap()
  } catch (e) {
    feedback(message(e))
  } finally {
    restoring = false
    button.disabled = false
  }
}
function onAction(action: string, el: HTMLElement) {
  if (action === 'recovery') {
    if (!busy) recovery()
    return
  }
  if (action === 'rules') {
    rules()
    return
  }
  if (action === 'close') {
    if (!restoring) dialog.close()
    return
  }
  if (action === 'show-key') {
    const input = document.querySelector<HTMLInputElement>('#own-key')!
    input.type = input.type === 'password' ? 'text' : 'password'
    el.textContent = input.type === 'password' ? 'Show key' : 'Hide key'
    return
  }
  if (action === 'copy-key') {
    void copyKey()
    return
  }
  if (busy) return
  if (action === 'retry') {
    if (pending) void submit(pending)
    return
  }
  if (action === 'reload') {
    void bootstrap()
    return
  }
  if (action === 'table') {
    historyEpoch++
    loadingHistory = false
    page = 'table'
    detail = null
    notice = pending ? 'A saved move is waiting for confirmation.' : ''
    render()
    return
  }
  if (action === 'history') {
    void showHistory()
    return
  }
  if (action === 'more-history') {
    if (!loadingHistory && cursor) void showHistory(true)
    return
  }
  if (action === 'new' && (game?.phase === 'gameOver' || !game)) {
    historyEpoch++
    detail = null
    page = 'table'
    settingUp = true
    notice = ''
    render()
    return
  }
  if (pending) return
  if (action === 'add' && selected.length < 7 && engines.length) {
    selected.push(
      (engines.find((e) => !selected.includes(e.id)) ?? engines[0]).id,
    )
    render()
    document
      .querySelector<HTMLSelectElement>('#op-' + (selected.length - 1))
      ?.focus()
    return
  }
  if (action === 'start') {
    start()
    return
  }
  if (!game || page !== 'table' || settingUp) return
  if (action === 'open' && game.phase === 'opening' && openSlots.length === 2) {
    move({ kind: 'open', slots: [openSlots[0], openSlots[1]] })
    return
  }
  if (action === 'draw' && game.phase === 'source') {
    move({ kind: 'draw' })
    return
  }
  if (action === 'take' && game.phase === 'source') {
    mode = 'take'
    render()
    return
  }
  if (action === 'cancel-take') {
    mode = 'none'
    render()
    return
  }
  if ((action === 'swap' || action === 'flip') && game.phase === 'held') {
    mode = action
    render()
    return
  }
  if (action === 'next' && game.phase === 'roundOver') {
    move({ kind: 'nextRound' })
    return
  }
}
document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return
  const el = e.target.closest<HTMLElement>(
    '[data-action],[data-slot],[data-remove],[data-detail]',
  )
  if (!el || el.matches(':disabled')) return
  if (el.dataset.slot !== undefined) {
    selectSlot(Number(el.dataset.slot))
    return
  }
  if (
    el.dataset.remove !== undefined &&
    !busy &&
    !pending &&
    selected.length > 1
  ) {
    selected.splice(Number(el.dataset.remove), 1)
    render()
    return
  }
  if (el.dataset.detail) {
    void showDetail(el.dataset.detail)
    return
  }
  if (el.dataset.action) onAction(el.dataset.action, el)
})
document.addEventListener('change', (e) => {
  const el = e.target
  if (
    el instanceof HTMLSelectElement &&
    el.dataset.opponent !== undefined &&
    !busy &&
    !pending &&
    engines.some((p) => p.id === el.value)
  ) {
    const i = Number(el.dataset.opponent)
    selected[i] = el.value
    render()
    document.querySelector<HTMLSelectElement>('#op-' + i)?.focus()
  }
})
document.addEventListener('submit', (e) => {
  if ((e.target as HTMLElement).id === 'restore-form') {
    e.preventDefault()
    void restoreKey()
  }
})
dialog.addEventListener('cancel', (e) => {
  if (restoring) e.preventDefault()
})
void bootstrap()
