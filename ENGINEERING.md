# Engineering contract

Repository: `the-carl/skyjo-strategy-lab`

Verified origin: `https://github.com/The-CarL/skyjo-strategy-lab.git`

Factory source: [14ed9d222230ae85dd14b9baaf2a754e309b982f](https://github.com/the-carl/engineering-factory/tree/14ed9d222230ae85dd14b9baaf2a754e309b982f)

The shared operating rules in `AGENTS.md` are available locally to any selected AI engineering client; verify its instruction-loading path. Pinned factory references supplement them. Complete this app-owned contract with actual decisions, commands and evidence as the project develops.

## Delivered product

The lab combines a deterministic classic Skyjo engine, public player observations, configurable opponents, reproducible tournaments, replay verification, CPU model training, and an offline coach. The [README](README.md) lists exact commands. The [results](reports/README.md) include seed-clustered comparisons and released weights. The [model card](docs/model-card.md) records the training contract and limitations.

The original release delivered a public repository and a downloadable coach for playing with physical cards. The ZIP and printable PDF are versioned with the source. A single HTML file contains the browser application and models. The physical-table coach runs locally after download. Board state stays on-device; undo history is held in memory for the current session.

The project AWS allowance is $100 estimated. The first two research studies used the supplied workspace CPU with an estimated $0 in additional AWS spend. No provider credentials are required to reproduce results. Public operation records contain no private deployment inventory.

Design follows the Factory's documented warm surfaces, restrained typography and accent treatment. The coach uses a high-contrast green playing surface, tap-sized numbered cards, stable spatial placement and a distinct printable view. Styling and assets are local to the application.

Tests cover the deck, phases, hidden-information boundary, conservation, recycling, final turns, clearing, scoring, illegal moves, termination and scikit-learn inference parity. Browser acceptance covers a narrow viewport, offline turn advice, column clearing, undo, persistence and printing. The managed workspace browser accepts the download through a loopback HTML fixture; CI opens the file directly in Chromium. Physical iOS and Android hardware have not been certified. Workflows run under read-only repository permissions.

The factory registry uses the public-minimal profile. Restore from the app repository, install dependencies with npm ci, and follow the README. Future policy changes should reserve fresh seed ranges and report their effect on full-game wins. The original table recommendation assumes classic rules and uses only visible cards on the player's board.

## Whole-match strategy study

The phase-two engine can resume a partial round in a sampled hidden world and continue through the match scoring threshold. The released neural net and tree use the original 18 board-and-action features. The CPU teacher labels their candidate moves using split win credit at match end. A matched control uses the end of the current round on exactly the same simulated trajectories. The [study record](reports/phase2/README.md) covers the independent seed ranges, model selection, paper rule, research-only full-table policies and release decisions.

The coach reads its default paper rule and optional whole-match model from `web/release.json`. `npm run phase2:verify` recomputes the league statistics from compressed shuffle blocks and verifies the shipped choices. Only new board sessions adopt the new family default. Existing valid saved sessions retain the selected strategy. The release includes both printable rules and a printable, anonymous family comparison sheet. All research used the existing workspace CPU. Estimated additional AWS cost was $0.

## Hosted play

The online game puts a human at seat zero and lets them select the engine for each of one to seven opposing seats. The backend deals and scores through the same engine as the research tournaments. It persists a complete private state between moves and sends the browser each player's visible board, the public actions, and the human's current draw. A versioned move can commit only once. The game record keeps the engine lineup, round scores, cumulative standings, and tied winners.

A private recovery key represents an anonymous player. A browser generates it from 32 random bytes and sends it in the X-Skyjo-Profile header. CloudFront uses the Authorization header to sign its request to the Lambda origin. Browser writes include the SHA-256 of the exact request body. The database partitions by a hash and never needs the original key. Keeping the key lets the player recover their current game and results after switching browsers or moving to a custom hostname. The game can be hosted under any HTTPS root with the UI and API on the same origin. The public hostname is `skyjo.carloperottino.com`. The browser uses the public hostname for play and coaching. The [recovery instructions](README.md#play-a-match-online) explain how to bring a profile from the original Lambda URL to that hostname. Physical boards and undo history remain local to each browser origin.

The layout uses the original coach's green table surface, with warm paper, rust accents, and straightforward typography adapted from [Forge's style guide](https://github.com/The-CarL/carloperottino-forge/blob/d584183/STYLE_GUIDE.md). At the table, legal card targets and the current round action have priority. GitHub CI runs the server locally against an in-memory store for repeatable browser tests. Runtime storage is a private DynamoDB table. The public [online game](https://skyjo.carloperottino.com/) serves the UI and API through CloudFront. Its HTTPS origin is the existing Lambda function URL in us-east-1. CloudFront caches public assets and forwards private game requests to Lambda with caching disabled. The [traffic controls](infra/traffic.md) cover incident response, owner access and the new-game pause. Source verification covered the ZIP digest, the deployed browser assets, the engine catalog, Lambda concurrency, table access and HTTPS. A Chromium acceptance run completed a two-round game on the public site, resumed across two browser profiles, checked isolation from an unrelated profile, and verified identical standings and round history on both devices. The deployment recipe and estimated cost model are in the [hosting guide](infra/README.md). A copy of the private deployment inventory is required for subsequent releases.

The online strategy guide and the physical coach share the descriptions in `src/strategy-guide.ts`. The online catalog pairs each entry with its actual policy ID. Six entries also map to the existing coach mode IDs so saved selections survive updates. The [Forge guide](https://forge.carloperottino.com/projects/skyjo-strategy-lab#meet-the-12-online-opponents) covers the same opponents. Check numerical examples against the shipped policy when changing either guide.

The table setup supports 2–8 players and an independent engine selection per computer seat. Abandoning an unfinished game is a revision-checked, retriable command. It removes the playable board and omits that game from completed results. A browser holding an older tab cannot discard a newer active game.

The physical-table coach at `/coach` shares its template, strategy code and release choices with the downloadable coach. The server serves its HTML, JavaScript and CSS from the same origin. Entered cards and the physical board are stored in the browser, independently of the online match identified by its recovery key. Returning to the online table resumes its latest saved turn.

## Forge publication

The [Forge project entry](https://forge.carloperottino.com/projects/skyjo-strategy-lab) links to the playable table and physical coach. The [original Forge publication](https://github.com/The-CarL/carloperottino-forge/pull/26) introduced the research article and screenshot. Forge owns `src/content/projects/skyjo-strategy-lab.md` and `public/projects/skyjo-strategy-lab/clear-or-trade.png` for the catalog route `forge.carloperottino.com/projects/skyjo-strategy-lab`. The family kit is served from this application repository.

## Factory guidance

- [Product co-architecture](https://github.com/The-CarL/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/product-architecture.md)
- [Application design](https://github.com/The-CarL/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/application-design.md)
- [Design references](https://github.com/The-CarL/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/design-references.md)
