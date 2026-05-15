'use strict';

// Cross-system evaluator ensemble.
//
// Codex's sharpest design improvement from the 2026-05-12 brainstorm
// (sharper than Claude's "ensemble of N evaluators of the same model
// with different configs" or Grok's "different frontier models").
// Codex's exact framing:
//
//   one Recall rules evaluator + one frontier model + one local
//   heuristic. "A single model judging its own policy proposals is
//   a bad shape." Different KINDS of evaluators have different
//   failure modes; they won't share blind spots the way two LLMs do.
//
// API:
//   evaluateEnsemble({ subject, evaluators }) → {
//     decision: 'agree-allow' | 'agree-block' | 'agree-review'
//             | 'disagree-needs-human' | 'no-evaluators',
//     verdicts: [{ name, kind, decision, confidence, rationale }],
//     agreement: { unanimous, majority, conflicts },
//     reason,
//   }
//
// Each evaluator is { name, kind, evaluate(subject) → verdict }.
// kind in: 'rules' | 'frontier-model' | 'heuristic'.
// verdict shape: { decision: 'allow'|'block'|'review',
//                  confidence: 0..1,
//                  rationale: string }
//
// The ensemble does NOT call LLMs directly — it composes evaluators
// the caller provides, so it stays pure-data + testable. The CLI
// command wires real adapters: a Recall-rules evaluator, an LLM
// evaluator (using the existing ILLMProvider port), and a local
// heuristic evaluator.

function safeEvaluate(evaluator, subject) {
  try {
    const v = evaluator.evaluate(subject);
    if (!v || typeof v !== 'object') throw new Error('evaluator returned invalid verdict');
    if (!['allow', 'block', 'review'].includes(v.decision)) {
      throw new Error(`evaluator returned invalid decision: ${v.decision}`);
    }
    return {
      name: evaluator.name,
      kind: evaluator.kind,
      decision: v.decision,
      confidence: typeof v.confidence === 'number' ? v.confidence : null,
      rationale: v.rationale || '',
    };
  } catch (err) {
    return {
      name: evaluator.name,
      kind: evaluator.kind,
      decision: 'review',
      confidence: 0,
      rationale: 'evaluator-error: ' + err.message,
      error: err.message,
    };
  }
}

function evaluateEnsemble({ subject, evaluators } = {}) {
  if (!Array.isArray(evaluators) || evaluators.length === 0) {
    return {
      decision: 'no-evaluators',
      verdicts: [],
      agreement: { unanimous: false, majority: null, conflicts: [] },
      reason: 'no evaluators supplied',
    };
  }

  const verdicts = evaluators.map((e) => safeEvaluate(e, subject));
  const counts = { allow: 0, block: 0, review: 0 };
  for (const v of verdicts) counts[v.decision]++;

  const total = verdicts.length;
  const unanimousDecision = (counts.allow === total) ? 'allow' :
                            (counts.block === total) ? 'block' :
                            (counts.review === total) ? 'review' : null;
  const unanimous = unanimousDecision !== null;

  // Majority means strictly more than half on a single decision.
  let majority = null;
  for (const d of ['allow', 'block', 'review']) {
    if (counts[d] * 2 > total) { majority = d; break; }
  }

  // Conflicts: pairs of evaluators that disagreed.
  const conflicts = [];
  for (let i = 0; i < verdicts.length; i++) {
    for (let j = i + 1; j < verdicts.length; j++) {
      if (verdicts[i].decision !== verdicts[j].decision) {
        conflicts.push({ a: verdicts[i].name, b: verdicts[j].name, decisions: [verdicts[i].decision, verdicts[j].decision] });
      }
    }
  }

  // Decision rule (matches Codex's "disagreement triggers human review"):
  //   - All agree? → 'agree-<decision>'
  //   - Any block from ANY evaluator? → 'disagree-needs-human' (block is loud)
  //   - Otherwise majority decides if it exists, else needs-human
  let decision;
  let reason;
  if (unanimous) {
    decision = 'agree-' + unanimousDecision;
    reason = `all ${total} evaluators agreed: ${unanimousDecision}`;
  } else if (counts.block > 0) {
    // Codex pattern: any block from any kind is treated as a strong
    // signal that needs human review even if others say allow.
    decision = 'disagree-needs-human';
    reason = `at least one evaluator returned block (${counts.block}/${total}); disagreement requires human review`;
  } else if (majority) {
    decision = 'agree-' + majority + '-by-majority';
    reason = `majority (${counts[majority]}/${total}) said ${majority}; one or more dissented`;
  } else {
    decision = 'disagree-needs-human';
    reason = `no majority across ${total} evaluators (allow=${counts.allow} block=${counts.block} review=${counts.review})`;
  }

  return {
    decision,
    verdicts,
    agreement: { unanimous, majority, conflicts, counts },
    reason,
  };
}

