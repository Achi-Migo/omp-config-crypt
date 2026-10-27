# omp-config-crypt (v0.5.0)

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
   - **User Extensions**: Full recursive synchronization of `~/.omp/extensions/**` (e.g. `agy.js`).
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

# Rollback to previous configuration snapshot
npx omp-config-crypt rollback
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

```text
/config-export [out.enc]
/config-import <file.enc> [--dry-run]
/config-push gist:new
/config-push gist:<id>
/config-push https://…
/config-pull gist:<id> [--dry-run]
/config-pull https://… [--dry-run]
/config-rollback
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `OMP_CONFIG_PASS` | Encryption/decryption passphrase for headless automation |
| `OMP_CFG_CLOUD_TOKEN` | Primary Cloud / GitHub API token (gist scope) |
| `GITHUB_TOKEN` | Fallback GitHub API token |
| `OMP_CFG_ROOT` | Override path to agent directory (default: `~/.omp/agent`) |
| `OMP_HOME` | Override path to omp root (default: `~/.omp`) |

---

## Security Specification

- **Cipher**: AES-256-GCM authenticated encryption.
- **Key Derivation**: `scrypt` with 16-byte cryptographically secure random salt (`N=16384, r=8, p=1`).
- **Archive Wire Magic**: `OMPCFG1\0` header + 16B salt + 12B IV + 16B GCM auth tag + gzip payload.
- **File Mode**: Preserves executable and read/write bits with standard `0600` / `0700` safety.
