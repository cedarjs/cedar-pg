# setup-autopg

Composite GitHub Action: install the pinned, attested **autopg** binary (no pm2) and cache it for CI jobs that use `@cedarjs/pg`.

The install core stays in `scripts/ci-install-autopg.sh`. This action wraps cache + `PATH` + that script.

## In this repository

```yaml
- uses: actions/checkout@v6
- uses: ./.github/actions/setup-autopg
```

## From another repository (after this action is published / tagged)

```yaml
- uses: actions/checkout@v6
- uses: cedarjs/cedar-pg/.github/actions/setup-autopg@main # pin to a tag when ready
```

Optional inputs:

| Input     | Default                           | Meaning                              |
| --------- | --------------------------------- | ------------------------------------ |
| `version` | cedar-pg `scripts/autopg-version` | Override release tag (e.g. `v3.0.7`) |
| `cache`   | `true`                            | Cache install tree under `~/.local`  |
| `token`   | `github.token`                    | Token for `gh attestation verify`    |

Outputs: `version`, `cache-hit`, `bin`.

## Publishing later

1. Tag a cedar-pg release (or a dedicated action tag).
2. Point consumers at `cedarjs/cedar-pg/.github/actions/setup-autopg@<tag>`.
3. Optionally list it in the GitHub Marketplace once the API is stable.

Until then, keep using the local path in this repo; other Cedar repos can already consume via `@main` / `@<sha>` if they accept floating refs.
