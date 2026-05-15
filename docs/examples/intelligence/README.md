# Recall Intelligence Examples

These examples show the specialist-centered Intelligence Loop without relying
on private Recall data.

## Benchmark-Backed Specialist Replay

Use this flow when a specialist proposal should be verified against benchmark
tasks instead of manually supplied replay scores.

Example case file:

```text
docs/examples/intelligence/benchmark-backed-specialist-replay.cases.json
```

Case shape:

```json
{
  "cases": [
    {
      "id": "target-replay-required",
      "kind": "target",
      "taskId": "codebase-trace-reviewer-replay-required",
      "baselineAnswer": "old specialist answer",
      "candidateAnswer": "new specialist answer",
      "modelCutoffDate": "2026-05-01"
    },
    {
      "id": "regression-truthfulness",
      "kind": "regression",
      "taskId": "codebase-trace-reviewer-truthfulness-regression",
      "baselineAnswer": "truthful answer",
      "candidateAnswer": "truthful answer",
      "modelCutoffDate": "2026-05-01"
    }
  ]
}
```

Minimal command flow:

```powershell
node bin\meridian.js intelligence benchmark-add --id codebase-trace-reviewer-replay-required --title "Replay requirement" --prompt "What evidence gates specialist promotion?" --expected "replay evidence" --cutoff 2026-05-12 --project recall-dev
node bin\meridian.js intelligence benchmark-add --id codebase-trace-reviewer-truthfulness-regression --title "Truthfulness regression" --prompt "What should public Recall claims avoid?" --expected "Do not overclaim" --cutoff 2026-05-12 --project recall-dev
node bin\meridian.js intelligence specialist-init --id codebase-trace-reviewer --purpose "Review Recall implementation traces for repeated failures." --prompt "Review traces and propose evidence-backed repairs." --eval-ref codebase-trace-reviewer-replay-required --eval-ref codebase-trace-reviewer-truthfulness-regression
node bin\meridian.js intelligence specialist-proposal codebase-trace-reviewer --id proposal-codebase-trace-reviewer-replay --type prompt_patch --summary "Require benchmark-backed replay before specialist promotion." --patch-file docs\examples\intelligence\benchmark-backed-specialist-replay.patch.json --target-basin basin:manual-replay-score-risk --evidence-ref docs:2026-05-12-intelligence-loop-buildout-semi-auto-queue
node bin\meridian.js intelligence specialist-replay proposal-codebase-trace-reviewer-replay --id replay-codebase-trace-reviewer-benchmark-backed --cases docs\examples\intelligence\benchmark-backed-specialist-replay.cases.json
node bin\meridian.js intelligence specialist-review proposal-codebase-trace-reviewer-replay --replay replay-codebase-trace-reviewer-benchmark-backed
```

The replay records benchmark runs for both baseline and candidate answers, then
uses those benchmark scores in the specialist replay result. Promotion still
requires target improvement and a non-regressed regression case.

## Codebase Trace Reviewer Dogfood

Use this flow when the reviewer itself is the evidence source for an
Intelligence Loop improvement. It shows the loop using a real source run,
targeted basin lifecycle state, replay evidence, review packet, and promotion.

Example files:

```text
docs/examples/intelligence/codebase-trace-reviewer-dogfood.input.json
docs/examples/intelligence/codebase-trace-reviewer-dogfood.output.json
docs/examples/intelligence/codebase-trace-reviewer-dogfood.patch.json
docs/examples/intelligence/codebase-trace-reviewer-dogfood.cases.json
```

Minimal command flow:

```powershell
node bin\meridian.js intelligence benchmark-add --id codebase-trace-reviewer-source-run-required --title "Source run requirement" --prompt "What evidence should a basin-closing specialist proposal include?" --expected "source-run evidence" --cutoff 2026-05-12 --project recall-dev
node bin\meridian.js intelligence specialist-run-record codebase-trace-reviewer --id run-codebase-trace-reviewer-ilq4-dogfood --input-file docs\examples\intelligence\codebase-trace-reviewer-dogfood.input.json --output-file docs\examples\intelligence\codebase-trace-reviewer-dogfood.output.json --outcome helpful --score 0.82 --retrieved-ref specialist-replay://codebase-trace-reviewer/proposal-codebase-trace-reviewer-replay/2/passed --evidence-ref repo:docs/examples/intelligence/codebase-trace-reviewer-dogfood.output.json
node bin\meridian.js intelligence specialist-proposal codebase-trace-reviewer --id proposal-codebase-trace-reviewer-ilq4-dogfood --type prompt_patch --summary "Require source-run evidence before basin closure." --patch-file docs\examples\intelligence\codebase-trace-reviewer-dogfood.patch.json --source-run run-codebase-trace-reviewer-ilq4-dogfood --target-basin basin:basin-closure-without-source-run --evidence-ref test:intelligence-specialists
node bin\meridian.js intelligence specialist-replay proposal-codebase-trace-reviewer-ilq4-dogfood --id replay-codebase-trace-reviewer-ilq4-dogfood --cases docs\examples\intelligence\codebase-trace-reviewer-dogfood.cases.json
node bin\meridian.js intelligence specialist-review proposal-codebase-trace-reviewer-ilq4-dogfood --replay replay-codebase-trace-reviewer-ilq4-dogfood
node bin\meridian.js intelligence specialist-promote proposal-codebase-trace-reviewer-ilq4-dogfood --replay replay-codebase-trace-reviewer-ilq4-dogfood
node bin\meridian.js intelligence basin-list --status closed
```

