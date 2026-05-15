# Agent Specialization Research Extraction

Import set: `agent-specialization-multi-agent-learning-loop-2026-05-03`
Generated: 2026-05-03T21:49:06.626Z

## Thesis

The first Recall agent triad should remain simple and observable: Research Cartographer, Implementation Builder, and Adversarial Reviewer. The research argues against treating that triad as a permanent static pipeline. Recall should log role handoffs, outcomes, evidence quality, and failures now so a later router or decentralized coordination layer can be learned from outcomes.

## Immediate Design Rules

1. Extract reusable heuristics from trajectories; do not prompt with raw logs by default.
2. Make hard cases and failures first-class training material for skills.
3. Keep orchestration training-free until role contracts, handoff records, and evals exist.
4. Treat self-critique as weak evidence unless tied to adversarial prompts, tests, or outcome follow-up.
5. Keep jcode/OpenCode/Claude Code/Codex as harness/provider choices beneath Recall role contracts.

## Sources By Category

### multi-agent-orchestration
- `evolving-orchestration-openreview-l0xzpx`: Static multi-agent pipelines become inefficient as task complexity and agent count grow; the paper studies an RL-trained central orchestrator that adaptively sequences and prioritizes agents.
  - Recall: Supports keeping the current three-agent triad instrumented so Recall can later learn a router instead of hard-coding a permanent pipeline.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/evolving-orchestration-openreview-l0xzpx-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/evolving-orchestration-openreview-l0xzpx-2-pdf.pdf

### multi-agent-software-engineering
- `llm-mas-se-literature-review-2404-04834`: Survey and taxonomy for LLM-based multi-agent systems in software engineering, including recurring roles such as orchestrator, programmer, reviewer, tester, and information retriever.
  - Recall: Grounds the three-agent triad in a broader role taxonomy and prevents inventing isolated names without tested responsibilities.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/llm-mas-se-literature-review-2404-04834-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/llm-mas-se-literature-review-2404-04834-2-pdf.pdf

### context-engineering
- `context-engineering-code-assistants-2508-08322`: Argues that intent clarification, retrieval, and specialized coding sub-agents improve performance on real codebases by injecting targeted context.
  - Recall: Validates the Research Cartographer as a context/source-pack producer before implementation.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/context-engineering-code-assistants-2508-08322-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/context-engineering-code-assistants-2508-08322-2-pdf.pdf

### training-free-orchestration
- `mosaic-scientific-coding-2510-08804`: Training-free multi-agent framework for scientific coding that uses decomposition, rationale-coding-debug loops, and consolidated context management.
  - Recall: Supports building orchestration and context discipline before fine-tuning agents.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/mosaic-scientific-coding-2510-08804-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/mosaic-scientific-coding-2510-08804-2-pdf.pdf

### agent-distillation
- `mapcoder-lite-2509-17489`: Distills multi-agent coding behavior into a smaller model using trajectory distillation, supervisor-guided correction, and role-specific LoRA fine-tuning.
  - Recall: Future-facing: supervisor-detected cross-agent failure patterns matter now, while model distillation is later.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/mapcoder-lite-2509-17489-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/mapcoder-lite-2509-17489-2-pdf.pdf, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/mapcoder-lite-2509-17489-3-publisher-page.html

### self-improving-agents
- `erl-self-improving-agents-2603-24639`: Reflects on trajectories and outcomes to extract transferable heuristics, then retrieves relevant heuristics at test time; extracted heuristics outperform raw trajectory prompting.
  - Recall: Directly supports Recall skill curation: extract reusable heuristics from traces rather than dumping raw logs into context.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/erl-self-improving-agents-2603-24639-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/erl-self-improving-agents-2603-24639-2-pdf.pdf

### memory-skill-evolution
- `memskill-self-evolving-memory-skills-2602-02474`: Treats memory operations as evolvable skills, with a controller selecting skills, an executor applying them, and a designer improving the skill set from hard cases.
  - Recall: Closest match to a Recall learning loop where hard failures evolve the skill bank.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/memskill-self-evolving-memory-skills-2602-02474-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/memskill-self-evolving-memory-skills-2602-02474-2-pdf.pdf

