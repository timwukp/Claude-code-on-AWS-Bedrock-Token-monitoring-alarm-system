# Token Usage Monitoring System — developer workflow
# Run `make help` for the list of targets.

ENV ?= dev

.PHONY: help install install-infra install-backend install-frontend \
        test test-backend build build-frontend synth diff deploy deploy-frontend \
        destroy clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: install-infra install-backend install-frontend ## Install all dependencies

install-infra: ## Install CDK app dependencies
	cd infra && npm install

install-backend: ## Install backend (Lambda) dependencies
	cd backend && npm install

install-frontend: ## Install frontend dependencies
	cd frontend && npm install

test: test-backend ## Run all unit tests

test-backend: ## Run backend Jest tests
	cd backend && npm test

build: ## Type-check backend + build frontend
	cd backend && npx tsc --noEmit
	cd frontend && npm run build

build-frontend: ## Build the frontend SPA
	cd frontend && npm run build

synth: ## CDK synth all stacks (needs infra/lib/config/$(ENV).json)
	cd infra && npx cdk synth --context env=$(ENV)

diff: ## CDK diff against the deployed stacks
	cd infra && npx cdk diff --all --context env=$(ENV)

deploy: ## Deploy all stacks to AWS
	cd infra && npx cdk deploy --all --require-approval never --context env=$(ENV)

deploy-frontend: ## Build + publish the SPA to S3/CloudFront
	./scripts/deploy-frontend.sh $(ENV)

destroy: ## Tear down all stacks (data buckets/tables are RETAINed — delete manually)
	cd infra && npx cdk destroy --all --context env=$(ENV)

clean: ## Remove build artifacts and dependencies
	rm -rf infra/cdk.out infra/node_modules backend/node_modules backend/dist \
	       frontend/node_modules frontend/dist
