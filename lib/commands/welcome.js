'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const meridian = require('../meridian-core');
const { table } = require('../format');
const cliConfig = require('../cli-config');
const welcome = require('../welcome');
const outsiderTrial = require('../outsider-trial');

function csv(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function printDoctor(report) {
  console.log(chalk.bold('\nRecall Welcome Doctor\n'));
  console.log(`Status: ${report.status === 'ready' ? chalk.green(report.status) : chalk.yellow(report.status)}`);
  console.log('');
  table(report.checks.map((check) => [
    check.severity,
    check.id,
    check.path || check.expectedPrefix || '-',
    check.title,
  ]), ['Severity', 'Check', 'Path', 'Title']);
  const remediations = report.checks.filter((check) => check.remediation);
  if (remediations.length) {
    console.log('');
    console.log(chalk.bold('Remediation'));
    for (const check of remediations) {
      console.log(`- ${check.id}: ${check.remediation}`);
    }
  }
  console.log('');
}

function printDiscovery(report) {
  console.log(chalk.bold('\nRecall Welcome Discovery\n'));
  console.log(`Status: ${chalk.cyan(report.status)}`);
  console.log(`Roots:  ${report.roots.join(', ') || '-'}`);
  console.log('');

  if (report.projects.length) {
    table(report.projects.map((project) => [
      project.unsafeActiveSource ? 'blocked' : 'ready',
      project.path,
      project.planCommand,
    ]), ['Status', 'Project', 'Next Command']);
    console.log('');
  }

  if (report.sources.length) {
    table(report.sources.map((source) => [
      source.source,
      source.kind,
      source.unsafeActiveSource ? 'blocked' : 'ready',
      source.path,
    ]), ['Source', 'Kind', 'Status', 'Path']);
    console.log('');
  }

  if (!report.projects.length && !report.sources.length) {
    console.log(chalk.gray('No known sources found automatically. Provide a local path with `recall welcome plan <project-path>` or import an explicit export with `recall import-history import`.'));
    console.log('');
  }

  console.log(chalk.bold('AI-session adapters'));
  table(report.adapters.map((adapter) => [
    adapter.source,
    adapter.status || 'available',
    adapter.command,
  ]), ['Source', 'Status', 'Command']);
  console.log('');
}

function printProjectPlan(report) {
  const plan = report.plan;
  const color = plan.ok ? chalk.green : chalk.red;
  console.log(chalk.bold('\nRecall Welcome Project Plan\n'));
  console.log(`Status:  ${color(plan.status)}`);
  console.log(`Project: ${chalk.cyan(plan.projectPath)}`);
  console.log(`Stage:   ${chalk.cyan(plan.stagingProject)}`);
  console.log(`Trust:   ${plan.safety.importTrustState} / ${plan.safety.initialPartition}`);
  console.log('');

  if (plan.findings.length) {
    table(plan.findings.map((finding) => [
      finding.severity,
      finding.id,
      finding.message,
    ]), ['Severity', 'Finding', 'Message']);
    console.log('');
  }

  if (report.nextSteps.length) {
    table(report.nextSteps.map((step) => [
      step.id,
      step.title,
      step.command,
    ]), ['Step', 'Purpose', 'Command']);
    console.log('');
  }
}

function printGuide(report) {
  console.log(chalk.bold('\nRecall Welcome\n'));
  table(report.phases.map((phase) => [
    phase.id,
    phase.title,
    phase.command,
  ]), ['Phase', 'Purpose', 'Command']);
  console.log('');
}

function printReview(report) {
  console.log(chalk.bold('\nRecall Welcome Review\n'));
  console.log(`Status:  ${chalk.cyan(report.status)}`);
  console.log(`Project: ${chalk.cyan(report.project)}`);
  console.log('');

  if (!report.reconstructions.length) {
    console.log(chalk.gray(report.emptyState.message));
    for (const command of report.emptyState.nextCommands) console.log(`  ${chalk.cyan(command)}`);
    console.log('');
    return;
  }

  table(report.reconstructions.map((item) => [
    item.id,
    item.projectName,
    item.status,
    String(item.evidenceCount),
    item.sources.join(', ') || '-',
    item.recommendation,
  ]), ['ID', 'Project', 'Status', 'Evidence', 'Sources', 'Recommendation']);
  console.log('');
}

function printActions(report) {
  console.log(chalk.bold('\nRecall Welcome Actions\n'));
  console.log(`Status:  ${chalk.cyan(report.status)}`);
  console.log(`Project: ${chalk.cyan(report.project)}`);
  console.log('');

  if (!report.actions.length) {
    console.log(chalk.gray(report.emptyState.message));
    for (const command of report.emptyState.nextCommands) console.log(`  ${chalk.cyan(command)}`);
    console.log('');
    return;
  }

  table(report.actions.map((action) => [
    action.priority,
    action.project,
    action.kind,
    action.title,
    action.command,
  ]), ['Priority', 'Project', 'Kind', 'Action', 'Command']);
  console.log('');
}

function printOrganizationPacket(packet) {
  console.log(chalk.bold('\nRecall Welcome Organize Packet\n'));
  console.log(`Status:  ${chalk.cyan(packet.status)}`);
  console.log(`Project: ${chalk.cyan(packet.project)}`);
  console.log('');
  if (!packet.decisions.length) {
    console.log(chalk.gray('No draft project reconstructions found to organize.'));
    console.log('');
    return;
  }
  table(packet.decisions.map((decision) => [
    decision.reconstructionId,
    decision.currentProjectName,
    decision.decision,
    String(decision.evidenceCount),
    decision.sources.join(', ') || '-',
  ]), ['ID', 'Project', 'Default Decision', 'Evidence', 'Sources']);
  console.log('');
  console.log(chalk.gray('Use --json to edit this packet, then apply it with `recall welcome organize-apply <packet.json>`.'));
  console.log('');
}

function printOrganizationApply(report) {
  console.log(chalk.bold('\nRecall Welcome Organization Applied\n'));
  console.log(`Status:  ${chalk.green(report.status)}`);
  console.log(`Project: ${chalk.cyan(report.project)}`);
  console.log('');
  table(report.results.map((result) => [
    result.reconstructionId,
    result.decision,
    result.status,
    result.promotionState || '-',
  ]), ['ID', 'Decision', 'Status', 'Promotion State']);
  console.log('');
}

function printWalkthroughPacket(packet) {
  console.log(chalk.bold('\nRecall First-Run Walkthrough\n'));
  console.log(`Directory: ${chalk.cyan(packet.outputDir)}`);
  console.log('');
  table(packet.written.map((file) => [file]), ['Written Files']);
  console.log('');
  table(packet.commands.map((command) => [
    command.id,
    command.command,
  ]), ['Step', 'Command']);
}

module.exports = function(program) {
  const command = program
    .command('welcome')
    .description('Guide first-run setup, project import, and draft Recall reconstruction')
    .action(() => {
      printGuide(welcome.buildWelcomeGuide());
    });

  command
    .command('walkthrough')
    .description('Create the standard first-run walkthrough packet')
    .option('--root <path>', 'Workspace root for the walkthrough', process.cwd())
    .option('--data-dir <path>', 'Temporary MERIDIAN_DATA directory used for the walkthrough')
    .option('--output-dir <path>', 'Directory where packet files should be written')
    .option('--participant-id <id>', 'Non-sensitive participant identifier', 'first-run')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const packet = outsiderTrial.writeOutsiderTrialPacket({
          root: opts.root,
          dataDir: opts.dataDir,
          outputDir: opts.outputDir,
          outsiderId: opts.participantId,
        });
        if (opts.json) {
          console.log(JSON.stringify(packet, null, 2));
          return;
        }
        printWalkthroughPacket(packet);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('doctor')
    .description('Check whether Recall is ready to run a local first-use import')
    .option('--data-dir <path>', 'Recall data directory to check')
    .option('--cwd <path>', 'Workspace path to check', process.cwd())
    .option('--json', 'Print JSON')
    .action((opts) => {
      const report = welcome.buildWelcomeDoctor({
        cwd: opts.cwd,
        dataDir: opts.dataDir || cliConfig.getDataDir(),
      });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.status === 'blocked') process.exitCode = 1;
        return;
      }
      printDoctor(report);
      if (report.status === 'blocked') process.exitCode = 1;
    });

  command
    .command('discover')
    .description('Find local projects and known AI/coding history sources before importing')
    .option('--root <paths>', 'Comma-separated roots to scan; defaults to home directory')
    .option('--max-depth <n>', 'Maximum folder depth for Git project discovery', (value) => parseInt(value, 10), 4)
    .option('--json', 'Print JSON')
    .action((opts) => {
      const report = welcome.buildWelcomeDiscovery({
        roots: csv(opts.root),
        maxDepth: opts.maxDepth,
      });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      printDiscovery(report);
    });

  command
    .command('plan <path>')
    .description('Create a draft-only import plan for one local project')
    .option('--project <project>', 'Staging project for imported evidence')
    .option('--target-project <project>', 'Target project identity for generated review commands')
    .option('--json', 'Print JSON')
    .action((projectPath, opts) => {
      const report = welcome.buildWelcomeProjectPlan(projectPath, opts);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (!report.plan.ok) process.exitCode = 1;
        return;
      }
      printProjectPlan(report);
      if (!report.plan.ok) process.exitCode = 1;
    });

  command
    .command('review')
    .description('Summarize draft project reconstructions awaiting human review')
    .option('--project <project>', 'Staging project to review', 'recall-imports')
    .option('--json', 'Print JSON')
    .action((opts) => {
      let kb;
      try {
        kb = meridian.init(cliConfig.getDataDir());
        const report = welcome.buildWelcomeReview(kb, opts);
        kb.close();
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printReview(report);
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('actions')
    .description('Suggest next actions from draft project reconstructions')
    .option('--project <project>', 'Staging project to inspect', 'recall-imports')
    .option('--json', 'Print JSON')
    .action((opts) => {
      let kb;
      try {
        kb = meridian.init(cliConfig.getDataDir());
        const report = welcome.buildWelcomeActions(kb, opts);
        kb.close();
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printActions(report);
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('organize')
    .description('Create an editable packet for correcting draft project reconstructions')
    .option('--project <project>', 'Staging project to organize', 'recall-imports')
    .option('--output <path>', 'Write packet JSON to a file')
    .option('--json', 'Print JSON')
    .action((opts) => {
      let kb;
      try {
        kb = meridian.init(cliConfig.getDataDir());
        const packet = welcome.buildWelcomeOrganizationPacket(kb, opts);
        kb.close();
        if (opts.output) {
          const outputPath = path.resolve(opts.output);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`);
        }
        if (opts.json) {
          console.log(JSON.stringify(packet, null, 2));
          return;
        }
        printOrganizationPacket(packet);
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('organize-check <packet>')
    .description('Validate an edited welcome organization packet without mutating Recall')
    .option('--json', 'Print JSON')
    .action((packetPath, opts) => {
      try {
        const packet = JSON.parse(fs.readFileSync(path.resolve(packetPath), 'utf8'));
        const validation = welcome.validateWelcomeOrganizationPacket(packet);
        if (opts.json) {
          console.log(JSON.stringify(validation, null, 2));
          if (!validation.ok) process.exitCode = 1;
          return;
        }
        console.log(chalk.bold('\nRecall Welcome Organization Check\n'));
        console.log(`Status: ${validation.ok ? chalk.green(validation.status) : chalk.red(validation.status)}`);
        if (validation.issues.length) {
          for (const issue of validation.issues) console.log(`- ${issue}`);
        }
        console.log('');
        if (!validation.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('organize-apply <packet>')
    .description('Apply a reviewed welcome organization packet')
    .option('--json', 'Print JSON')
    .action((packetPath, opts) => {
      let kb;
      try {
        const packet = JSON.parse(fs.readFileSync(path.resolve(packetPath), 'utf8'));
        kb = meridian.init(cliConfig.getDataDir());
        const report = welcome.applyWelcomeOrganizationPacket(kb, packet);
        kb.close();
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printOrganizationApply(report);
      } catch (err) {
        if (kb) kb.close();
        console.error(chalk.red(`Error: ${err.message}`));
        if (err.validation && opts.json) console.log(JSON.stringify(err.validation, null, 2));
        process.exitCode = 1;
      }
    });
};