### agent-memory-survey
- `memory-for-autonomous-llm-agents-2603-07670`: Survey of agent memory mechanisms, evaluation, governance, write-path filtering, contradiction handling, and learned forgetting.
  - Recall: Frames Recall as a retrieval-backed memory system moving toward managed read-write memory with governance and unlearning requirements.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/memory-for-autonomous-llm-agents-2603-07670-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/memory-for-autonomous-llm-agents-2603-07670-2-pdf.pdf

### test-time-self-improvement
- `tt-si-self-improving-agents-2510-07841`: Identifies uncertain samples, generates similar examples, and applies lightweight test-time fine-tuning to improve agent performance.
  - Recall: Aggressive future option for actual model updates after Recall has clean uncertainty cases and evaluation harnesses.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/tt-si-self-improving-agents-2510-07841-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/tt-si-self-improving-agents-2510-07841-2-pdf.pdf

### self-correction-limits
- `rise-recursive-introspection-2407-18219`: Shows that models often do not reliably improve merely by being told to correct themselves; recursive improvement can require fine-tuning and structured feedback.
  - Recall: Warns that an Adversarial Reviewer needs real evidence, prompts, and outcome feedback rather than generic self-critique.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/rise-recursive-introspection-2407-18219-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/rise-recursive-introspection-2407-18219-2-pdf.pdf

### decentralized-coordination
- `agentnet-decentralized-coordination-2504-00587`: Proposes decentralized, dynamically structured agent coordination with retrieval-backed memory and adaptive routing.
  - Recall: Longer-term direction after centralized triad orchestration has outcome data.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/agentnet-decentralized-coordination-2504-00587-1-landing-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/agentnet-decentralized-coordination-2504-00587-2-pdf.pdf

### practitioner-perspective
- `openrouter-autogen-specialization-practitioner-2025`: Practitioner view of model-specific agent specialization and orchestration with different providers.
  - Recall: Useful as industry context for multi-model routing, but not decisive evidence.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/openrouter-autogen-specialization-practitioner-2025-1-reader-webpage.html

### practitioner-landscape
- `open-source-coding-agents-newstack-2026`: Industry overview of open-source coding-agent harnesses and the economics of multi-provider developer tooling.
  - Recall: Supports staying harness-agnostic while Recall captures durable role contracts and evidence.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/open-source-coding-agents-newstack-2026-1-webpage.html

### jcode-practitioner-review
- `jcode-civil-learning-practitioner-2026`: Practitioner walkthrough of jcode and its claimed performance characteristics; benchmark claims should be treated as unverified until locally reproduced.
  - Recall: Input for a future jcode adoption smoke test, not a basis for architecture promotion.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/jcode-civil-learning-practitioner-2026-1-reader-webpage.html

### jcode-primary-source
- `jcode-1jehuang-primary-repo`: Primary jcode repository describing a Rust coding-agent harness with multi-session workflows, memory, provider integrations, browser tooling, and swarm features.
  - Recall: Primary source for what jcode claims to provide; adoption should still depend on local installation and task benchmarks.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/jcode-1jehuang-primary-repo-1-repo-page.html, data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/jcode-1jehuang-primary-repo-2-readme.md

### jcode-name-collision
- `jcode-cnjack-primary-repo`: Secondary GitHub repository with the same jcode name. Included to avoid conflating unrelated projects.
  - Recall: Prevents Recall from merging claims about different jcode projects.
  - Artifacts: data/research-artifacts/agent-specialization-multi-agent-learning-loop-2026-05-03/jcode-cnjack-primary-repo-1-repo-page.html

## Download Failures

None.

## Next Recall Actions

1. Add a router-readiness metric to agent handoffs: role selected, role skipped, reason, outcome, compute cost.
2. Add a hard-case harvester that proposes skill edits only from failed or uncertain runs.
3. Add local harness evaluations before adopting jcode as more than an optional execution substrate.
4. Add unlearning/retirement metadata before autonomous background learning is allowed.

