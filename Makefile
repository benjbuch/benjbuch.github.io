# Makefile for website with artifact management and deployment

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
# Colored, aligned logging
# --------------------------------------------------------------------
YELLOW  := \033[1;33m
GREEN   := \033[1;32m
RED     := \033[1;31m
BLUE    := \033[1;34m
BOLD    := \033[1m
RESET   := \033[0m

INFO = printf "$(YELLOW)[INFO] $(RESET)  %s\n"
OK   = printf "$(GREEN)[OK]   $(RESET)  %s\n"
ERR  = printf "$(RED)[ERROR]$(RESET)  %s\n"
WARN = printf "$(BLUE)[WARN] $(RESET)  %s\n"

COLORIZE_TAGS = awk '\
  {gsub(/\[OK\]/,      "$(GREEN)[OK]$(RESET)");} \
  {gsub(/\[UPDATE\]/,  "$(YELLOW)[UPDATE]$(RESET)");} \
  {gsub(/\[CREATE\]/,  "$(YELLOW)[CREATE]$(RESET)");} \
  {gsub(/\[MISSING\]/, "$(RED)[MISSING]$(RESET)");} \
  {gsub(/\[INFO\]/,    "$(YELLOW)[INFO]$(RESET)");} \
  {gsub(/\[ERROR\]/,   "$(RED)[ERROR]$(RESET)");} \
  {print} \
'

HDR = printf "\n$(BLUE)%s$(RESET)\n"
KV  = printf "  %-14s %s\n"

# Boolean flag: prints "enabled"/"disabled" based on common truthy values
define FLAG_BOOL
	@$(KV) "$(1):" "$(if $(filter true 1 yes on,$($(1))),enabled,disabled)"
endef

# Enum/string flag: prints the raw value (if empty, prints "—")
define FLAG_ENUM
	@$(KV) "$(1):" "$(if $($(1)),$($(1)),—)"
endef

# Git working tree helper
define PRINT_GIT_STATUS
	@$(HDR) "Git working tree"
	@if [ -z "$$(git status --porcelain 2>/dev/null)" ]; then \
		$(OK) "Working tree clean"; \
	else \
		git status --short; \
	fi
endef

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

.PHONY: artifacts-status
artifacts-status:
	@$(HDR) "Artifact status"
	@if [ -f artifacts.yaml ]; then \
		$(ARTIFACTS) status | $(COLORIZE_TAGS); \
	else \
		$(WARN) "No 'artifacts.yaml' found"; \
	fi

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
