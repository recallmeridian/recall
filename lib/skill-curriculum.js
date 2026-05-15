'use strict';

const GROUNDING_REFS = [
  'voyager-2023-open-ended-agent',
  'amem-2025-agentic-memory',
  'macla-2025-hierarchical-procedural-memory',
  'trainable-graph-memory-2025',
];

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function clean(value) {
  return String(value || '').trim();
}

function slugify(value) {
  const slug = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'capability';
}

function tokens(value) {
  return new Set(clean(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function overlapScore(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let hits = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) hits += 1;
  });
  return hits / Math.max(leftTokens.size, rightTokens.size);
}

function buildSkillCard(skill = {}) {
  const capability = slugify(skill.capability || skill.title || skill.id);
  return {
    entryType: 'skill_card',
    id: skill.id,
    project: skill.project || '',
    title: skill.title || skill.id,
    capability,
    status: skill.status || 'draft',
    promotionDecision: skill.promotionDecision || '',
    reliability: Number.isFinite(Number(skill.reliability)) ? Number(skill.reliability) : 0,
    preconditions: asArray(skill.preconditions),
    procedure: skill.procedure || '',
    prerequisites: asArray(skill.prerequisites || skill.preconditions).map(clean).filter(Boolean),
    sourceTraceIds: asArray(skill.sourceTraceIds),
    sourceLessonIds: asArray(skill.sourceLessonIds),
    evidenceRefs: asArray(skill.evaluationEvidenceRefs),
    researchRefs: Array.from(new Set([...asArray(skill.researchRefs), ...GROUNDING_REFS])),
    searchableText: [
      skill.id,
      skill.title,
      skill.capability,
      skill.procedure,
      ...asArray(skill.preconditions),
    ].map(clean).join(' '),
  };
}

function scoreSkillForGap(skillCard, gap = {}) {
  const gapText = [
    gap.id,
    gap.title,
    gap.capability,
    gap.description,
    ...asArray(gap.blockingFeatures),
  ].map(clean).join(' ');
  const match = Math.max(
    overlapScore(skillCard.capability, gap.capability || gap.title || gap.id),
    overlapScore(skillCard.searchableText, gapText)
  );
  const reliability = Number(skillCard.reliability || 0);
  const promotedBoost = skillCard.status === 'promoted' ? 0.2 : 0;
  return Math.min(1, match + reliability * 0.5 + promotedBoost);
}

function normalizeReliabilityScore(score = {}) {
  const payload = score.payload || score;
  return {
    id: score.id || payload.id || '',
    subject: clean(payload.subject || payload.query || score.title || ''),
    band: clean(payload.band || 'insufficient_evidence'),
    status: clean(payload.status || score.status || 'recorded'),
    confidence: clean(payload.confidence || ''),
    reliabilityScore: Number.isFinite(Number(payload.reliabilityScore)) ? Number(payload.reliabilityScore) : null,
    helpfulRate: Number.isFinite(Number(payload.helpfulRate)) ? Number(payload.helpfulRate) : null,
    harmRate: Number.isFinite(Number(payload.harmRate)) ? Number(payload.harmRate) : null,
  };
}

function scoreReliabilityForGap(reliability, gap = {}) {
  const gapText = [
    gap.id,
    gap.title,
    gap.capability,
    gap.description,
    ...asArray(gap.blockingFeatures),
  ].map(clean).join(' ');
  return Math.max(
    overlapScore(reliability.subject, gap.capability || gap.title || gap.id),
    overlapScore(reliability.subject, gapText)
  );
}

function reliabilityPriorityAdjustment(reliability) {
  if (!reliability) return 0;
  if (reliability.band === 'reliable') return 0.35;
  if (reliability.band === 'promising') return 0.2;
  if (reliability.band === 'high_risk') return -0.5;
  if (reliability.band === 'needs_review') return -0.25;
  return 0;
}

