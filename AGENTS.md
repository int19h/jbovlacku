# Agent instructions

Use the [development guide](docs/development.md) for workspace, tooling, tests, and review requirements.
The [format specification](docs/format.md) and [frontend specification](docs/frontend.md) define target behavior.
The [implemented scope](docs/implemented-scope.md) describes what the prototype does today. Do not claim that a target feature exists before its tests pass.

## Scope and shared files

Read the task authorization before you edit files or operate a service.
Use a separate worktree for each agent.
Keep build output and task-specific scratch files in an ignored directory or outside the checkout.
An ignored directory such as `.cache` is suitable.
Delete only exact directories that belong to the current task.
Do not delete unrelated files, sibling worktrees, shared caches, or other projects.
If another agent owns a file, coordinate before you edit it.

Do not revert another agent's changes. Resolve conflicting edits with the contributors involved.

Write documentation, comments, messages, and interface prose in simple English.
If a simple-English skill is available, follow its use-case rules.
Keep protocol identifiers, field names, commands, and quoted errors exact.
Keep specifications free of session records, dated review narratives, and superseded design alternatives.
Use repository-relative documentation links. Preserve external source references that define requirements.

## Tests and review

Each change gets a first review.
After that review passes, the change gets at least one independent review before merge.

Name the exact revision in every review handoff.
Resolve review findings and run the relevant tests before handoff.
Run thorough tests before local acceptance tests.
Limit parallel tests to the resources of the host.
Keep unrelated work usable.

Provide tested URLs for authorized local services. State their access and signing requirements.
Do not interpret review approval as permission to merge, deploy, or release.
Expressly authorized private GitHub issues and pull requests remain development work.
The publication restriction covers live dictionary contributions and public deployment.

Run prototype tests locally with disposable keys, synthetic account evidence, and mocked inference providers.
Do not change real Lensisku accounts or use production bindings during local tests.
Do not invent a software license. It remains a prelaunch choice.
Follow the [contribution rights](docs/format.md#remaining-body-fields) for new definitions and imported source content.
Keep third-party notices with redistributed artifacts. Use the [dependency guide](docs/dependencies.md) for notice locations.

## Access and agent sessions

Follow the access permissions and task instructions supplied for the current environment.
Do not infer permission for unrelated services or actions from local access.
