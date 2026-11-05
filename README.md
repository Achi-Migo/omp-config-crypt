# omp-config-crypt (v0.9.6)

Universal, zero-repair cross-platform configuration encryption and synchronization engine for `omp` (Oh My Pi).

Supports both **in-OMP slash commands** and an **independent standalone CLI (`omp-sync`)**. Seamlessly synchronizes configurations across Linux (root / non-root), macOS, and Windows WSL with zero manual post-restore adjustments.

---

## Key Features

1. **Adaptive Cross-Platform Remapping**:
   - Automatically sanitizes machine-specific home paths (e.g., `/root`, `/home/user`, `/Users/alice`, `C:\Users\bob`) into a portable `{{OMP_HOME}}` placeholder.
   - On import, dynamically remaps placeholders and source paths to the target host's actual `$HOME` and normalizes path separators.
2. **Zero OMP Internal Dependency**:
   - Built 100% on native Node.js built-ins (`node:crypto`, `node:fs`, `node:path`, `node:zlib`, `node:os`).
   - Core `omp` binary upgrades never break or affect this tool.
3. **Comprehensive Asset Synchronization**:
   - **Core Configs**: `config.yml`, `models.yml`, `mcp.json`, `AGENTS.md`, `STYLE.md`, `RULES.md`.
   - **Credentials & Tokens**: Automatic discovery and encryption of `opc-mcp-token` and `*.token` files.
   - **User Extensions**: Native `~/.omp/agent/extensions/**` plus supported legacy extension assets.
   - **Skills & Knowledge**: Recursive sync of `managed-skills/**` and `memories/**`.
   - **Plugins Manifest**: Syncs `plugins/omp-plugins.lock.json` for deterministic plugin tracking.
   - **Strict Blacklist**: Automatically excludes SQLite runtime databases (`*.db`, `*.db-wal`, `*.db-shm`), session logs, and cache folders.
4. **Safety & Instant Rollback**:
   - Pre-existing files are automatically backed up to `.import-backup-<timestamp>/` prior to overwriting.
   - One-command instant rollback (`omp-sync rollback` or `/config-rollback`).
   - Non-destructive dry-run preview (`--dry-run`).

---

## Standalone CLI (`omp-sync`)

Run outside or before starting `omp` (ideal for fresh machine setup, Docker provisioning, and CI/CD):

```bash
# Export configs locally
npx omp-config-crypt export my-backup.enc --pass "mysecret"

# Import configs locally with dry-run preview
npx omp-config-crypt import my-backup.enc --pass "mysecret" --dry-run

# Import configs locally
npx omp-config-crypt import my-backup.enc --pass "mysecret"

# Cloud Push (GitHub Gist)
npx omp-config-crypt push gist:new --pass "mysecret" --token "$GITHUB_TOKEN"

# Cloud Pull (GitHub Gist)
npx omp-config-crypt pull gist:<id> --pass "mysecret" --token "$GITHUB_TOKEN"

# Cloud Pull adopting a different remote configuration set (takeover):
# aligns local sync-policy/sync-state namespace to the remote one; both files are backed up to .bak first
npx omp-config-crypt pull gist:<id> --pass "mysecret" --token "$GITHUB_TOKEN" --force

# Cloud Pull self-healing: machines with no sync state yet adopt the remote set
# automatically (no --force needed); corrupt policy/state JSON is backed up and rebuilt
npx omp-config-crypt pull gist:<id> --pass "mysecret" --token "$GITHUB_TOKEN"

# Conflict resolution: when local files differ from remote with no baseline
# (initial-conflict-both-exist-different), default behavior aborts. Auto-resolve:
#   --strategy prefer-remote  overwrite local with remote (typical fresh-machine pull)
#   --strategy prefer-local   keep local files and adopt them as the new baseline
npx omp-config-crypt pull gist:<id> --pass "mysecret" --token "$GITHUB_TOKEN" --strategy prefer-remote

# Keep every modelRoles leaf local (preset and top-level). Other conflicts still abort.
npx omp-config-crypt pull gist:<id> --pass "mysecret" --token "$GITHUB_TOKEN" --local

# Rollback to previous configuration snapshot
npx omp-config-crypt rollback

# Self-update the package (plugins dir or global install); --check only reports
npx omp-config-crypt upgrade --check
npx omp-config-crypt upgrade
```