function reliabilityStatusOverride(reliability) {
  if (!reliability) return null;
  if (reliability.band === 'high_risk' || reliability.band === 'needs_review' || reliability.status === 'needs_review') {
    return 'needs_review';
  }
  return null;
}

function buildCurriculumTasks(gaps = [], skills = [], opts = {}) {
  const skillCards = asArray(skills).map(buildSkillCard);
  const reliabilityScores = asArray(opts.reliabilityScores).map(normalizeReliabilityScore);
  const tasks = asArray(gaps).map((gap) => {
    const value = Number.isFinite(Number(gap.value)) ? Number(gap.value) : 1;
    const candidateSkills = skillCards
      .map((skill) => ({
        skill,
        matchScore: scoreSkillForGap(skill, gap),
      }))
      .filter((candidate) => candidate.matchScore > 0)
      .sort((left, right) => right.matchScore - left.matchScore || left.skill.id.localeCompare(right.skill.id));
    const bestSkill = candidateSkills[0] || null;
    const readiness = Math.max(
      Number.isFinite(Number(gap.readiness)) ? Number(gap.readiness) : 0,
      bestSkill ? bestSkill.matchScore : 0
    );
    const uncertainty = 1 - Math.min(1, readiness);
    const matchingReliability = reliabilityScores
      .map((score) => ({
        score,
        matchScore: scoreReliabilityForGap(score, gap),
      }))
      .filter((candidate) => candidate.matchScore > 0)
      .sort((left, right) => right.matchScore - left.matchScore || left.score.subject.localeCompare(right.score.subject))[0] || null;
    const reliability = matchingReliability ? matchingReliability.score : null;
    const reliabilityAdjustment = reliabilityPriorityAdjustment(reliability);
    const priority = Number(Math.max(0, value * (0.5 + uncertainty + reliabilityAdjustment)).toFixed(4));
    const id = gap.id || `curriculum-${slugify(gap.capability || gap.title)}`;
    const baseStatus = readiness >= 0.85 ? 'ready_to_apply' : 'needs_training';
    const status = reliabilityStatusOverride(reliability) || baseStatus;

    return {
      entryType: 'curriculum_task',
      id,
      title: gap.title || `Improve ${gap.capability || id}`,
      capability: slugify(gap.capability || gap.title || id),
      blockingFeatures: asArray(gap.blockingFeatures),
      value,
      readiness: Number(readiness.toFixed(4)),
      priority,
      status,
      reliabilityBand: reliability ? reliability.band : 'insufficient_evidence',
      reliabilityScore: reliability ? reliability.reliabilityScore : null,
      reliabilitySubject: reliability ? reliability.subject : '',
      reliabilityMatchScore: matchingReliability ? Number(matchingReliability.matchScore.toFixed(4)) : 0,
      recommendedAction: status === 'needs_review'
        ? 'Review harmful or uncertain outcome history before investing more training effort.'
        : readiness >= 0.85
          ? 'Apply the linked skill in the next matching coding session and capture outcome evidence.'
          : 'Create an evaluator, verifier, or failure-mining trace that can raise this capability reliability.',
      linkedSkillIds: candidateSkills.slice(0, Number(opts.linkLimit || 3)).map((candidate) => candidate.skill.id),
      researchRefs: GROUNDING_REFS,
    };
  });

  return tasks.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

function planCurriculum(input = {}, skills = [], opts = {}) {
  const skillCards = asArray(skills).map(buildSkillCard);
  const tasks = buildCurriculumTasks(asArray(input.gaps), skillCards, opts);
  return {
    entryType: 'curriculum_plan',
    gapCount: asArray(input.gaps).length,
    skillCount: skillCards.length,
    taskCount: tasks.length,
    tasks,
    skillCards,
    reliabilityScoreCount: asArray(opts.reliabilityScores).length,
    groundingRefs: GROUNDING_REFS,
  };
}

module.exports = {
  GROUNDING_REFS,
  buildSkillCard,
  buildCurriculumTasks,
  planCurriculum,
  normalizeReliabilityScore,
};
