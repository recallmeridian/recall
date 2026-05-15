'use strict';

// recall consolidate — KB-entry consolidation CLI.
//
// Slice 0 ships duplicate detection only. Slices 1+ (not built) will add
// LLM-as-judge for borderline clusters, propose-merge candidates, and a
// pending-consolidation queue. This first slice surfaces the candidates;
// it does not modify the KB.

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const { clusterDuplicates } = require('../consolidation/duplicate-detector');
const { judgeCluster } = require('../consolidation/cluster-judge');
const {
  buildMergeProposal,
  writeMergeProposal,
  readMergeProposals,
  setProposalState,
  applyMergeProposal,
  defaultPendingDir,
} = require('../consolidation/merge-proposal');
const { table } = require('../format');

function getKb() {
  const cfg = cliConfig.read();
  return meridian.init(cliConfig.getDataDir(), { llm: cfg.llm });
}

module.exports = function(program) {
  const command = program
    .command('consolidate')
    .description('KB-entry consolidation: detect near-duplicates within a project/category. Slice 0 = detect only, no merges or writes.');

  command
    .command('detect')
    .description('Scan a project (optionally a category) for near-duplicate entries and print clusters. No KB modifications.')
    .requiredOption('--project <id>', 'Project namespace to scan')
    .option('--category <name>', 'Limit to a single category (e.g. decisions, lessons)')
    .option('--threshold <n>', 'Pairwise similarity threshold (0..1)', '0.6')
    .option('--limit <n>', 'Maximum clusters to print', '20')
    .option('--output-dir <path>', 'Write each cluster as a JSON file under this dir (default: skip)')
    .option('--json', 'Print result as JSON')
    .action((opts) => {
      const kb = getKb();
      try {
        const threshold = Number(opts.threshold);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          throw new Error('--threshold must be a number between 0 and 1');
        }

        const categories = opts.category
          ? [opts.category]
          : ['decisions', 'lessons', 'features', 'milestones', 'todos', 'plans'];

        const allEntries = [];
        for (const cat of categories) {
          let entries = [];
          try {
            entries = kb.listEntries(opts.project, cat, { limit: 500 }) || [];
          } catch (_) {
            continue;
          }
          for (const e of entries) {
            allEntries.push({
              id: e.id,
              name: e.name,
              description: e.description,
              category: cat,
            });
          }
        }

        // Detect within each category separately — duplicates across
        // categories are usually false positives.
        const allClusters = [];
        let totalScanned = 0;
        let totalComparisons = 0;
        for (const cat of categories) {
          const inCat = allEntries.filter((e) => e.category === cat);
          if (inCat.length < 2) {
            totalScanned += inCat.length;
            continue;
          }
          const result = clusterDuplicates(inCat, { threshold });
          totalScanned += result.scanned;
          totalComparisons += result.comparisons;
          for (const cluster of result.clusters) {
            cluster.project = opts.project;
            cluster.category = cat;
            allClusters.push(cluster);
          }
        }

        allClusters.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
        const printed = allClusters.slice(0, Number(opts.limit));

        let writtenCount = 0;
        if (opts.outputDir) {
          const outDir = path.resolve(opts.outputDir);
          fs.mkdirSync(outDir, { recursive: true });
          for (const cluster of allClusters) {
            const fileName = `${cluster.project}__${cluster.category}__${cluster.id}.json`;
            fs.writeFileSync(path.join(outDir, fileName), JSON.stringify(cluster, null, 2));
            writtenCount += 1;
          }
        }

        const summary = {
          project: opts.project,
          threshold,
          scanned: totalScanned,
          comparisons: totalComparisons,
          clusterCount: allClusters.length,
          printed: printed.length,
          written: writtenCount,
          outputDir: opts.outputDir ? path.resolve(opts.outputDir) : null,
        };

        if (opts.json) {
          console.log(JSON.stringify({ summary, clusters: printed }, null, 2));
          return;
        }

        console.log(chalk.bold('\nConsolidation — Duplicate Detection (Slice 0)\n'));
        console.log(`Project:     ${opts.project}`);
        console.log(`Categories:  ${categories.join(', ')}`);
        console.log(`Threshold:   ${threshold}`);
        console.log(`Scanned:     ${summary.scanned} entries`);
        console.log(`Comparisons: ${summary.comparisons}`);
        console.log(`Clusters:    ${chalk.yellow(allClusters.length)} (printing ${printed.length})`);

        if (printed.length === 0) {
          console.log(chalk.gray('\nNo near-duplicate clusters at this threshold.\n'));
          return;
        }

        console.log('');
        for (const c of printed) {
          console.log(chalk.bold(`Cluster ${c.id}`) + chalk.dim(`  [${c.category}]  avgSim=${c.avgSimilarity}  members=${c.memberIds.length}  pairs=${c.pairCount}`));
          for (const m of c.memberSummaries) {
            console.log(`  ${chalk.cyan(m.id)}`);
            console.log(`    ${m.name.slice(0, 100)}`);
          }
          console.log('');
        }

        if (opts.outputDir) {
          console.log(chalk.gray(`Wrote ${writtenCount} cluster JSON files under ${summary.outputDir}`));
        } else {
          console.log(chalk.gray(`(no --output-dir; clusters printed to terminal only)`));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        if (typeof kb.close === 'function') kb.close();
      }
    });

  // Slice 1a: judge — run detector + LLM judgement on top N clusters,
  // write MergeProposals to pending-consolidation queue.
  command
    .command('judge')
    .description('Slice 1a — detect clusters, call the configured LLM to judge each, write MergeProposals to ~/.recall/pending-consolidation/<project>/')
    .requiredOption('--project <id>', 'Project namespace to scan')
    .option('--category <name>', 'Limit to a single category')
    .option('--threshold <n>', 'Pairwise similarity threshold (0..1)', '0.6')
    .option('--top <n>', 'Number of top clusters to judge (default 5)', '5')
    .option('--output-dir <path>', 'Override pending-consolidation directory')
    .option('--temperature <t>', 'LLM temperature override')
    .option('--json', 'Print result as JSON')
    .action(async (opts) => {
      const kb = getKb();
      try {
        const llm = kb.getLlmProvider();
        const threshold = Number(opts.threshold);
        const top = Number(opts.top);

        const categories = opts.category
          ? [opts.category]
          : ['decisions', 'lessons', 'features', 'milestones', 'todos', 'plans'];

        const allClusters = [];
        for (const cat of categories) {
          let entries = [];
          try { entries = kb.listEntries(opts.project, cat, { limit: 500 }) || []; } catch (_) { continue; }
          if (entries.length < 2) continue;
          const result = clusterDuplicates(
            entries.map((e) => ({ id: e.id, name: e.name, description: e.description })),
            { threshold }
          );
          for (const c of result.clusters) {
            c.project = opts.project;
            c.category = cat;
            c._entries = entries; // keep for judgement step
            allClusters.push(c);
          }
        }
        allClusters.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
        const targetClusters = allClusters.slice(0, top);

        if (targetClusters.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ proposals: [], reason: 'no_clusters_at_threshold' }, null, 2));
            return;
          }
          console.log(chalk.gray(`\nNo clusters at threshold ${threshold}.\n`));
          return;
        }

        const tempParam = opts.temperature !== undefined ? Number(opts.temperature) : undefined;
        const outputDir = opts.outputDir;
        const written = [];

        for (const cluster of targetClusters) {
          const fullEntries = cluster._entries.filter((e) => cluster.memberIds.includes(e.id));
          delete cluster._entries; // strip before persisting
          const judgement = await judgeCluster(cluster, fullEntries, llm, { temperature: tempParam });
          const proposal = buildMergeProposal({
            cluster,
            judgement,
            project: opts.project,
            category: cluster.category,
          });
          const filePath = writeMergeProposal(proposal, { outputDir });
          written.push({ proposal, filePath });
        }

        if (opts.json) {
          console.log(JSON.stringify({
            proposals: written.map((w) => ({ id: w.proposal.id, filePath: w.filePath, state: w.proposal.state, isDuplicate: w.proposal.judgement.isDuplicate, confidence: w.proposal.judgement.confidence })),
          }, null, 2));
          return;
        }

        console.log(chalk.bold('\nConsolidation — Judge (Slice 1a)\n'));
        console.log(`Provider:   ${chalk.cyan(llm.describe().provider)}  (model: ${llm.describe().defaultModel})`);
        console.log(`Project:    ${opts.project}`);
        console.log(`Clusters:   ${allClusters.length} detected, ${targetClusters.length} judged`);
        console.log(`Pending:    ${written.length} proposals written\n`);
        for (const { proposal, filePath } of written) {
          const j = proposal.judgement;
          console.log(chalk.bold(`Proposal: ${proposal.id}`));
          console.log(`  Cluster:    ${proposal.cluster.id}  [${proposal.category}]  members=${proposal.cluster.memberIds.length}  sim=${proposal.cluster.avgSimilarity}`);
          console.log(`  Verdict:    ${j.isDuplicate ? chalk.yellow('DUPLICATE') : chalk.gray('not duplicate')}  confidence=${j.confidence.toFixed(2)}`);
          if (j.synthesis) console.log(`  Synthesis:  ${j.synthesis.name.slice(0, 100)}`);
          if (j.rationale) console.log(`  Rationale:  ${j.rationale.slice(0, 200)}`);
          console.log(`  File:       ${chalk.dim(filePath)}`);
          console.log('');
        }
        console.log(chalk.gray('Review with: recall consolidate review --project ' + opts.project));
        console.log(chalk.gray('Apply with:  recall consolidate apply --proposal-id <id> --commit'));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        if (typeof kb.close === 'function') kb.close();
      }
    });

  // Slice 1b: review — list pending proposals
  command
    .command('review')
    .description('Slice 1b — list pending consolidation proposals')
    .option('--project <id>', 'Filter to a single project')
    .option('--state <state>', 'Filter by state (proposed | approved | rejected | applied)')
    .option('--output-dir <path>', 'Override pending-consolidation directory')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const all = readMergeProposals({ project: opts.project, outputDir: opts.outputDir });
        const filtered = opts.state
          ? all.filter((x) => x.proposal.state === opts.state)
          : all;

        if (opts.json) {
          console.log(JSON.stringify({
            proposals: filtered.map((x) => ({
              id: x.proposal.id,
              state: x.proposal.state,
              project: x.proposal.project,
              category: x.proposal.category,
              isDuplicate: x.proposal.judgement.isDuplicate,
              confidence: x.proposal.judgement.confidence,
              members: x.proposal.cluster.memberIds.length,
              file: x.file,
            })),
            total: filtered.length,
          }, null, 2));
          return;
        }

        console.log(chalk.bold('\nConsolidation Review Queue\n'));
        if (filtered.length === 0) {
          console.log(chalk.gray('No proposals match the filter.\n'));
          return;
        }
        for (const { proposal, file } of filtered) {
          const j = proposal.judgement;
          const verdict = j.isDuplicate ? chalk.yellow('DUP') : chalk.gray('non-dup');
          const stateColor = proposal.state === 'applied' ? chalk.green : (proposal.state === 'rejected' ? chalk.red : chalk.cyan);
          console.log(`${stateColor('[' + proposal.state + ']')} ${verdict}  ${proposal.id}`);
          console.log(`  Project=${proposal.project}  Category=${proposal.category}  Members=${proposal.cluster.memberIds.length}  Conf=${j.confidence.toFixed(2)}`);
          if (j.synthesis) console.log(`  Synthesis: ${j.synthesis.name.slice(0, 100)}`);
          console.log(chalk.dim(`  ${file}`));
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('approve <proposalId>')
    .description('Mark a proposal as approved (intent to apply)')
    .option('--output-dir <path>', 'Override pending-consolidation directory')
    .action((proposalId, opts) => {
      try {
        const updated = setProposalState(proposalId, 'approved', { outputDir: opts.outputDir });
        console.log(chalk.green(`Approved: ${updated.id}`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('reject <proposalId>')
    .description('Mark a proposal as rejected')
    .option('--output-dir <path>', 'Override pending-consolidation directory')
    .action((proposalId, opts) => {
      try {
        const updated = setProposalState(proposalId, 'rejected', { outputDir: opts.outputDir });
        console.log(chalk.gray(`Rejected: ${updated.id}`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('apply')
    .description('Slice 1c — apply an approved (or proposed) merge proposal. Default --dry-run; --commit to actually write the synthesis + supersede originals.')
    .requiredOption('--proposal-id <id>', 'The MergeProposal id to apply')
    .option('--output-dir <path>', 'Override pending-consolidation directory')
    .option('--commit', 'Actually write to the KB. Without this flag the command is a dry-run.')
    .option('--json', 'Print result as JSON')
    .action((opts) => {
      const kb = getKb();
      try {
        const found = readMergeProposals({ outputDir: opts.outputDir })
          .find((x) => x.proposal.id === opts.proposalId);
        if (!found) throw new Error(`Proposal not found: ${opts.proposalId}`);
        const result = applyMergeProposal({
          proposal: found.proposal,
          kb,
          commit: Boolean(opts.commit),
        });
        if (result.applied) {
          setProposalState(opts.proposalId, 'applied', { outputDir: opts.outputDir });
        }
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.bold('\nConsolidation Apply\n'));
        console.log(`Proposal:   ${opts.proposalId}`);
        console.log(`Mode:       ${opts.commit ? chalk.green('COMMIT') : chalk.yellow('DRY-RUN (pass --commit to write)')}`);
        if (result.applied) {
          console.log(`Applied:    ${chalk.green('yes')}  Synthesis id: ${chalk.cyan(result.synthesisEntry.id)}`);
          console.log(`Superseded: ${result.supersededIds.length} entries`);
          if (result.supersedeErrors.length > 0) {
            console.log(chalk.red(`  ${result.supersedeErrors.length} supersede errors:`));
            result.supersedeErrors.forEach((e) => console.log(chalk.red(`    ${e.id}: ${e.error}`)));
          }
        } else {
          console.log(`Applied:    ${chalk.gray('no')}  reason: ${result.reason}`);
          if (result.wouldWriteSynthesis) {
            console.log(`Would write: ${chalk.cyan(result.wouldWriteSynthesis.name)}`);
            console.log(`Would supersede: ${result.wouldSupersede.length}`);
            console.log(`Would retain canonical: ${result.wouldRetainCanonical.length}`);
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        if (typeof kb.close === 'function') kb.close();
      }
    });
};
