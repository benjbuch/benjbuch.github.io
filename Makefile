# Makefile for website with artifact management and deployment

MAKEFLAGS += --silent

# --------------------------------------------------------------------
# Artifact manager
# --------------------------------------------------------------------
ARTIFACTS := python artifacts.py

# --------------------------------------------------------------------
# Deployment script
# --------------------------------------------------------------------
DEPLOY_SCRIPT := scripts/publish_protocols.sh

# --------------------------------------------------------------------
# Git settings
# --------------------------------------------------------------------
REMOTE := origin
SOURCE_BRANCH := $(shell git rev-parse --abbrev-ref HEAD)

# --------------------------------------------------------------------
# Colored, aligned logging
# --------------------------------------------------------------------
YELLOW  := \033[1;33m
GREEN   := \033[1;32m
RED     := \033[1;31m
BLUE    := \033[1;34m
RESET   := \033[0m

INFO = printf "$(YELLOW)[INFO] $(RESET)  %s\n"
OK   = printf "$(GREEN)[OK]   $(RESET)  %s\n"
ERR  = printf "$(RED)[ERROR]$(RESET)  %s\n"
WARN = printf "$(BLUE)[WARN] $(RESET)  %s\n"

# --------------------------------------------------------------------
# Default: update artifacts and deploy
# --------------------------------------------------------------------
.PHONY: all
all: update deploy

# --------------------------------------------------------------------
# Update: Pull artifacts and commit tracked changes
# --------------------------------------------------------------------
.PHONY: update
update: pull-artifacts commit-changes

.PHONY: pull-artifacts
pull-artifacts:
	@if [ -f artifacts.yaml ]; then \
		$(INFO) "Pulling artifacts..."; \
		$(ARTIFACTS) pull; \
	else \
		$(WARN) "No artifacts.yaml found, skipping pull"; \
	fi

.PHONY: commit-changes
commit-changes:
	@$(INFO) "Checking for changes to tracked files..."
	@git add .
	@if git diff --cached --quiet; then \
		$(INFO) "No changes to commit"; \
	else \
		git commit -m "Update data from artifacts ($$(date -Iseconds))" && \
		$(OK) "Committed changes to $(SOURCE_BRANCH)"; \
	fi

# --------------------------------------------------------------------
# Deploy: Build and publish site
# --------------------------------------------------------------------
.PHONY: deploy
deploy:
	@if [ ! -f "$(DEPLOY_SCRIPT)" ]; then \
		$(ERR) "Deploy script not found: $(DEPLOY_SCRIPT)"; \
		exit 1; \
	fi
	@$(INFO) "Running deployment script..."
	@bash $(DEPLOY_SCRIPT)

.PHONY: deploy-dry
deploy-dry:
	@if [ ! -f "$(DEPLOY_SCRIPT)" ]; then \
		$(ERR) "Deploy script not found: $(DEPLOY_SCRIPT)"; \
		exit 1; \
	fi
	@$(INFO) "Running deployment script (dry-run)..."
	@bash $(DEPLOY_SCRIPT) --dry-run

.PHONY: deploy-force
deploy-force:
	@if [ ! -f "$(DEPLOY_SCRIPT)" ]; then \
		$(ERR) "Deploy script not found: $(DEPLOY_SCRIPT)"; \
		exit 1; \
	fi
	@$(INFO) "Running deployment script (force publish)..."
	@bash $(DEPLOY_SCRIPT) --force-publish

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
status:
	@$(INFO) "Repository status:"
	@echo "  Branch:       $(SOURCE_BRANCH)"
	@echo "  Remote:       $(REMOTE)"
	@echo ""
	@if [ -f artifacts.yaml ]; then \
		$(INFO) "Artifact status:"; \
		$(ARTIFACTS) status; \
	else \
		$(WARN) "No artifacts.yaml found"; \
	fi
	@echo ""
	@$(INFO) "Git working tree:"
	@if [ -z "$$(git status --porcelain)" ]; then \
		$(OK) "Working tree clean"; \
	else \
		git status --short; \
	fi

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

# --------------------------------------------------------------------
# Help
# --------------------------------------------------------------------
.PHONY: help
help:
	@echo "Website deployment with artifact management"
	@echo ""
	@echo "Targets:"
	@echo "  all (default)    Update artifacts and deploy site"
	@echo "  publish          Same as 'all'"
	@echo ""
	@echo "  update           Pull artifacts and commit changes"
	@echo "  pull-artifacts   Pull artifacts from shared directory"
	@echo "  commit-changes   Commit tracked artifact changes"
	@echo ""
	@echo "  deploy           Build and deploy site to gh-pages"
	@echo "  deploy-dry       Deploy with --dry-run flag"
	@echo "  deploy-force     Deploy with --force-publish flag"
	@echo ""
	@echo "  serve            Start Jekyll development server"
	@echo "  build            Build Jekyll site locally"
	@echo ""
	@echo "  status           Show artifact and git status"
	@echo "  help             Show this message"