# Provider Auto-Probing & Management (Public / Private)
npx omp-config-crypt provider add my-provider --url "https://api.openai.com/v1" --key "sk-..." --role smol --private

# List all configured providers & role bindings
npx omp-config-crypt provider list

# Bind a model role (default, smol, plan, slow, web)
npx omp-config-crypt role set smol my-provider/gpt-4o-mini

---

## In-OMP Slash Commands

Inside any `omp` session:

Tab completion preserves existing arguments for `/provider edit|test|rm|remove`, provider options, and `/role <role> <provider/model>`; selecting a provider after `/provider edit ` inserts its name without replacing `edit`.

Configuration exports include the installed `omp-config-crypt` source (excluding nested dependencies), preserving local provider/role fixes and sync-engine changes on restore. Native extensions and global tools are included as well. Restart OMP after restoring; a later npm/plugin upgrade can overwrite local plugin changes.

```text
/config-export [out.enc]
/config-import <file.enc> [--dry-run]
/config-push gist:new
/config-push gist:<id>
/config-push https://…
/config-pull gist:<id> [--dry-run] [--force] [--local]
/config-pull https://… [--dry-run] [--force] [--local]
/config-rollback
/config-upgrade [--check]
/config-doctor [gist:<id> | https://…]
```

`/config-pull` (and `omp-sync pull`) runs a preflight before downloading: corrupt sync
metadata is healed in place, an outdated self version is upgraded via npm (restart omp to
activate), and plugin dependencies missing after the plan are auto-installed and the plan
recomputed once. Unfixable findings (missing npm, unreachable/wrong target) fail with exact
next-step commands. `/config-doctor` (or `omp-sync doctor [gist:<id>|https://url]`) runs the
same checks standalone; exit code 1 when any check fails.

### Provider control menu

Run `/provider` in an interactive OMP session for the native keyboard menu (↑↓ / Enter / Esc).
Add selects OpenAI (`openai-completions` or `openai-responses`) or Anthropic (`anthropic-messages`),
then URL, masked Key and PRIVATE/PUBLIC scope. Models come from the endpoint catalog, local
registry/configuration hints, a fixed popular-candidate list, then manual IDs. Recommendations
are offline hints, not availability claims or a live ranking. Each stage tests every unique
candidate with the selected URL, Key and protocol before showing selectable models (two requests
at most concurrently, ten seconds per request, no automatic retries; requests may incur charges).
Only successful models appear in the native multi-select: Space toggles, Enter confirms the
checked subset, Esc returns to source actions. Other/manual IDs also require generation checks.
Progress and model rows show full short-generation latency in milliseconds, including the final
stream event. Esc during discovery or testing cancels acquisition. A supported native askDialog
host is required. The local registry is read without refreshing it or accessing other credentials.
Managing an existing provider no longer re-tests configured models by default: the edit "模型"
entry first offers "保留已配置模型", which keeps every configured model checked and verified
without generation requests. "重新选择并测试模型" reopens the full acquisition flow, where
configured models are marked "已配置（默认保留）", skip candidate testing, and only new
candidates require generation checks.
Manage existing providers to view details, edit a draft, verify a selected model, or confirm deletion.
Role-bound providers must be rebound through `/role` before deletion (both in interactive UI and non-UI
slash command `/provider rm <name>`, preventing dangling role references in `config.yml`; `omp-sync provider rm`
requires `--force` if role-bound). Unbound providers remain fully compatible with headless script deletion.

`/provider ls|list` remains a text list. `/provider add|wizard`, `/provider edit <name>`,
`/provider test <name>`, and `/provider rm|remove <name>` open the relevant interactive flow.
Without UI, use `/provider add <name> <url> [key] [--api <type>] [--model <id>] [--private|--public]`.
Protocol defaults to `openai-completions`; flags never become the Key. Edit and test require UI.