// Built-in evaluator: Recall rules. Pure heuristic over the subject's
// stated egress + secret + path attributes. Useful as the "rules"
// arm of the ensemble even before an LLM is wired in.
function rulesEvaluator() {
  return {
    name: 'recall-rules',
    kind: 'rules',
    evaluate(subject) {
      // Subject shape (defensive — accept any of these):
      //   { content?, blockers?: [...], warnings?: [...],
      //     egressTarget?, hasSecrets?, hasPrivatePath? }
      const blockerCount = Array.isArray(subject.blockers) ? subject.blockers.length : 0;
      const warningCount = Array.isArray(subject.warnings) ? subject.warnings.length : 0;
      const hasSecrets = Boolean(subject.hasSecrets);
      const hasPrivatePath = Boolean(subject.hasPrivatePath);
      const egressTarget = subject.egressTarget || null;

      if (blockerCount > 0 || hasSecrets || hasPrivatePath) {
        return { decision: 'block', confidence: 0.95, rationale: `rules: ${blockerCount} blocker(s), secrets=${hasSecrets}, privatePath=${hasPrivatePath}` };
      }
      if (egressTarget && egressTarget !== 'internal') {
        return { decision: 'review', confidence: 0.85, rationale: `rules: egress to ${egressTarget} requires review (egress is always a review boundary)` };
      }
      if (warningCount >= 3) {
        return { decision: 'review', confidence: 0.7, rationale: `rules: ${warningCount} warnings exceed comfort threshold` };
      }
      return { decision: 'allow', confidence: 0.6, rationale: 'rules: no blockers, no egress, warnings within threshold' };
    },
  };
}

// Built-in evaluator: local heuristic. Independent of the rules
// evaluator — uses different signals (content size, entropy of any
// text, presence of certain keywords) to provide an uncorrelated
// vote.
function heuristicEvaluator() {
  return {
    name: 'local-heuristic',
    kind: 'heuristic',
    evaluate(subject) {
      const content = subject.content || '';
      const length = content.length;
      const lower = content.toLowerCase();
      const suspiciousKeywords = ['password', 'secret', 'token', 'private', 'credential', 'leaked', 'exfil'];
      const matchedKeywords = suspiciousKeywords.filter((k) => lower.includes(k));

      // Entropy proxy: ratio of unique chars to length on the first 200 chars.
      const sample = content.slice(0, 200);
      const unique = new Set(sample).size;
      const entropy = sample.length ? unique / sample.length : 0;

      const lowConfidenceAllow = { decision: 'allow', confidence: 0.4, rationale: 'heuristic: nothing notable' };

      if (matchedKeywords.length >= 2 && length > 50) {
        return { decision: 'review', confidence: 0.55, rationale: `heuristic: ${matchedKeywords.length} suspicious keywords (${matchedKeywords.join(', ')}) in non-trivial content` };
      }
      if (entropy > 0.55 && length > 100) {
        return { decision: 'review', confidence: 0.5, rationale: `heuristic: high character entropy (${entropy.toFixed(2)}) suggests random/encoded payload` };
      }
      return lowConfidenceAllow;
    },
  };
}

// LLM evaluator factory — caller passes a function (subject) → Promise
// or sync, returning the verdict. Wrapped here so the ensemble has a
// stable interface. Used by the CLI command to wrap the openclaw-
// governor specialist or any other LLM judgment.
function llmEvaluator({ name = 'frontier-llm', invoke }) {
  return {
    name,
    kind: 'frontier-model',
    evaluate(subject) {
      const v = invoke(subject);
      if (!v || typeof v !== 'object') throw new Error('llm evaluator returned no verdict');
      return v;
    },
  };
}

module.exports = {
  evaluateEnsemble,
  rulesEvaluator,
  heuristicEvaluator,
  llmEvaluator,
};
