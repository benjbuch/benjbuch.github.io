#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------------------------
# Jekyll site deployment to gh-pages
#
# Prerequisites: run 'make update' first to pull artifacts.
# --------------------------------------------------------------------

# CLI helpers: errors/warnings on stderr, "<prog>: error|warning: ..." format.
_prog=${0##*/}
warn() { printf '%s: warning: %s\n' "$_prog" "$*" >&2; }
die()  { printf '%s: error: %s\n'   "$_prog" "$*" >&2; exit "${2:-1}"; }

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

usage() {
  echo "usage: $_prog [--dry-run] [--force-publish]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force-publish) FORCE=1; shift ;;
    *) usage ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree has uncommitted changes; commit or stash first"
fi

if git ls-remote --exit-code "$REMOTE" "refs/heads/$SOURCE_BRANCH" &>/dev/null; then
  REMOTE_EXISTS=1
else
  REMOTE_EXISTS=0
fi

if [[ $FORCE -eq 1 ]]; then
  DRY_RUN=0
elif [[ $REMOTE_EXISTS -eq 0 ]]; then
  warn "remote branch '$SOURCE_BRANCH' not found on '$REMOTE'; switching to dry-run"
  DRY_RUN=1
fi

printf 'branch:  %s\n' "$SOURCE_BRANCH"
printf 'remote:  %s\n' "$([[ $REMOTE_EXISTS -eq 1 ]] && echo yes || echo no)"
printf 'dry-run: %s\n' "$([[ $DRY_RUN -eq 1 ]] && echo yes || echo no)"

BUILD_DIR="$(mktemp -d "/tmp/$(basename "$REPO_ROOT")-site.XXXXXX")"

if ! (cd "$REPO_ROOT" && JEKYLL_ENV=production bundle exec jekyll build --destination "$BUILD_DIR"); then
  die "jekyll build failed"
fi

git fetch "$REMOTE" "$DEPLOY_BRANCH":"$DEPLOY_BRANCH" 2>/dev/null || true

PAGES_WORKTREE="$(mktemp -d "/tmp/$(basename "$REPO_ROOT")-pages.XXXXXX")"
git worktree add "$PAGES_WORKTREE" "$DEPLOY_BRANCH"

rsync -av \
  --delete \
  --exclude ".git" \
  --exclude "README.md" \
  --exclude ".nojekyll" \
  "$BUILD_DIR"/ "$PAGES_WORKTREE"/

(
  cd "$PAGES_WORKTREE"
  git add -A

  echo
  git status --short
  echo

  if [[ $DRY_RUN -eq 1 ]]; then
    git diff --staged --stat
    echo
    echo "publish: dry-run (push '$SOURCE_BRANCH' to remote, or use 'make deploy-force')"
  else
    read -r -p "commit and push to $DEPLOY_BRANCH? [y/N] " reply
    if [[ "$reply" =~ ^[Yy]$ ]]; then
      if git commit -m "Publish site ($(date -Iseconds))"; then
        git push --force "$REMOTE" "$DEPLOY_BRANCH"
        echo "publish: $REMOTE/$DEPLOY_BRANCH updated"
      else
        echo "publish: no changes"
      fi
    else
      die "aborted"
    fi
  fi
)

git worktree remove --force "$PAGES_WORKTREE"
