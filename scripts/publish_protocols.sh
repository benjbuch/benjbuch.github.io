#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------------------------
# Jekyll site deployment to gh-pages
# 
# Prerequisites: Run 'make update' first to pull artifacts
# --------------------------------------------------------------------

# Trap to ensure cleanup
cleanup() {
  local exit_code=$?
  [[ -n "${BUILD_DIR:-}" ]] && rm -rf "$BUILD_DIR"
  [[ -n "${PAGES_WORKTREE:-}" ]] && git worktree remove --force "$PAGES_WORKTREE" 2>/dev/null || true
  exit $exit_code
}
trap cleanup EXIT INT TERM

DRY_RUN=0
FORCE=0
REMOTE="origin"
DEPLOY_BRANCH="gh-pages"

# --------------------------------------------------------------------
# Parse arguments
# --------------------------------------------------------------------
usage() {
  echo "Usage: $0 [OPTIONS]"
  echo "Options:"
  echo "  --dry-run           Don't commit or push"
  echo "  --force-publish     Bypass branch safeguards"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force-publish) FORCE=1; shift ;;
    *) usage ;;
  esac
done

# --------------------------------------------------------------------
# Repository setup
# --------------------------------------------------------------------
REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Verify working tree is clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[ERROR] Working tree has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

# Check if current branch exists on remote
if git ls-remote --exit-code "$REMOTE" "refs/heads/$SOURCE_BRANCH" &>/dev/null; then
  REMOTE_EXISTS=1
else
  REMOTE_EXISTS=0
fi

# --------------------------------------------------------------------
# Decide on dry-run mode
# --------------------------------------------------------------------
if [[ $FORCE -eq 1 ]]; then
  DRY_RUN=0
  echo "[INFO] Force-publish requested"
elif [[ $REMOTE_EXISTS -eq 0 ]]; then
  echo "[INFO] Remote branch '$SOURCE_BRANCH' not found on '$REMOTE'"
  echo "[INFO] Switching to dry-run mode"
  DRY_RUN=1
fi

echo "[INFO] Current branch: $SOURCE_BRANCH"
echo "[INFO] Remote exists: $REMOTE_EXISTS"
echo "[INFO] Dry-run: $DRY_RUN"
echo ""

# --------------------------------------------------------------------
# Build Jekyll site
# --------------------------------------------------------------------
BUILD_DIR="$(mktemp -d "/tmp/$(basename "$REPO_ROOT")-site.XXXXXX")"
echo "[INFO] Building Jekyll site into: $BUILD_DIR"

if ! (cd "$REPO_ROOT" && JEKYLL_ENV=production bundle exec jekyll build --destination "$BUILD_DIR"); then
  echo "[ERROR] Jekyll build failed" >&2
  exit 1
fi

echo "[OK] Jekyll build complete"
echo ""

# --------------------------------------------------------------------
# Deploy to gh-pages branch
# --------------------------------------------------------------------
echo "[INFO] Deploying to $DEPLOY_BRANCH branch..."

# Fetch latest gh-pages
git fetch "$REMOTE" "$DEPLOY_BRANCH":"$DEPLOY_BRANCH" 2>/dev/null || true

# Create temporary worktree for gh-pages
PAGES_WORKTREE="$(mktemp -d "/tmp/$(basename "$REPO_ROOT")-pages.XXXXXX")"
git worktree add "$PAGES_WORKTREE" "$DEPLOY_BRANCH"

# Sync built site to worktree
rsync -av \
  --delete \
  --exclude ".git" \
  --exclude "README.md" \
  --exclude ".nojekyll" \
  "$BUILD_DIR"/ "$PAGES_WORKTREE"/

# Commit and push from worktree
(
  cd "$PAGES_WORKTREE"
  git add -A
  
  echo ""
  echo "========================================================================"
  git status
  echo "========================================================================"
  echo ""
  
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[INFO] Dry-run mode: Changes staged but not committed"
    echo ""
    git diff --staged --stat
    echo ""
    echo "[INFO] To publish, push '$SOURCE_BRANCH' to remote first"
    echo "[INFO] Or use: make deploy-force"
  else
    echo "[INFO] Changes ready to commit and push to $DEPLOY_BRANCH"
    echo ""
    read -p "Continue with commit and push? [y/N] " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      if git commit -m "Publish site ($(date -Iseconds))"; then
        echo ""
        echo "[INFO] Pushing to $REMOTE/$DEPLOY_BRANCH..."
        git push --force "$REMOTE" "$DEPLOY_BRANCH"
        echo "[OK] Published to $DEPLOY_BRANCH"
      else
        echo "[INFO] No changes to publish"
      fi
    else
      echo "[INFO] Aborted by user"
      exit 1
    fi
  fi
)

# Clean up worktree
git worktree remove --force "$PAGES_WORKTREE"

echo ""
echo "[OK] Done"
