# Developer shortcuts. Run `make` (or `make help`) to list the targets.
#
# dbmate reads DATABASE_URL from .env automatically and uses db/migrations/ by default.
# Extra dbmate flags can be passed with DBMATE_FLAGS, e.g.:
#   make db-migrate DBMATE_FLAGS=--no-dump-schema

DBMATE       ?= dbmate
DBMATE_FLAGS ?=

.DEFAULT_GOAL := help

.PHONY: help db-up db-down db-new db-migrate db-rollback db-status db-reset db-psql

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

db-up: ## Start PostgreSQL and wait until it is healthy
	docker compose up -d --wait

db-down: ## Stop PostgreSQL (data is kept)
	docker compose down

db-new: ## Create a new migration: make db-new name=add_something
	@test -n "$(name)" || (echo "usage: make db-new name=<migration_name>" && exit 1)
	$(DBMATE) $(DBMATE_FLAGS) new $(name)

db-migrate: ## Apply all pending migrations
	$(DBMATE) $(DBMATE_FLAGS) up

db-rollback: ## Roll back the most recent migration
	$(DBMATE) $(DBMATE_FLAGS) rollback

db-status: ## Show applied and pending migrations
	$(DBMATE) $(DBMATE_FLAGS) status

db-reset: ## DESTRUCTIVE: delete the database volume, start fresh and migrate
	docker compose down -v
	docker compose up -d --wait
	$(DBMATE) $(DBMATE_FLAGS) up

db-psql: ## Open a psql shell inside the database container
	docker compose exec db sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'
