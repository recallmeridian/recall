'use strict';

// Recall Marketing Strategist — public-facing specialist bundle.
//
// This specialist turns Recall/Meridian product ideas into public-safe
// positioning. Its job is not to maximize hype; it improves clarity while
// protecting truthfulness, current-vs-roadmap boundaries, observability, and
// the manual/automated bridge distinction.

const id = 'recall-marketing-strategist';
const version = '0.2.0';

const systemPrompt = `You are the Recall Marketing Strategist.
You help turn Recall/Meridian product ideas into truthful public positioning.

Your priorities, in order:
1. Make the claim concrete and observable for a scrolling audience.
2. Preserve the current-capability vs roadmap boundary.
3. Flag unsupported automation claims, especially claims that public @grok or
   other public assistants can directly access a private Recall instance.
4. Prefer evidence-backed language over AGI, magic, or "it learns" phrasing.
5. Suggest a stronger but still defensible public post.

REQUIRED VOCABULARY when flagging specific failure modes:

(A) "Evolving / self-improving / learning model" overclaims (e.g. "Recall trains
every model into a self-improving specialist"):
  - You MUST include the literal phrase "versioned specialist" in revisedCopy.
  - You MUST include the literal phrase "replay evidence" in revisedCopy or in
    a riskFlags[].issue.
  - Mechanism to describe: Recall does not train models. Recall ships versioned
    specialist bundles. Each version's improvement is backed by replay evidence
    against a fixed set of eval cases. The improvement is auditable, not magical.
  - Example revisedCopy pattern: "Recall doesn't train models — it ships
    versioned specialist bundles. Each new version's claims are backed by
    replay evidence on a fixed eval suite, so improvement is auditable, not
    magical."

(B) Observability gaps (e.g. abstract philosophy with no observable artifact):
  - You MUST name a specific concrete proof moment using ONE of these literal
    phrases in proofMoment OR revisedCopy: "one post", "one CLI command
    output", "one screenshot", "one repository commit", or "one thread".
  - Abstract philosophy is the failure mode — anchor every revision to ONE
    observable artifact a scroller can verify in under 10 seconds.

Return strictly a JSON object with these fields:
{
  "positioningSummary": "1-2 sentence summary",
  "safeClaims": ["truthful claim", "..."],
  "riskFlags": [
    { "risk": "overclaim|automation-gap|observability-gap|audience-mismatch|roadmap-blur|other", "issue": "string", "severity": "low|medium|high" }
  ],
  "revisedCopy": "public-safe copy",
  "proofMoment": "what the audience can observe in one post/thread (name the specific artifact)",
  "audience": "builders|knowledge-workers|technical-founders|general",
  "confidence": 0.0
}

Do not claim Recall directly powers public @grok on X unless the prompt says a
real bridge exists. Say "manual bridge", "private Recall-connected session", or
"roadmap" when appropriate. Do not call accumulation/evidence a model learning
unless the text describes a real training or optimization loop.`;

function buildUserMessage({ input, retrievedContext }) {
  const contextLines = (retrievedContext || []).map((e) => {
    const label = `[${e.category}${e.project ? '/' + e.project : ''}] ${e.id || e.name}`;
    const body = e.description ? e.description.split('\n').slice(0, 6).join('\n') : '(no description)';
    return `${label}\n${body}`;
  });
  return [
    'Marketing draft or campaign idea:',
    '```',
    String(input || '(no input)').trim(),
    '```',
    '',
    contextLines.length > 0
      ? `Recall context (${contextLines.length}):\n${contextLines.join('\n\n---\n\n')}`
      : 'No Recall context retrieved. Be conservative and do not invent product capabilities.',
    '',
    'Return the public-safe positioning JSON object.',
  ].join('\n');
}

const specialist = {
  id,
  version,
  name: 'Recall Marketing Strategist',
  description: 'Improves Recall public positioning while guarding against overclaims, fake automation, roadmap blur, and observability gaps.',

  declaredCapabilities: [
    'read_kb_decisions',
    'read_kb_lessons',
    'call_llm',
    'marketing_claim_review',
  ],

  requiredPorts: ['ILLMProvider'],

  promptTemplates: {
    system: systemPrompt,
    user: buildUserMessage,
  },

  retrievalRecipe: {
    defaultProject: 'recall-dev',
    queries: [
      { category: 'decisions', limit: 8 },
      { category: 'lessons', limit: 8 },
      { category: 'features', limit: 5 },
    ],
  },

  outputSchema: {
    type: 'object',
    required: ['positioningSummary', 'safeClaims', 'riskFlags', 'revisedCopy', 'proofMoment', 'audience', 'confidence'],
    properties: {
      positioningSummary: { type: 'string' },
      safeClaims: { type: 'array' },
      riskFlags: { type: 'array' },
      revisedCopy: { type: 'string' },
      proofMoment: { type: 'string' },
      audience: { type: 'string', enum: ['builders', 'knowledge-workers', 'technical-founders', 'general'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },

  evaluationCases: [
    {
      id: 'eval-1-public-grok-private-recall',
      description: 'Claim that public @grok can access private Recall should be flagged as automation-gap.',
      input: '@grok can now remember everything from my private Recall and answer from it on X.',
      expected: {
        shouldFlag: ['automation-gap', 'private Recall', 'manual bridge'],
        expectedRisks: ['automation-gap'],
      },
    },
    {
      id: 'eval-2-evolving-specialist-language',
      description: 'Evolving specialist copy should describe accumulated evidence and versioned bundles, not hidden model training.',
      input: 'Recall trains every model into a self-improving specialist automatically.',
      expected: {
        shouldFlag: ['overclaim', 'versioned specialist', 'replay evidence'],
        expectedRisks: ['overclaim', 'roadmap-blur'],
      },
    },
    {
      id: 'eval-3-observable-proof',
      description: 'Good copy should create a one-post proof moment instead of abstract philosophy.',
      input: 'Recall is a universal continuity substrate for persistent personal intelligence.',
      expected: {
        shouldFlag: ['observable', 'proof moment', 'one post'],
        expectedRisks: ['observability-gap'],
      },
    },
  ],

  refinementNotes: [],
};

module.exports = {
  id,
  version,
  specialist,
};
