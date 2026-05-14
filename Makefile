.DEFAULT_GOAL := help  # GNU make
.MAIN: help            # BSD make

MAKEFLAGS += --silent

# CLI helpers: errors/warnings on stderr, "<prog>: error|warning: ..." format.
err  = printf "error: %s\n"   "$(1)" >&2
warn = printf "warning: %s\n" "$(1)" >&2

# --------------------------------------------------------------------
# Scripts
# --------------------------------------------------------------------
ARTIFACTS := python3 artifacts.py
S_DEPLOY  := scripts/publish_protocols.sh

# --------------------------------------------------------------------
# Sibling lab-protocols repo (direct source for public PDFs + metadata)
# --------------------------------------------------------------------
LAB_PROTOCOLS     := ../lab-protocols
LP_PDF_SRC        := $(LAB_PROTOCOLS)/output/public/protocol
LP_ARTIFACTS_SRC  := $(LAB_PROTOCOLS)/output/artifacts
PDF_DST           := assets/protocols/pdf
DATA_DST          := _data/protocols
RECIPES_DST       := assets/protocols/recipes.xml

# --------------------------------------------------------------------
# Git settings
# --------------------------------------------------------------------
REMOTE := origin
SOURCE_BRANCH := $(shell git rev-parse --abbrev-ref HEAD)

# --------------------------------------------------------------------
# Help
# --------------------------------------------------------------------
.PHONY: help
help:
	@printf 'Website Publishing Pipeline (GitHub Pages)\n'
	@printf '  Update site data and publish to GitHub Pages.\n\n'
	@printf 'Targets:\n'
	@printf '  %-16s %s\n' "all"            "Update artifacts and deploy site"
	@printf '  %-16s %s\n' "publish"        "Alias for 'all'"
	@printf '  %-16s %s\n' "update"         "Pull artifacts and commit changes"
	@printf '  %-16s %s\n' "commit-changes" "Commit tracked artifact changes"
	@printf '  %-16s %s\n' "deploy"         "Build and deploy site to 'gh-pages'"
	@printf '  %-16s %s\n' "deploy-dry"     "Deploy with --dry-run"
	@printf '  %-16s %s\n' "deploy-force"   "Deploy with --force-publish"
	@printf '  %-16s %s\n' "serve"          "Start Jekyll development server"
	@printf '  %-16s %s\n' "build"          "Build Jekyll site locally"
	@printf '  %-16s %s\n' "status"         "Show artifact and git status"
	@printf '  %-16s %s\n' "help"           "Show this message"
	@printf '\nArtifacts:\n'
	@printf '  %-16s %s\n' "pull"           "Sync protocols from ../lab-protocols + pull other artifacts"
	@printf '  %-16s %s\n' "pull-protocols" "Sync public PDFs/metadata from ../lab-protocols only"
	@printf '  %-16s %s\n' "push"           "Push artifacts to shared directory"
	@printf '\nExamples:\n'
	@printf '  make publish\n'
	@printf '  make deploy-dry\n'
	@printf '\n'

# --------------------------------------------------------------------
# All: update + deploy
# --------------------------------------------------------------------
.PHONY: all
all: update deploy

.PHONY: publish
publish: update deploy

# --------------------------------------------------------------------
# Artifacts (delegates to ./artifacts.py against artifacts.yaml)
# --------------------------------------------------------------------
.PHONY: pull pull-protocols push
pull: pull-protocols
	@$(ARTIFACTS) pull

# Mirror public protocol PDFs + metadata + recipes from the sibling
# lab-protocols repo. PDFs are mirrored (rsync --delete) so withdrawn
# protocols disappear from the site; metadata files are copied
# individually to avoid touching curated siblings (e.g. chapters.yml).
pull-protocols:
	@[ -d "$(LP_PDF_SRC)" ] || { $(call err,not found: $(LP_PDF_SRC) (run 'make typeset' in lab-protocols)); exit 1; }
	@[ -d "$(LP_ARTIFACTS_SRC)" ] || { $(call err,not found: $(LP_ARTIFACTS_SRC) (run 'make merge' in lab-protocols)); exit 1; }
	@mkdir -p "$(PDF_DST)" "$(DATA_DST)" "$(dir $(RECIPES_DST))"
	@rsync -a --delete --include='*.pdf' --exclude='*' "$(LP_PDF_SRC)/" "$(PDF_DST)/"
	@for f in summary.yml hash.yml history.yml; do \
		[ -f "$(LP_ARTIFACTS_SRC)/$$f" ] || { $(call err,missing artifact: $$f); exit 1; }; \
		cp "$(LP_ARTIFACTS_SRC)/$$f" "$(DATA_DST)/$$f"; \
	done
	@[ -f "$(LP_ARTIFACTS_SRC)/recipes.xml" ] || { $(call err,missing artifact: recipes.xml); exit 1; }
	@cp "$(LP_ARTIFACTS_SRC)/recipes.xml" "$(RECIPES_DST)"
	@printf 'pull-protocols: synced from %s\n' "$(LAB_PROTOCOLS)"

push:
	@$(ARTIFACTS) push

# --------------------------------------------------------------------
# Update: pull artifacts and commit tracked changes
# --------------------------------------------------------------------
.PHONY: update
update: pull commit-changes

.PHONY: commit-changes
commit-changes:
	@if [ -n "$$(git status --porcelain 2>/dev/null)" ]; then \
		git status --short; \
		read -r -p "commit these changes? [y/N] " r; \
		if [ "$$r" = "y" ] || [ "$$r" = "Y" ]; then \
			git add -A && git commit -m "Update artifacts ($$(date -Iseconds))"; \
		else \
			$(call err,aborted); exit 1; \
		fi; \
	else \
		echo 'commit-changes: clean'; \
	fi

# --------------------------------------------------------------------
# Deploy: build and publish site
# --------------------------------------------------------------------
.PHONY: deploy
deploy:
	@[ -f "$(S_DEPLOY)" ] || { $(call err,deploy script not found: $(S_DEPLOY)); exit 1; }
	@bash $(S_DEPLOY)

.PHONY: deploy-dry
deploy-dry:
	@[ -f "$(S_DEPLOY)" ] || { $(call err,deploy script not found: $(S_DEPLOY)); exit 1; }
	@bash $(S_DEPLOY) --dry-run

.PHONY: deploy-force
deploy-force:
	@[ -f "$(S_DEPLOY)" ] || { $(call err,deploy script not found: $(S_DEPLOY)); exit 1; }
	@bash $(S_DEPLOY) --force-publish

# --------------------------------------------------------------------
# Status
# --------------------------------------------------------------------
.PHONY: status
status:
	@printf 'branch:  %s\n' "$(SOURCE_BRANCH)"
	@printf 'remote:  %s\n' "$(REMOTE)"
	@printf 'dry-run: %s\n' "$(if $(filter true 1 yes on,$(DRY_RUN)),yes,no)"
	@printf 'force:   %s\n' "$(if $(filter true 1 yes on,$(FORCE_PUBLISH)),yes,no)"
	@echo
	@$(ARTIFACTS) status
	@echo
	@if [ -z "$$(git status --porcelain 2>/dev/null)" ]; then \
		echo 'git: clean'; \
	else \
		echo 'git:'; git status --short | sed 's/^/  /'; \
	fi

# --------------------------------------------------------------------
# Jekyll local development
# --------------------------------------------------------------------
.PHONY: serve
serve:
	@bundle exec jekyll serve --livereload

.PHONY: build
build:
	@JEKYLL_ENV=production bundle exec jekyll build
