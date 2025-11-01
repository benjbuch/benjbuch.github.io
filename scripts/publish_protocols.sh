#!/usr/bin/env bash
set -euo pipefail

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
ARTIFACTS_PATH="../lab-protocols/artifacts/public/"
REMOTE="origin"
DEPLOY_BRANCH="gh-pages"

# Directories to sync from artifacts repo
ARTIFACT_DIRS=("_data" "assets")
# Subdirectory name to use in destination repo
DEST_SUBDIR="protocols"

# --- Parse args -------------------------------------------------
usage() {
  echo "Usage: $0 [OPTIONS]"
  echo "Options:"
  echo "  --dry-run           Don't commit or push"
  echo "  --force-publish     Bypass branch safeguards"
  echo "  --artifacts PATH    Path to artifacts"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force-publish) FORCE=1; shift ;;
    --artifacts) ARTIFACTS_PATH="$2"; shift 2 ;;
    *) usage ;;
  esac
done

# --- Repo + branch info ----------------------------------------
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

# --- Decide on dry-run -----------------------------------------
if [[ $FORCE -eq 1 ]]; then
  DRY_RUN=0
  echo "[*] Force-publish requested"
elif [[ $REMOTE_EXISTS -eq 0 ]]; then
  echo "[*] Remote branch '$SOURCE_BRANCH' not found on '$REMOTE', switching to dry-run"
  DRY_RUN=1
fi

echo "[*] Current branch: $SOURCE_BRANCH (Remote exists: $REMOTE_EXISTS)"
echo "[*] Dry-run: $DRY_RUN"

# --- Check artifact source -------------------------------------
if [[ ! -d "$ARTIFACTS_PATH" ]]; then
  echo "[ERROR] Artifact source not found: $ARTIFACTS_PATH" >&2
  exit 1
fi

if [[ -d "$ARTIFACTS_PATH/.git" ]]; then
  echo "[*] Artifact repo status:"
  (cd "$ARTIFACTS_PATH" && git log -1 --oneline)
fi

# --- 1) PRIME WORKING TREE WITH ARTIFACTS ----------------------
echo ""
echo "[*] Copying artifacts to working tree..."

# Copy artifacts: update existing files AND add new files
# Do NOT delete files that exist in destination but not in source
sync_artifacts() {
  local src="$1"
  local dest="$2"
  if [[ -d "$src" ]]; then
    echo "    $src -> $dest"
    # First pass: add new files only
    rsync -av --ignore-existing "$src"/ "$dest"/ | grep -v "/$" || true
    # Second pass: update existing files
    rsync -av --existing "$src"/ "$dest"/ | grep -v "/$" || true
  fi
}

# Sync each artifact directory to its destination with subdirectory
for dir in "${ARTIFACT_DIRS[@]}"; do
  src_path="$ARTIFACTS_PATH/$dir"
  dest_path="$REPO_ROOT/$dir/$DEST_SUBDIR"
  
  # Create destination directory if it doesn't exist
  mkdir -p "$dest_path"
  
  # Sync artifacts
  sync_artifacts "$src_path" "$dest_path"
done


# --- 2) COMMIT TRACKED ARTIFACTS (e.g., YAML files) ------------
echo ""
echo "[*] Committing tracked artifacts to $SOURCE_BRANCH..."
git add .
if git diff --cached --quiet; then
  echo "[*] No changes to tracked artifacts"
else
  git commit -m "Update $DEST_SUBDIR data from artifacts ($(date -Iseconds))"
  echo "[*] Committed changes to tracked artifacts"
fi

# --- 3) BUILD INTO TMP OUTSIDE REPO ----------------------------
BUILD_DIR="$(mktemp -d "/tmp/$(basename "$REPO_ROOT")-site.XXXXXX")"
echo ""
echo "[*] Building Jekyll site into: $BUILD_DIR"

if ! (cd "$REPO_ROOT" && JEKYLL_ENV=production bundle exec jekyll build --destination "$BUILD_DIR"); then
  echo "[ERROR] Jekyll build failed" >&2
  exit 1
fi

# --- 4) DEPLOY TO `$DEPLOY_BRANCH` WITHOUT SWITCHING --------------------------
echo ""
echo "[*] Deploying to $DEPLOY_BRANCH branch..."

# Fetch latest gh-pages
git fetch "$REMOTE" "$DEPLOY_BRANCH":"$DEPLOY_BRANCH" 2>/dev/null || true

# Create a temporary worktree for gh-pages
PAGES_WORKTREE="$(mktemp -d "/tmp/$(basename "$REPO_ROOT")-pages.XXXXXX")"
git worktree add "$PAGES_WORKTREE" "$DEPLOY_BRANCH"

# Deploy built site to the worktree
rsync -av \
  --delete \
  --exclude ".git" \
  --exclude "README.md" \
  --exclude ".nojekyll" \
  "$BUILD_DIR"/ "$PAGES_WORKTREE"/

# Commit and push from the worktree
(
  cd "$PAGES_WORKTREE"
  git add -A
  
  echo ""
  echo "========================================================================"
  git status
  echo "========================================================================"
  
  if [[ $DRY_RUN -eq 1 ]]; then
    echo ""
    echo "[*] Dry-run mode: Changes staged but not committed"
    git diff --staged --stat
    echo ""
    echo "[*] To publish, push current branch to remote first or use --force-publish"
  else
    echo ""
    echo "[*] Changes ready to commit and push to $DEPLOY_BRANCH"
    echo ""
    read -p "Continue with commit and push? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      if git commit -m "Publish site ($(date -Iseconds))"; then
        echo ""
        echo "[*] Pushing to $REMOTE/$DEPLOY_BRANCH..."
        git push --force "$REMOTE" "$DEPLOY_BRANCH"
        echo "[*] Published to $DEPLOY_BRANCH"
      else
        echo "[*] No changes to publish"
      fi
    else
      echo "[*] Aborted by user"
      exit 1
    fi
  fi
)

# Clean up worktree
git worktree remove "$PAGES_WORKTREE"

echo ""
echo "[*] Done"