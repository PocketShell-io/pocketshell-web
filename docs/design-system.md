# PocketShell web design system

The authoritative contract is [pocketshell-site/docs/design-contract.md](https://github.com/PocketShell-io/pocketshell-site/blob/main/docs/design-contract.md).

Accent borders are forbidden across PocketShell websites and shared UI. This includes colored stripes on one or several sides (physical or logical border properties, or unequal per-side width/color lists), and any border, outline, or box-shadow ring using an accent or status color: cyan, green, red, amber, or `--accent*`, `--danger*`, `--warn*`, `--ok*`, `--success*`, `--error*` tokens and their aliases.

Use a subtle tinted background, an icon, or a bold heading/label in the status color instead. Selection, warning, error, and success remain recognizable without colored edges.

Allowed treatments are full 1px neutral borders (`#23272e`, `#33383f`, or equivalent `--border`, `--border-soft`, `--border-strong` tokens), neutral 1px dividers between rows, neutral-strong form-control borders on hover, and accent focus-visible outlines for accessibility. Pointer focus and drag outlines use neutral colors.

`tests/accentBorders.test.ts` scans CSS and Vue style blocks and verifies forbidden and allowed fixtures. It runs in the normal Vitest CI gate. The same scanner lives beside the shared UI package's tests in pocketshell-core.
