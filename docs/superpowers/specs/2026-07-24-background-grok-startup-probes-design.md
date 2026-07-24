# Background Grok Startup Probes

Date: 2026-07-24

## Goal

Remove Grok CLI authentication/model discovery from Pi extension registration so the extension can register its provider without waiting on synchronous `grok models` subprocesses.

## Design

`createGrokBuildExtension().register()` will register the provider immediately with the existing fallback Grok model. It will not call `validateGrokAuth()` or synchronous `runGrokModels()` during registration.

A deferred startup task will launch an asynchronous `grok models` subprocess after registration. The task will use the result for diagnostics only: failures remain warnings, and successful discovery will not mutate the already-registered provider model list. Existing command and tool handlers retain their synchronous behavior because they are explicit user actions rather than startup work.

The asynchronous runner will capture stdout/stderr, enforce the existing timeout/output limits, classify failures consistently with the synchronous runner, and clean up its child process on extension teardown.

## Compatibility

The existing parser behavior, including the PR fix that ignores Grok CLI login-status prose, remains unchanged. The provider keeps the fallback model for the current session; no provider re-registration or mid-session model mutation is introduced.

## Verification

- Unit-test the asynchronous runner with a temporary fake `grok` executable, including successful output and failure handling.
- Run the focused unit/property tests covering the runner and model parser.
- Smoke-test Pi startup with timing enabled and confirm registration no longer waits for the probe process.
