#!/usr/bin/env bash
set -euo pipefail

# RemoteWiz Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/raiansar/remotewiz/main/install.sh | bash

REPO_URL="https://github.com/raiansar/remotewiz.git"
INSTALL_DIR="${REMOTEWIZ_HOME:-$HOME/.remote-wiz}"
BIN_LINK="/usr/local/bin/remotewiz"

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
else
  ok "Existing .env preserved"
fi

# ── Symlink ──────────────────────────────────────────────────────────────────

chmod +x "$INSTALL_DIR/bin/remotewiz"

if [ -L "$BIN_LINK" ] || [ -e "$BIN_LINK" ]; then
  rm -f "$BIN_LINK" 2>/dev/null || true
fi

if ln -sf "$INSTALL_DIR/bin/remotewiz" "$BIN_LINK" 2>/dev/null; then
  ok "Linked 'remotewiz' command to ${BIN_LINK}"
else
  warn "Could not link to ${BIN_LINK} (permission denied)"
  echo ""
  info "Try one of:"
  echo "    sudo ln -sf \"$INSTALL_DIR/bin/remotewiz\" $BIN_LINK"
  echo "    export PATH=\"$INSTALL_DIR/bin:\$PATH\"  # add to ~/.zshrc or ~/.bashrc"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
printf "  ${GREEN}${BOLD}Installation complete!${NC}\n"
echo ""
info "Next steps:"
echo "  1. Edit ${INSTALL_DIR}/.env  — add DISCORD_TOKEN, ANTHROPIC_API_KEY"
echo "  2. Edit ${INSTALL_DIR}/config.json — add your project paths"
echo "  3. Run: remotewiz"
echo ""
