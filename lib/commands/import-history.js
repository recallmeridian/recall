'use strict';

const chalk = require('chalk');
const path = require('path');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');
const historyImport = require('../history-import');
const { buildProjectImportPlan } = require('../project-import-workflow');
const { confirm } = require('../prompt');

function csv(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function printSources(sources) {
  if (sources.length === 0) {
    console.log(chalk.gray('No known history sources found. Provide paths explicitly with import commands.\n'));
    return;
  }

  for (const source of sources) {
    console.log(`  ${chalk.cyan(source.source.padEnd(12))} ${source.kind.padEnd(9)} ${source.path}`);
  }
  console.log('');
}

async function confirmReadAccess(opts, details) {
  if (opts.yes) return true;

  console.log(chalk.bold('\nPermission required\n'));
  console.log('Recall will read local history from:');
  for (const line of details) console.log(`  ${chalk.cyan(line)}`);
  console.log(chalk.gray('\nImported content is staged as draft evidence in Recall. It is not promoted into active memory until you run a promote command.'));

  return confirm('Allow Recall to read and import this history?', false);
}

module.exports = function(program) {
  const command = program
    .command('import-history')
    .description('Scan, import, analyze, and promote prior AI/coding history');

  command
    .command('scan')
    .description('Find known AI chat, coding-session, and repository sources')
    .option('--root <paths>', 'Comma-separated roots to scan; defaults to home directory')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const sources = historyImport.scanSources({ roots: csv(opts.root) });
        if (opts.json) {
          console.log(JSON.stringify(sources, null, 2));
          return;
        }
        console.log(chalk.bold('\nHistory sources\n'));
        printSources(sources);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  command
    .command('project-plan <path>')
    .description('Build a safe draft-only project import plan before reading project files')
    .option('--project <project>', `Staging project (default: ${historyImport.DEFAULT_PROJECT})`)
    .option('--target-project <project>', 'Target project identity for generated review commands')
    .option('--now <iso>', 'Fixed timestamp for deterministic tests')
    .option('--json', 'Print JSON')
    .action((projectPath, opts) => {
      try {
        const plan = buildProjectImportPlan({
          path: projectPath,
          stagingProject: opts.project || historyImport.DEFAULT_PROJECT,
          targetProject: opts.targetProject,
        }, {
          now: opts.now,
        });
        if (opts.json) {
          console.log(JSON.stringify(plan, null, 2));
          if (!plan.ok) process.exitCode = 1;
          return;
        }
        const color = plan.ok ? chalk.green : chalk.red;
        console.log(color(`Project import plan: ${plan.status}`));
        console.log(`Project path: ${chalk.cyan(plan.projectPath)}`);
        console.log(`Staging project: ${chalk.cyan(plan.stagingProject)}`);
        console.log(`Trust: ${plan.safety.importTrustState} / ${plan.safety.initialPartition}`);
        if (plan.findings.length) {
          for (const finding of plan.findings) {
            console.log(`${finding.severity === 'blocker' ? chalk.red('blocker') : chalk.yellow('warn')}: ${finding.id} - ${finding.message}`);
          }
        }
        for (const item of plan.commands) console.log(`${chalk.cyan(item.id)}: ${item.command}`);
        if (!plan.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  command
    .command('import')
    .description('Import one source as draft evidence')
    .requiredOption('--source <source>', 'claude-ai, codex, claude-code, or repo')
    .requiredOption('--path <path>', 'Source file or directory path')
    .option('--project <project>', `Staging project (default: ${historyImport.DEFAULT_PROJECT})`)
    .option('-y, --yes', 'Skip permission prompt for scripted/non-interactive use')
    .action(async (opts) => {
      let kb;
      try {
        const allowed = await confirmReadAccess(opts, [
          `source: ${opts.source}`,
          `path:   ${path.resolve(opts.path)}`,
        ]);
        if (!allowed) {
          console.log(chalk.yellow('\nImport cancelled. No files were imported.\n'));
          return;
        }

        kb = meridian.init(getDataDir());
        const projectId = opts.project || historyImport.DEFAULT_PROJECT;
        const records = historyImport.loadRecordsFromSource(opts.source, opts.path);
        const result = historyImport.importRecords(kb, projectId, records);
        kb.close();

        console.log(chalk.green(`\nImported ${result.created.length} history evidence record(s).`));
        if (result.skipped.length) console.log(chalk.gray(`Skipped ${result.skipped.length} duplicate record(s).`));
        console.log(`Project: ${chalk.cyan(projectId)}`);
        console.log(chalk.gray('Run `recall import-history analyze` to build project reconstructions.\n'));
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  command
    .command('upload-project <path>')
    .description('Stage a local project repository and build its draft reconstruction')
    .option('--project <project>', `Staging project (default: ${historyImport.DEFAULT_PROJECT})`)
    .option('--promote', 'Promote generated project reconstruction after analysis')
    .option('-y, --yes', 'Skip permission prompt for scripted/non-interactive use')
    .action(async (projectPath, opts) => {
      let kb;
      try {
        const allowed = await confirmReadAccess(opts, [
          `project folder: ${path.resolve(projectPath)}`,
          'reads: README/package metadata, recent git history, and project text used for reconstruction',
        ]);
        if (!allowed) {
          console.log(chalk.yellow('\nProject upload cancelled. No files were imported.\n'));
          return;
        }

        kb = meridian.init(getDataDir());
        const projectId = opts.project || historyImport.DEFAULT_PROJECT;
        const records = historyImport.loadRecordsFromSource('repo', projectPath);
        const imported = historyImport.importRecords(kb, projectId, records);
        const summaries = historyImport.analyzeProject(kb, projectId);
        const uploadedKeys = new Set(records.map((record) => {
          return String(record.projectHint || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
        }));
        const generated = summaries.filter((summary) => uploadedKeys.has(summary.projectKey));
        const promoted = opts.promote
          ? generated.map((summary) => historyImport.promoteAnalysis(kb, projectId, `analysis-${summary.projectKey}`))
          : [];
        kb.close();

        console.log(chalk.green(`\nUploaded project history from ${projectPath}`));
        console.log(`Project: ${chalk.cyan(projectId)}`);
        console.log(`Evidence records added: ${chalk.cyan(imported.created.length)}`);
        if (imported.skipped.length) console.log(chalk.gray(`Duplicate evidence skipped: ${imported.skipped.length}`));
        for (const summary of generated) {
          console.log(`Analysis: ${chalk.cyan(`analysis-${summary.projectKey}`)} (${summary.evidenceCount} evidence record(s))`);
          if (summary.topKeywords.length) console.log(`Themes: ${summary.topKeywords.slice(0, 8).join(', ')}`);
        }
        if (promoted.length) {
          console.log(chalk.green(`Promoted ${promoted.length} reconstruction(s).`));
        } else {
          console.log(chalk.gray('Review with `recall browse recall-imports --category project-reconstruction`.'));
          console.log(chalk.gray('Promote with `recall import-history promote <analysis-id>`.\n'));
        }
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  command
    .command('upload-projects <root>')
    .description('Find and stage all Git projects below a parent folder')
    .option('--project <project>', `Staging project (default: ${historyImport.DEFAULT_PROJECT})`)
    .option('--max-depth <n>', 'Maximum folder depth to scan (default: 4)', (value) => parseInt(value, 10), 4)
    .option('--promote', 'Promote generated project reconstructions after analysis')
    .option('-y, --yes', 'Skip permission prompt for scripted/non-interactive use')
    .action(async (root, opts) => {
      let kb;
      try {
        const scanAllowed = await confirmReadAccess(opts, [
          `project root: ${path.resolve(root)}`,
          `scan depth:   ${opts.maxDepth}`,
          'reads: folder names while finding Git repositories, then repo metadata for each imported project',
        ]);
        if (!scanAllowed) {
          console.log(chalk.yellow('\nBulk project upload cancelled. No folders were scanned or imported.\n'));
          return;
        }

        const repos = historyImport.findGitRepos(root, { maxDepth: opts.maxDepth });
        if (repos.length === 0) {
          console.log(chalk.gray(`\nNo Git repositories found under ${root}.\n`));
          return;
        }
        if (!opts.yes) {
          console.log(chalk.bold('\nRepositories found\n'));
          for (const repo of repos) console.log(`  ${chalk.cyan(repo)}`);
          const importAllowed = await confirm('Import these repositories into draft Recall evidence?', false);
          if (!importAllowed) {
            console.log(chalk.yellow('\nBulk project upload cancelled. No files were imported.\n'));
            return;
          }
        }

        kb = meridian.init(getDataDir());
        const projectId = opts.project || historyImport.DEFAULT_PROJECT;
        let created = 0;
        let skipped = 0;

        for (const repo of repos) {
          const records = historyImport.loadRecordsFromSource('repo', repo);
          const result = historyImport.importRecords(kb, projectId, records);
          created += result.created.length;
          skipped += result.skipped.length;
        }

        const summaries = historyImport.analyzeProject(kb, projectId);
        const repoKeys = new Set(repos.map((repo) => {
          return String(path.basename(repo)).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
        }));
        const generated = summaries.filter((summary) => repoKeys.has(summary.projectKey));
        const promoted = opts.promote
          ? generated.map((summary) => historyImport.promoteAnalysis(kb, projectId, `analysis-${summary.projectKey}`))
          : [];
        kb.close();

        console.log(chalk.green(`\nUploaded ${repos.length} project(s) from ${root}`));
        console.log(`Project: ${chalk.cyan(projectId)}`);
        console.log(`Evidence records added: ${chalk.cyan(created)}`);
        if (skipped) console.log(chalk.gray(`Duplicate evidence skipped: ${skipped}`));
        for (const summary of generated) {
          console.log(`  ${chalk.cyan(`analysis-${summary.projectKey}`)} ${summary.evidenceCount} evidence record(s)`);
        }
        if (promoted.length) {
          console.log(chalk.green(`Promoted ${promoted.length} reconstruction(s).`));
        } else {
          console.log(chalk.gray('\nCross-query staged project memory with `recall search recall-imports <query>`.'));
          console.log(chalk.gray('Review with `recall browse recall-imports --category project-reconstruction`.'));
          console.log(chalk.gray('Promote with `recall import-history promote --all` when ready.\n'));
        }
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  command
    .command('analyze')
    .description('Cluster imported evidence into draft project reconstructions')
    .option('--project <project>', `Staging project (default: ${historyImport.DEFAULT_PROJECT})`)
    .option('--json', 'Print JSON')
    .action((opts) => {
      let kb;
      try {
        kb = meridian.init(getDataDir());
        const projectId = opts.project || historyImport.DEFAULT_PROJECT;
        const summaries = historyImport.analyzeProject(kb, projectId);
        kb.close();

        if (opts.json) {
          console.log(JSON.stringify(summaries, null, 2));
          return;
        }

        console.log(chalk.bold(`\nProject reconstructions in "${projectId}"\n`));
        if (summaries.length === 0) {
          console.log(chalk.gray('No imported evidence found yet.\n'));
          return;
        }
        for (const summary of summaries) {
          console.log(`${chalk.cyan(summary.projectKey)}  ${summary.evidenceCount} evidence record(s)`);
          if (summary.sources.length) console.log(`  Sources: ${summary.sources.join(', ')}`);
          if (summary.topKeywords.length) console.log(`  Themes:  ${summary.topKeywords.slice(0, 8).join(', ')}`);
          if (summary.likelyTodos.length) console.log(`  TODOs:   ${summary.likelyTodos.length} candidate line(s)`);
          if (summary.likelyDecisions.length) console.log(`  Decisions: ${summary.likelyDecisions.length} candidate line(s)`);
        }
        console.log(chalk.gray('\nReview entries with `recall browse recall-imports --category project-reconstruction`.'));
        console.log(chalk.gray('Promote with `recall import-history promote <analysis-id>`.\n'));
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  command
    .command('promote [entryId]')
    .description('Promote reviewed project reconstruction analysis into active Recall memory')
    .option('--project <project>', `Staging project (default: ${historyImport.DEFAULT_PROJECT})`)
    .option('--all', 'Promote all draft project reconstructions')
    .action((entryId, opts) => {
      let kb;
      try {
        const projectId = opts.project || historyImport.DEFAULT_PROJECT;
        kb = meridian.init(getDataDir());
        const promoted = opts.all
          ? historyImport.promoteAllAnalyses(kb, projectId)
          : [historyImport.promoteAnalysis(kb, projectId, entryId)];
        kb.close();

        console.log(chalk.green(`\nPromoted ${promoted.length} project reconstruction(s).`));
        for (const entry of promoted) console.log(`  ${chalk.cyan(entry.id)} ${entry.name}`);
        console.log('');
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
