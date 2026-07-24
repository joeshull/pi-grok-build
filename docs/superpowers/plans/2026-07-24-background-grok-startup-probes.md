# Background Grok Startup Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove synchronous Grok CLI probes from Pi extension registration while preserving the PR’s model-output parser fix.

**Architecture:** Add an asynchronous child-process runner alongside the existing synchronous runner. Registration uses the existing fallback model immediately and schedules one asynchronous `grok models` probe for diagnostics only; explicit commands/tools keep their current synchronous behavior.

**Tech Stack:** TypeScript, Node `child_process`, `cross-spawn`, Node test runner, Pi extension API.

## Global Constraints

- Keep provider models fixed to the existing fallback for the current session.
- Do not re-register or mutate the provider after startup.
- Preserve the parser change that ignores `You are logged in...` prose.
- Preserve existing timeout, output-limit, failure-classification, and process-cleanup behavior.
- Run focused tests and a Pi startup timing smoke test before completion.

---

### Task 1: Commit the approved design

**Files:**
- Add: `docs/superpowers/specs/2026-07-24-background-grok-startup-probes-design.md`

- [ ] Run the repository pre-commit command if configured.
- [ ] Commit the design document with `git add docs/superpowers/specs/2026-07-24-background-grok-startup-probes-design.md && git commit -m "docs: design background Grok startup probes"`.

### Task 2: Add the asynchronous Grok command runner

**Files:**
- Modify: `src/grok-runner.ts`
- Modify: `src/index.ts`
- Test: `test/unit/grok-runner.test.ts`

**Interfaces:**
- Produce `runGrokCommandAsync(args: string[], options?: { cwd?: string; timeout?: number }): Promise<GrokRunResult>`.
- Produce `runGrokModelsAsync(options?: { cwd?: string }): Promise<GrokRunResult>`.
- Export both functions from `src/index.ts`.

- [ ] Add a spawned-child implementation that captures stdout/stderr, truncates output at the existing 500KB limit, applies the existing default/explicit timeout, classifies failures with `classifyGrokFailure`, emits the same diagnostics, and registers the child for teardown cleanup.
- [ ] Add a successful fake-`grok` test proving `models` runs asynchronously and returns model output without a `--version` preflight.
- [ ] Add a failing fake-`grok` test proving a nonzero exit returns `ok: false` with a classified error and does not reject the Promise.
- [ ] Run `npm run test:unit -- --test-name-pattern='runGrokModels|runGrokCommandAsync'` and expect all matching tests to pass.

### Task 3: Defer extension startup probing

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consume `runGrokModelsAsync` from `src/grok-runner.ts`.
- Keep `createGrokBuildExtension().register()` synchronous and provider registration immediate.

- [ ] Replace registration-time `validateGrokAuth()` and synchronous `runGrokModels()` calls with the fallback model list.
- [ ] Schedule one `runGrokModelsAsync()` call through `setImmediate` after provider registration.
- [ ] Log probe failures/auth failures as diagnostics and never mutate the provider model list.
- [ ] Keep explicit status/inspect/models commands and tools unchanged.
- [ ] Run the focused runner/parser tests again.

### Task 4: Verify startup behavior

**Files:**
- No additional files.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test:unit` and `npm run test:property`.
- [ ] Launch Pi with the extension and timing enabled using the existing local smoke command; confirm extension loading completes without waiting for synchronous model discovery.
- [ ] Review the diff, run pre-commit, and commit implementation changes.