Discovery alone does **not** verify generation. Interactive add and edit model acquisition are unified:
both require candidate verification via real short generations with clear billing/cost notice before multi-select.
Existing model custom parameters (e.g., `contextWindow`, `maxTokens`, `compat`, `reasoning`) are preserved when
re-selected. Cancelling acquisition performs zero writes to the draft. If protocol, Base URL, or Key is modified
in the draft, cached model checks are invalidated immediately, preventing unverified saves.
`filterChatModels` excludes non-chat image/video generation models (e.g. Sora, Kling, CogVideo, Runway, Luma,
Pika, Vidu, Wanx, SDXL, Imagen, Ideogram, Kolors, `*-image`, `*-video`) while strictly preserving vision chat models.
The summary supports rechecking all selected models; failed, cancelled or unstarted rechecks cannot inherit
previous successes. Check results, source labels and latency remain in memory and are not saved. `/provider test`
checks one model and reports its latency; it does not claim the entire provider is verified.
Draft cancellation does not write. In-session interactive and non-UI `/provider` add, edit, and deletion synchronize immediately into the active OMP session's model catalog (`/models`). If the current session model belongs to a provider whose configuration is deleted or edited without that model ID, an alternative model must be selected before writing; if no replacement model is available, or if the current model is actively generating, the operation is blocked with zero configuration writes. If model catalog synchronization fails, configuration writes remain preserved on disk and a warning notification is displayed. Standalone `omp-sync` and other external OMP processes operate strictly at the file level and load changes upon their next startup.
PRIVATE is the default and is excluded by encrypted-sync filtering; PUBLIC includes credentials
in encrypted synchronization. Private providers remain mirrored in both existing stores.
Background maintenance preserves the active `models.local.json` store; only obsolete root-level
extension files remain eligible for legacy cleanup.
The generated private loader lives at `~/.omp/agent/extensions/local-models.js`; existing loaders
and legacy files are not overwritten or removed. Invalid private JSON and public YAML fields
unsupported by the fixed-field formatter reject writes rather than silently discard configuration.

Standalone Responses example:
`omp-sync provider add gateway --url https://example.com/v1 --key YOUR_KEY --api openai-responses --model MODEL_ID --private --non-interactive`.
If discovery fails, an explicit `--model` can still be saved, clearly marked unverified.

**Notice on Updates:** This installed package contains local fixes and patches. Upstream updates, running
`omp plugin upgrade`, `omp update`, or `npm update` can overwrite local installation patches. If updated,
re-verify or restore your configured extensions and sync scripts.

---

## Environment Variables

| Variable | Description |
|---|---|
| `OMP_CONFIG_PASS` | Encryption/decryption passphrase for headless automation |
| `OMP_CFG_CLOUD_TOKEN` | Primary Cloud / GitHub API token (gist scope) |
| `GITHUB_TOKEN` | Fallback GitHub API token |
| `OMP_CFG_ROOT` | Override path to agent directory (default: `~/.omp/agent`) |
| `OMP_HOME` | Override path to omp root (default: `~/.omp`) |

### Network troubleshooting

Gist/HTTP transports retry transient network failures (ECONNRESET, ETIMEDOUT, 429, 5xx) up to 3 times
with backoff; 4xx client errors fail immediately. Node's `fetch` ignores the OS proxy and `HTTPS_PROXY`
by default. On unstable routes to `api.github.com`, launch with:

```
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:<port>   # local proxy (HTTP or mixed port)
```

---

## Security Specification

- **Cipher**: AES-256-GCM authenticated encryption.
- **Key Derivation**: `scrypt` with 16-byte cryptographically secure random salt (`N=16384, r=8, p=1`).
- **Archive Wire Magic**: `OMPCFG1\0` header + 16B salt + 12B IV + 16B GCM auth tag + gzip payload.
- **File Mode**: Preserves executable and read/write bits with standard `0600` / `0700` safety.
