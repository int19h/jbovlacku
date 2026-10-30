# Agent instructions

Use the [development guide](docs/development.md) for workspace, tooling, tests, and review requirements.
The [format specification](docs/format.md) and [frontend specification](docs/frontend.md) define target behavior.
The [README](README.md) describes the implemented scope. Do not claim that a target feature exists before its tests pass.

## Scope and shared files

Read the task authorization before you edit files or operate a service.
On this VM, keep implementation in the assigned worktree under `/build/jbovlacku/worktrees`.
Use task-specific scratch directories under `/build/jbovlacku`. Delete only exact directories that belong to the current task.
Do not delete unrelated files, sibling worktrees, shared caches, or other projects.
If another agent owns a file, coordinate before you edit it.

Do not revert another agent's changes. Report conflicting edits to the coordinating agent.

Write documentation, comments, messages, and interface prose in simple English.
Use the available simple-english skill and its use-case rules.
Keep protocol identifiers, field names, commands, and quoted errors exact.
Keep specifications free of session records, dated review narratives, and superseded design alternatives.
Use repository-relative documentation links. Preserve external source references that define requirements.

## Tests and review

Use Sol 6.1 with high reasoning effort for implementation.
Complete the coordinating agent's review and fixes before external review.
Use Opus and Grok for independent external reviews. Keep Kimi parked unless the human partner changes the assignment.
Name the exact revision in every review handoff.
Use Luna for thorough testing before human local tests.

Provide tested Tailscale URLs for authorized local services.
Do not interpret review approval as permission to merge, deploy, or release.
Expressly authorized private GitHub issues and pull requests remain development work.
The publication restriction covers live dictionary contributions and public deployment.

Keep all prototype tests local to this VM. Use disposable keys, synthetic account evidence, and mocked inference providers.
Do not change real Lensisku accounts or use production bindings during local tests.
Do not invent a software license. It remains a prelaunch choice.
Follow the [contribution rights](docs/format.md#remaining-body-fields) for new definitions and imported source content.
Keep third-party notices with redistributed artifacts. Use the [dependency guide](docs/dependencies.md) for notice locations.

## VM access and agent sessions

Follow the human partner's exact VM access and agent-session instructions supplied to this session.
This file does not replace or restate those instructions.
Use native harness subagents for assigned implementation and review work.
