# Security Policy

Recall/Meridian is experimental software. Treat it as a local knowledge and feature lab, not as a trusted production security boundary.

## Reporting Security Issues

Please do not publish exploit details before the maintainer has had a chance to review them. Open a private security report through the repository host when available, or contact the repository owner through the project channel being used for the release.

Include:

- The affected command, module, or workflow.
- Steps to reproduce.
- Whether the issue involves prompt injection, memory poisoning, data leakage, path traversal, unsafe tool use, or output handling.
- Any logs or fixtures needed to verify the issue, with secrets removed.

Do not include real credentials, private keys, customer data, personal records, or sensitive chat exports.

## Current Security Model

The project is moving toward geomorphic security topology:

- Provenance acts as the watershed for every knowledge item.
- Suspicious content routes to quarantine rather than trusted memory.
- Retrieval should respect partition boundaries before ranking.
- Untrusted context should be spotlighted as data, not instruction.
- Feature and tool execution should pass through capability gates.
- Outputs should be validated before they reach files, tools, SQL, HTML, URLs, or exports.
- Audit sediment should record important decisions and security events.

The model is structural by design, but parts of it are still being wired into runtime behavior.

## Known Risks

Known risk areas include:

- Prompt injection and indirect prompt injection.
- Memory poisoning.
- Sensitive data leakage from local files or imported chats.
- Unsafe output handling.
- Insecure plugin, MCP, or tool use.
- Excessive agency from autonomous feature execution.
- Local path leakage in docs, tests, manifests, or generated artifacts.
- Confusing draft knowledge for validated truth.

## Supported Status

The current readiness target is private alpha. Limited public open source requires the readiness gate to pass with no blockers:

```powershell
node bin\meridian.js open-source readiness --stage limited-public
```

Security fixes that add containment, recoverability, validation, or auditability are welcome. Changes that weaken trust boundaries, remove provenance, bypass promotion gates, or make external content trusted by default should be rejected.
