# Engineering contract

Repository: `the-carl/skyjo-strategy-lab`

Verified origin: `https://github.com/The-CarL/skyjo-strategy-lab.git`

Factory source: [14ed9d222230ae85dd14b9baaf2a754e309b982f](https://github.com/the-carl/engineering-factory/tree/14ed9d222230ae85dd14b9baaf2a754e309b982f)

The shared operating rules in `AGENTS.md` are available locally to any selected AI engineering client; verify its instruction-loading path. Pinned factory references supplement them. Complete this app-owned contract with actual decisions, commands and evidence as the project develops.

## Delivered product

The lab combines a deterministic classic Skyjo engine, public player observations, configurable opponents, reproducible tournaments, replay verification, CPU model training, and an offline coach. The [README](README.md) lists exact commands. The [results](reports/README.md) include seed-clustered comparisons and released weights. The [model card](docs/model-card.md) records the training contract and limitations.

Carlo authorized pushing the project publicly and selected a downloadable coach. The ZIP and printable PDF are versioned with the source. A single HTML file contains the browser application and models. GitHub Pages and a hosted backend are outside the selected delivery. Board state stays on-device; undo history is held in memory for the current session.

The AWS allowance is $100 estimated. The runs used the supplied workspace CPU only. Estimated project AWS spend is $0. There are no AWS resources, background jobs or ongoing hosting charges provisioned by this project. No provider credentials are required to reproduce results. Public operation records contain no private deployment inventory.

Design follows the Factory's documented warm surfaces, restrained typography and accent treatment. The coach uses a high-contrast green playing surface, tap-sized numbered cards, stable spatial placement and a distinct printable view. Styling and assets are local to the application.

Tests cover the deck, phases, hidden-information boundary, conservation, recycling, final turns, clearing, scoring, illegal moves, termination and scikit-learn inference parity. Browser acceptance covers a narrow viewport, offline turn advice, column clearing, undo, persistence and printing. The managed workspace browser accepts the download through a loopback HTML fixture; CI opens the file directly in Chromium. Physical iOS and Android hardware have not been certified. Workflows run under read-only repository permissions.

The factory registry uses the public-minimal profile. Restore from the app repository, install dependencies with npm ci, and follow the README. Future policy changes should reserve fresh seed ranges and report their effect on full-game wins. The original table recommendation assumes classic rules and uses only visible cards on the player's board.

## Whole-match strategy study

The phase-two engine can resume a partial round in a sampled hidden world and continue through the match scoring threshold. The released neural net and tree use the original 18 board-and-action features. The CPU teacher labels their candidate moves using split win credit at match end. A matched control uses the end of the current round on exactly the same simulated trajectories. The [study record](reports/phase2/README.md) covers the independent seed ranges, model selection, paper rule, research-only full-table policies and release decisions.

The coach reads its default paper rule and optional whole-match model from `web/release.json`. `npm run phase2:verify` recomputes the league statistics from compressed shuffle blocks and verifies the shipped choices. Only new board sessions adopt the new family default. Existing valid saved sessions retain the selected strategy. The release includes both printable rules and a printable, anonymous family comparison sheet. All research used the existing workspace CPU. Estimated additional AWS cost was $0.

## Factory guidance

- [Product co-architecture](https://github.com/The-CarL/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/product-architecture.md)
- [Application design](https://github.com/The-CarL/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/application-design.md)
- [Design references](https://github.com/The-CarL/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/design-references.md)
