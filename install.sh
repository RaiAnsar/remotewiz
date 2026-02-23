#!/usr/bin/env bash
set -euo pipefail

# RemoteWiz Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash

REPO_URL="https://github.com/raiansar/remotewiz.git"
INSTALL_DIR="${REMOTEWIZ_HOME:-$HOME/.remote-wiz}"

# ── Helpers ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "  ${BOLD}%s${NC}\n" "$*"; }
ok()    { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
warn()  { printf "  ${YELLOW}!${NC} %s\n" "$*"; }
fail()  { printf "  ${RED}✗ %s${NC}\n" "$*"; exit 1; }

# ── Banner ───────────────────────────────────────────────────────────────────

echo ""
printf "  ${BOLD}RemoteWiz Installer${NC}\n"
echo "  ===================="
echo ""

# ── Prerequisite Checks ─────────────────────────────────────────────────────

info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || fail "node is not installed (v22+ required). Install from https://nodejs.org"
NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "node v22+ required (found v${NODE_VERSION})"
fi
ok "node v${NODE_VERSION}"

command -v npm >/dev/null 2>&1 || fail "npm is not installed"
NPM_VERSION=$(npm -v)
ok "npm ${NPM_VERSION}"

command -v git >/dev/null 2>&1 || fail "git is not installed"
GIT_VERSION=$(git --version | awk '{print $3}')
ok "git ${GIT_VERSION}"

command -v claude >/dev/null 2>&1 || warn "claude CLI not found — install it before running RemoteWiz"
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI found"
fi

echo ""

# ── Install / Update ────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only || fail "git pull failed — resolve conflicts manually in $INSTALL_DIR"
  ok "Updated to latest version"
else
  info "Installing to ${INSTALL_DIR}..."
  git clone "$REPO_URL" "$INSTALL_DIR" || fail "git clone failed"
  ok "Cloned repository"
fi

cd "$INSTALL_DIR"

# ── Build ────────────────────────────────────────────────────────────────────

info "Installing dependencies..."
npm install --no-fund --no-audit 2>&1 | tail -1
ok "Dependencies installed"

info "Building..."
npm run build 2>&1 | tail -1
ok "Build complete"

echo ""

# ── Environment Setup ────────────────────────────────────────────────────────

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"

  # Generate a random WEB_AUTH_TOKEN
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/^WEB_AUTH_TOKEN=$/WEB_AUTH_TOKEN=${TOKEN}/" "$INSTALL_DIR/.env"
  else
    sed -i "s/^WEB_AUTH_TOKEN=$/WEB_AUTH_TOKEN=${TOKEN}/" "$INSTALL_DIR/.env"
  fi

  ok "Generated WEB_AUTH_TOKEN (saved to .env)"

  # Auto-detect ANTHROPIC_API_KEY
  DETECTED_KEY=""
  DETECTED_SOURCE=""

  # 1. Environment variable
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    DETECTED_KEY="$ANTHROPIC_API_KEY"
    DETECTED_SOURCE="environment variable"
  fi

  # 2. macOS keychain (Claude CLI OAuth token)
  if [ -z "$DETECTED_KEY" ] && [[ "$OSTYPE" == "darwin"* ]]; then
    KEYCHAIN_DATA=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
    if [ -n "$KEYCHAIN_DATA" ]; then
      OAUTH_TOKEN=$(node -e "
        try {
          const d = JSON.parse(process.argv[1]);
          const t = d.claudeAiOauth && d.claudeAiOauth.accessToken;
          if (t) console.log(t);
        } catch {}
      " "$KEYCHAIN_DATA" 2>/dev/null || true)
      if [ -n "$OAUTH_TOKEN" ]; then
        DETECTED_KEY="$OAUTH_TOKEN"
        DETECTED_SOURCE="Claude CLI (keychain)"
      fi
    fi
  fi

  # 3. Shell rc files
  if [ -z "$DETECTED_KEY" ]; then
    for rc_file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zprofile" "$HOME/.profile"; do
      if [ -f "$rc_file" ]; then
        found=$(grep -E "^export ANTHROPIC_API_KEY=" "$rc_file" 2>/dev/null | head -1 | sed "s/^export ANTHROPIC_API_KEY=[\"']*//" | sed "s/[\"']*$//" || true)
        if [ -n "$found" ]; then
          DETECTED_KEY="$found"
          DETECTED_SOURCE="$(basename "$rc_file")"
          break
        fi
      fi
    done
  fi

  if [ -n "$DETECTED_KEY" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/^ANTHROPIC_API_KEY=$/ANTHROPIC_API_KEY=${DETECTED_KEY}/" "$INSTALL_DIR/.env"
    else
      sed -i "s/^ANTHROPIC_API_KEY=$/ANTHROPIC_API_KEY=${DETECTED_KEY}/" "$INSTALL_DIR/.env"
    fi
    ok "Auto-detected ANTHROPIC_API_KEY from ${DETECTED_SOURCE}"
  fi
else
  ok "Existing .env preserved"
fi

# ── PATH Setup ───────────────────────────────────────────────────────────────

chmod +x "$INSTALL_DIR/bin/remotewiz"
chmod +x "$INSTALL_DIR/bin/remotewiz-configure"

LINKED=false

# Strategy 1: ~/.local/bin (no sudo, XDG standard)
LOCAL_BIN="$HOME/.local/bin"
if [ -d "$LOCAL_BIN" ] || mkdir -p "$LOCAL_BIN" 2>/dev/null; then
  ln -sf "$INSTALL_DIR/bin/remotewiz" "$LOCAL_BIN/remotewiz" 2>/dev/null && LINKED=true
fi

# Strategy 2: /usr/local/bin (needs write access)
if [ "$LINKED" = false ]; then
  ln -sf "$INSTALL_DIR/bin/remotewiz" /usr/local/bin/remotewiz 2>/dev/null && LINKED=true
fi

if [ "$LINKED" = true ]; then
  # Determine where it landed
  LINK_PATH="$LOCAL_BIN/remotewiz"
  [ -L "/usr/local/bin/remotewiz" ] && LINK_PATH="/usr/local/bin/remotewiz"
  ok "Linked 'remotewiz' → ${LINK_PATH}"

  # Ensure ~/.local/bin is in PATH for current and future shells
  if [ "$LINK_PATH" = "$LOCAL_BIN/remotewiz" ]; then
    case ":$PATH:" in
      *":$LOCAL_BIN:"*) ;;  # already in PATH
      *)
        # Detect shell rc file
        SHELL_RC=""
        if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
          SHELL_RC="$HOME/.zshrc"
        elif [ -f "$HOME/.bashrc" ]; then
          SHELL_RC="$HOME/.bashrc"
        elif [ -f "$HOME/.bash_profile" ]; then
          SHELL_RC="$HOME/.bash_profile"
        fi

        if [ -n "$SHELL_RC" ]; then
          if ! grep -q '\.local/bin' "$SHELL_RC" 2>/dev/null; then
            printf '\n# Added by RemoteWiz installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$SHELL_RC"
            ok "Added ~/.local/bin to PATH in $(basename "$SHELL_RC")"
          fi
        fi

        export PATH="$LOCAL_BIN:$PATH"
        ;;
    esac
  fi
else
  warn "Could not link remotewiz to PATH"
  echo ""
  info "Run one of these manually:"
  echo "    sudo ln -sf \"$INSTALL_DIR/bin/remotewiz\" /usr/local/bin/remotewiz"
  echo "    export PATH=\"$INSTALL_DIR/bin:\$PATH\"  # add to ~/.zshrc or ~/.bashrc"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
printf "  ${GREEN}${BOLD}Installation complete!${NC}\n"
echo ""
info "Next steps:"
echo "  1. Run: remotewiz configure    — interactive setup wizard"
echo "  2. Or edit manually: ${INSTALL_DIR}/.env + config.json"
echo "  3. Start: remotewiz"
echo ""
