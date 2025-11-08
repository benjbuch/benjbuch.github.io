include ../artifacts/common.mk
.DEFAULT_GOAL := help  # GNU make
.MAIN: help            # BSD make

MAKEFLAGS += --silent

# --------------------------------------------------------------------
# Scripts
# --------------------------------------------------------------------
ARTIFACTS := python artifacts.py
S_DEPLOY  := scripts/publish_protocols.sh

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
	@printf "\n$(BOLD)Website Publishing Pipeline (GitHub Pages)$(RESET)\n\n"
	@printf "  Update site data and publish to GitHub Pages.\n\n"
	@printf "$(BLUE)Targets$(RESET):\n"
	@printf "  %-20s %s\n" "all"            "Update artifacts and deploy site"
	@printf "  %-20s %s\n" "publish"        "Alias for 'all'"
	@printf "\n"
	@printf "  %-20s %s\n" "update"         "Pull artifacts and commit changes"
	@printf "  %-20s %s\n" "commit-changes" "Commit tracked artifact changes"
	@printf "\n"
	@printf "  %-20s %s\n" "deploy"         "Build and deploy site to 'gh-pages'"
	@printf "  %-20s %s\n" "deploy-dry"     "Deploy with '--dry-run'"
	@printf "  %-20s %s\n" "deploy-force"   "Deploy with '--force-publish'"
	@printf "\n"
	@printf "  %-20s %s\n" "serve"          "Start Jekyll development server"
	@printf "  %-20s %s\n" "build"          "Build Jekyll site locally"
	@printf "\n"
	@printf "  %-20s %s\n" "status"         "Show artifact and git status"
	@printf "  %-20s %s\n" "help"           "Show this message"
	@printf "\n$(BLUE)Artifact management$(RESET):\n"
	@printf "  %-20s %s\n" "pull-artifacts" "Pull artifacts from shared directory"
	@printf "  %-20s %s\n" "push-artifacts" "Push artifacts to shared directory"
	@printf "  %-20s %s\n" "artifacts-status" "Show artifact status"
	@printf "\n$(BLUE)Examples$(RESET):\n"
	@printf "  make publish\n"
	@printf "  make deploy-dry\n"
	@printf "\n"

# --------------------------------------------------------------------
# All: Update artifacts and deploy
# --------------------------------------------------------------------
.PHONY: all
all: update deploy

# --------------------------------------------------------------------
# Update: Pull artifacts and commit tracked changes
# --------------------------------------------------------------------
.PHONY: update
update: pull-artifacts commit-changes

# --------------------------------------------------------------------
# Deploy: Build and publish site
# --------------------------------------------------------------------
.PHONY: deploy
deploy:
	@if [ ! -f "$(S_DEPLOY)" ]; then \
		$(ERR) "Deploy script not found: $(S_DEPLOY)"; \
		exit 1; \
	fi
	@$(INFO) "Running deployment script..."
	@bash $(S_DEPLOY)

.PHONY: deploy-dry
deploy-dry:
	@if [ ! -f "$(S_DEPLOY)" ]; then \
		$(ERR) "Deploy script not found: $(S_DEPLOY)"; \
		exit 1; \
	fi
	@$(INFO) "Running deployment script (dry-run)..."
	@bash $(S_DEPLOY) --dry-run

.PHONY: deploy-force
deploy-force:
	@if [ ! -f "$(S_DEPLOY)" ]; then \
		$(ERR) "Deploy script not found: $(S_DEPLOY)"; \
		exit 1; \
	fi
	@$(INFO) "Running deployment script (force publish)..."
	@bash $(S_DEPLOY) --force-publish

# --------------------------------------------------------------------
# Publish: Full pipeline (update + deploy)
# --------------------------------------------------------------------
.PHONY: publish
publish: update deploy
	@$(OK) "Published site with latest data"

# --------------------------------------------------------------------
# Status: Show artifact and git status
# --------------------------------------------------------------------
.PHONY: status
status: artifacts-status
	@$(HDR) "Repository status"
	@$(KV) "Branch:"  "$(SOURCE_BRANCH)"
	@$(KV) "Remote:"  "$(REMOTE)"
	$(PRINT_GIT_STATUS)
	@$(HDR) "Flags"
	$(call FLAG_BOOL,DRY_RUN)
	$(call FLAG_BOOL,FORCE_PUBLISH)
	@echo ""

# --------------------------------------------------------------------
# Jekyll local development
# --------------------------------------------------------------------
.PHONY: serve
serve:
	@$(INFO) "Starting Jekyll development server..."
	@bundle exec jekyll serve --livereload

.PHONY: build
build:
	@$(INFO) "Building Jekyll site..."
	@JEKYLL_ENV=production bundle exec jekyll build
	@$(OK) "Built site to _site/"