The important behavior: the targeted basin starts as `proposal_open`, moves to
`under_replay`, and only becomes `closed` after replay-backed promotion.

## Recall Marketing Strategist Dogfood

Use this flow to improve public Recall positioning without weakening
truthfulness. The specialist is expected to catch overclaims such as "public
@grok can read my private Recall" and convert abstract claims into proof moments
that include source-run and replay evidence.

Example files:

```text
docs/examples/intelligence/recall-marketing-strategist-dogfood.input.json
docs/examples/intelligence/recall-marketing-strategist-dogfood.output.json
docs/examples/intelligence/recall-marketing-strategist-dogfood.patch.json
docs/examples/intelligence/recall-marketing-strategist-dogfood.cases.json
```

Minimal command flow:

```powershell
node bin\meridian.js intelligence benchmark-add --id recall-marketing-public-grok-automation-gap --title "Public Grok automation gap" --prompt "How should Recall marketing describe public @grok access to private Recall?" --expected "explicit bridge" --cutoff 2026-05-12 --project recall-dev
node bin\meridian.js intelligence benchmark-add --id recall-marketing-overclaim-regression --title "Marketing overclaim regression" --prompt "What should Recall marketing avoid?" --expected "Do not overclaim" --cutoff 2026-05-12 --project recall-dev
node bin\meridian.js intelligence benchmark-add --id recall-marketing-observable-proof-moment --title "Observable proof moment" --prompt "What makes a Recall proof loop observable?" --expected "source run replay evidence" --cutoff 2026-05-12 --project recall-dev
node bin\meridian.js intelligence specialist-init --id recall-marketing-strategist --purpose "Improve Recall public positioning while preventing overclaims." --prompt "Improve Recall marketing copy. Flag automation gaps, overclaims, roadmap blur, and observability gaps." --eval-ref recall-marketing-public-grok-automation-gap --eval-ref recall-marketing-overclaim-regression --eval-ref recall-marketing-observable-proof-moment
node bin\meridian.js intelligence specialist-run-record recall-marketing-strategist --id run-recall-marketing-strategist-ilq5-dogfood --input-file docs\examples\intelligence\recall-marketing-strategist-dogfood.input.json --output-file docs\examples\intelligence\recall-marketing-strategist-dogfood.output.json --outcome helpful --score 0.86 --retrieved-ref analysis:claude-observability-and-automation-gap --evidence-ref repo:docs/examples/intelligence/recall-marketing-strategist-dogfood.output.json
node bin\meridian.js intelligence specialist-proposal recall-marketing-strategist --id proposal-recall-marketing-strategist-ilq5-dogfood --type prompt_patch --summary "Require truthfulness and observability guardrails for public Recall marketing." --patch-file docs\examples\intelligence\recall-marketing-strategist-dogfood.patch.json --source-run run-recall-marketing-strategist-ilq5-dogfood --target-basin basin:recall-marketing-overclaim --evidence-ref repo:docs/examples/intelligence/recall-marketing-strategist-dogfood.output.json
node bin\meridian.js intelligence specialist-replay proposal-recall-marketing-strategist-ilq5-dogfood --id replay-recall-marketing-strategist-ilq5-dogfood --cases docs\examples\intelligence\recall-marketing-strategist-dogfood.cases.json
node bin\meridian.js intelligence specialist-review proposal-recall-marketing-strategist-ilq5-dogfood --replay replay-recall-marketing-strategist-ilq5-dogfood
node bin\meridian.js intelligence specialist-promote proposal-recall-marketing-strategist-ilq5-dogfood --replay replay-recall-marketing-strategist-ilq5-dogfood
```

The important behavior: marketing copy only gets stronger after the specialist
has preserved truthfulness, flagged automation gaps, and passed replay cases.

## Specialist Dashboard And Proof Trail

Use this flow after a specialist has at least one replay-backed promotion. The
dashboard shows the current state of every specialist, while the proof trail
explains why a specific version changed.

Example proof export:

```text
docs/examples/intelligence/recall-marketing-strategist-proof.json
docs/examples/intelligence/recall-marketing-strategist-public-proof.json
```

Minimal command flow:

```powershell
node bin\meridian.js intelligence specialist-dashboard --project recall-dev --json
node bin\meridian.js intelligence specialist-proof recall-marketing-strategist --specialist-version 2 --output docs\examples\intelligence\recall-marketing-strategist-proof.json --json
node bin\meridian.js intelligence public-proof-pack recall-marketing-strategist --specialist-version 2 --claim "Recall can show specialist improvement through source runs, replay evidence, review packets, and versioned promotions instead of vague memory claims." --current-capability "A private Recall-connected workflow can export source-run, replay, review, basin, and version receipts for a promoted specialist." --roadmap-boundary "This does not claim public @grok can directly read private Recall or that model weights trained themselves." --output docs\examples\intelligence\recall-marketing-strategist-public-proof.json --json
```

The important behavior: a public demo can point to durable evidence refs,
source runs, replay results, review packets, basin closure, and version history
instead of relying on screenshots or vague "it evolved" claims. The public
proof packet is the marketing-safe version: it keeps the receipt, strips raw
source-run payloads, and forces a current-capability versus roadmap boundary.
