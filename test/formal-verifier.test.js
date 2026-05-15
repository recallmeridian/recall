'use strict';

const formalVerifier = require('../lib/formal-verifier');
const promotionGates = require('../lib/promotion-gates');

describe('formal verifier adapter MVP', () => {
  test('accepts a fake Lean trivial proof as verifier-gate evidence', () => {
    const result = formalVerifier.verifyFormalClaim({
      language: 'lean',
      statement: 'theorem recall_true_fixture : True :=',
      proof: 'by trivial',
    });
    const gate = promotionGates.evaluatePromotionGate(result);

    expect(result).toMatchObject({
      entryType: 'verifier_result',
      adapter: 'fake-lean',
      status: 'verified',
      passed: true,
      promotionDecision: 'verified_claim',
    });
    expect(result.evidenceTypes).toEqual(['formal_statement', 'verifier_run', 'proof_artifact']);
    expect(result.proofArtifact.ref).toMatch(/^proof:\/\/sha256\//);
    expect(gate).toMatchObject({
      allowed: true,
      entryType: 'verifier_result',
      requestedPromotion: 'verified_claim',
    });
  });

  test('rejects placeholder proof tokens and blocks promotion', () => {
    const result = formalVerifier.verifyFormalClaim({
      statement: 'theorem recall_placeholder_fixture : True :=',
      proof: 'by sorry',
    });
    const gate = promotionGates.evaluatePromotionGate(result);

    expect(result).toMatchObject({
      passed: false,
      promotionDecision: 'blocked_pending_verification',
    });
    expect(result.issues).toContain('proof_contains_placeholder');
    expect(result.evidenceTypes).not.toContain('proof_artifact');
    expect(gate.allowed).toBe(false);
    expect(gate.missingEvidence).toContain('proof_artifact');
  });

  test('fails closed on informal statements missing verifier shape', () => {
    const result = formalVerifier.verifyFormalClaim({
      statement: 'Every useful math idea should be true.',
      proof: 'by trivial',
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain('invalid_formal_statement_shape');
  });

  test('rejects invalid adapter and timeout values before execution', () => {
    const result = formalVerifier.verifyFormalClaim({
      adapter: 'live-lean',
      statement: 'theorem recall_true_fixture : True :=',
      proof: 'by trivial',
      timeoutMs: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'unknown_verifier_adapter',
      'invalid_timeout',
    ]));
  });

  test('discovers fake Lean and reports missing real Lean fail-closed', () => {
    const commandRunner = () => ({ status: 1, stdout: '', stderr: 'not found' });
    const adapters = formalVerifier.discoverVerifierAdapters({ commandRunner });
    const result = formalVerifier.verifyFormalClaim({
      adapter: 'lean',
      statement: 'theorem recall_real_lean_fixture : True :=',
      proof: 'by trivial',
    }, { commandRunner });

    expect(adapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: 'fake-lean', available: true }),
      expect.objectContaining({ adapter: 'lean', available: false }),
    ]));
    expect(result).toMatchObject({
      adapter: 'lean',
      passed: false,
      status: 'rejected',
    });
    expect(result.issues).toContain('lean_not_available');
  });

  test('runs real Lean adapter through an injected command runner', () => {
    const calls = [];
    const commandRunner = (command, args) => {
      calls.push({ command, args });
      if (command === 'lake') return { status: 1, stdout: '', stderr: 'lake missing' };
      if (command === 'lean' && args.includes('--version')) {
        return { status: 0, stdout: 'Lean 4.99.0 test\n', stderr: '' };
      }
      if (command === 'lean' && args.some((arg) => String(arg).endsWith('claim.lean'))) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    };

    const result = formalVerifier.verifyFormalClaim({
      adapter: 'lean',
      statement: 'theorem recall_real_lean_fixture : True :=',
      proof: 'by trivial',
    }, { commandRunner });
    const gate = promotionGates.evaluatePromotionGate(result);

    expect(result).toMatchObject({
      adapter: 'lean',
      status: 'verified',
      passed: true,
      promotionDecision: 'verified_claim',
    });
    expect(result.verifierRun.adapterDetails).toMatchObject({
      command: 'lean',
      mode: 'lean',
      available: true,
      version: 'Lean 4.99.0 test',
    });
    expect(result.proofArtifact.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(gate.allowed).toBe(true);
    expect(calls.some((call) => call.command === 'lean' && call.args.some((arg) => String(arg).endsWith('claim.lean')))).toBe(true);
  });
});
