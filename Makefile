# Makefile for Letta Code

# Check if bun is available
BUN := $(shell command -v bun 2> /dev/null)

.PHONY: all help install build dev lint fix typecheck check clean

# Default target
all: install build

help:
	@echo "Letta Code Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make install    Install dependencies using bun"
	@echo "  make build      Build the project (generates letta.js)"
	@echo "  make dev        Run the CLI in development mode"
	@echo "  make lint       Run linter (Biome)"
	@echo "  make fix        Fix linting issues automatically"
	@echo "  make typecheck  Run TypeScript type checking"
	@echo "  make check      Run all checks (lint + typecheck)"
	@echo "  make clean      Clean build artifacts"
	@echo ""
	@echo "Note: You need 'bun' installed and in your PATH."

check-bun:
ifndef BUN
	$(error "bun is not installed or not in PATH. Please install bun (https://bun.sh) and ensure it is in your PATH")
endif

install: check-bun
	bun install

build: check-bun
	bun run build

dev: check-bun
	LETTA_BASE_URL="http://localhost:8283" bun run dev -- --model openai/gpt-4o-mini

lint: check-bun
	bun run lint

fix: check-bun
	bun run fix

typecheck: check-bun
	bun run typecheck

check: check-bun
	bun run check

clean:
	rm -f letta.js
