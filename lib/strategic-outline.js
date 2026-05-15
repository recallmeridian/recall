'use strict';

const fs = require('fs');
const path = require('path');

function readConfig(rootDir) {
  const filePath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(filePath)) return { __missing: true };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { __parseError: err.message };
  }
}

function emptyStatus(projectId, parseError = false) {
  return {
    id: projectId,
    milestonesDone: 0,
    milestonesTotal: 0,
    openTodos: 0,
    openDecisions: 0,
    openMilestones: [],
    openTodoEntries: [],
    mostRecentActivity: null,
    parseError,
  };
}

function gatherProjectStatus(rootDir, projectId) {
  const config = readConfig(rootDir);

  if (config.__parseError) {
    return emptyStatus(projectId, true);
  }
  if (config.__missing) {
    return emptyStatus(projectId, false);
  }

  const projects = Array.isArray(config.projects) ? config.projects : [];
  const project = projects.find((p) => p && p.id === projectId);
  if (!project) {
    return emptyStatus(projectId, false);
  }

  const milestoneList = Array.isArray(project.milestones) ? project.milestones : [];
  const todoList = Array.isArray(project.todos) ? project.todos : [];
  const decisionList = Array.isArray(project.decisions) ? project.decisions : [];

  const openMilestones = milestoneList.filter((m) => m && m.done !== true);
  const openTodoEntries = todoList.filter((t) => t && t.status !== 'done');

  return {
    id: projectId,
    milestonesDone: milestoneList.filter((m) => m && m.done === true).length,
    milestonesTotal: milestoneList.length,
    openTodos: openTodoEntries.length,
    openDecisions: decisionList.filter((d) => d && d.status !== 'decided').length,
    openMilestones,
    openTodoEntries,
    mostRecentActivity: null,
    parseError: false,
  };
}

function loadAlignment(rootDir) {
  const filePath = path.join(rootDir, 'peak-alignment.json');
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      northStar: '',
      peaks: [],
      foundation: [],
      offPeak: [],
      scaffolded: true,
    };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { ...raw, scaffolded: false };
}

function normaliseProjectEntry(entry) {
  if (typeof entry === 'string') return { id: entry };
  return {
    id: entry.id,
    crossPeakNote: entry.crossPeakNote || null,
    weight: entry.weight || null,
  };
}

function groupByPeak(statuses, alignment) {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const claimed = new Set();
  const claim = (id) => {
    if (!byId.has(id)) return null;
    claimed.add(id);
    return byId.get(id);
  };

  const peaks = (alignment.peaks || []).map((peak) => ({
    id: peak.id,
    label: peak.label,
    targetDate: peak.targetDate,
    successCriteria: peak.successCriteria,
    projects: (peak.projects || [])
      .map(normaliseProjectEntry)
      .map((entry) => {
        const status = claim(entry.id);
        return status ? { ...entry, status } : null;
      })
      .filter(Boolean),
  }));

  const foundation = (alignment.foundation || []).map((id) => claim(id)).filter(Boolean);
  const offPeak = (alignment.offPeak || []).map((id) => claim(id)).filter(Boolean);
  const unmapped = statuses.filter((s) => !claimed.has(s.id));

  return { peaks, foundation, offPeak, unmapped };
}

function projectLine(entry) {
  const s = entry.status;
  const milestoneStr = `${s.milestonesDone}/${s.milestonesTotal} milestones`;
  const todoStr = `${s.openTodos} todos`;
  const decisionStr = `${s.openDecisions} decisions`;
  return `▸ ${s.id} (${milestoneStr} · ${todoStr} · ${decisionStr})`;
}

function nextLine(entry) {
  const s = entry.status;
  const next = s.openMilestones.slice(0, 3).map((m) => m.text);
  while (next.length < 3) {
    const idx = next.length - s.openMilestones.length;
    if (idx < 0 || idx >= s.openTodoEntries.length) break;
    next.push(s.openTodoEntries[idx].text);
  }
  if (next.length === 0) return null;
  return `    Next: ${next.join(' · ')}`;
}

function projectBlock(entry) {
  const lines = [projectLine(entry)];
  if (entry.crossPeakNote) lines.push(`    ┊ ${entry.crossPeakNote}`);
  const next = nextLine(entry);
  if (next) lines.push(next);
  if (entry.status.openDecisions >= 5) {
    lines.push(`    Risk: ${entry.status.openDecisions} pending decisions`);
  }
  return lines.join('\n');
}

function peakBlock(peak, daysInvisible) {
  const date = peak.targetDate ? ` — target ${peak.targetDate}` : '';
  const header = `## 🏔️ ${peak.label}${date}`;
  const lines = [header];

  if (peak.projects.length === 0) {
    lines.push('');
    if (daysInvisible >= 90) {
      lines.push(`⛔ Invisible for ${daysInvisible} days. Auto-suggest: demote to research note.`);
    } else if (daysInvisible >= 30) {
      lines.push(`⚠ Invisible for ${daysInvisible} days. Declare or remove.`);
    } else {
      lines.push(`⚠ 0 declared experiments — declare gate experiments OR remove this peak from your peak list.`);
    }
  } else {
    for (const entry of peak.projects) {
      lines.push('');
      lines.push(projectBlock(entry));
    }
  }
  return lines.join('\n');
}

function renderMarkdown(grouped, alignment, opts) {
  const { generatedAt = new Date().toISOString(), daysInvisible = 0 } = opts || {};
  const out = [];
  out.push(`# Strategic Outline`);
  out.push('');
  out.push(`*Generated ${generatedAt}*`);
  out.push('');
  if (alignment.northStar) {
    out.push(`> ${alignment.northStar}`);
    out.push('');
  }

  for (const peak of grouped.peaks) {
    out.push(peakBlock(peak, daysInvisible));
    out.push('');
  }

  if (grouped.foundation.length > 0) {
    out.push('## 📚 Foundation');
    out.push('');
    for (const s of grouped.foundation) {
      out.push(`▸ ${s.id} (${s.openTodos} todos)`);
    }
    out.push('');
  }

  if (grouped.unmapped.length > 0) {
    out.push('## ⚠ Unmapped projects');
    out.push('');
    out.push(`These projects exist in config.json but are not assigned to any peak in \`peak-alignment.json\`:`);
    out.push('');
    for (const s of grouped.unmapped) {
      out.push(`▸ ${s.id} (${s.milestonesTotal} milestones · ${s.openTodos} todos)`);
    }
    out.push('');
  }

  if (grouped.offPeak.length > 0) {
    out.push('## 📋 Off-peak / Operations');
    out.push('');
    out.push(grouped.offPeak.map((s) => `${s.id} (${s.openTodos})`).join(' · '));
    out.push('');
  }

  return out.join('\n');
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pill(label, value) {
  return `<span class="pill">${htmlEscape(label)}: ${htmlEscape(value)}</span>`;
}

function htmlProjectBlock(entry) {
  const s = entry.status;
  const pills = [
    pill('milestones', `${s.milestonesDone}/${s.milestonesTotal}`),
    pill('todos', String(s.openTodos)),
    pill('decisions', String(s.openDecisions)),
  ].join(' ');

  const next = s.openMilestones.slice(0, 3).map((m) => m.text);
  while (next.length < 3) {
    const idx = next.length - s.openMilestones.length;
    if (idx < 0 || idx >= s.openTodoEntries.length) break;
    next.push(s.openTodoEntries[idx].text);
  }

  const lines = [`<div class="project"><strong>▸ ${htmlEscape(s.id)}</strong> ${pills}`];
  if (entry.crossPeakNote) {
    lines.push(`<div class="cross-peak-note">┊ ${htmlEscape(entry.crossPeakNote)}</div>`);
  }
  if (next.length > 0) {
    lines.push(`<div class="next">Next: ${next.map(htmlEscape).join(' · ')}</div>`);
  }
  if (s.openDecisions >= 5) {
    lines.push(`<div class="risk">Risk: ${s.openDecisions} pending decisions</div>`);
  }
  lines.push('</div>');
  return lines.join('\n');
}

function htmlPeakBlock(peak, daysInvisible) {
  const date = peak.targetDate ? ` — target ${htmlEscape(peak.targetDate)}` : '';
  const header = `<h2>🏔️ ${htmlEscape(peak.label)}${date}</h2>`;
  const lines = [`<section class="peak peak-${htmlEscape(peak.id)}">`, header];
  if (peak.projects.length === 0) {
    let level = 'soft';
    let text = '⚠ 0 declared experiments — declare gate experiments OR remove this peak from your peak list.';
    if (daysInvisible >= 90) {
      level = 'red';
      text = `⛔ Invisible for ${daysInvisible} days. Auto-suggest: demote to research note.`;
    } else if (daysInvisible >= 30) {
      level = 'orange';
      text = `⚠ Invisible for ${daysInvisible} days. Declare or remove.`;
    }
    lines.push(`<div class="empty-peak ${level}">${text}</div>`);
  } else {
    for (const entry of peak.projects) lines.push(htmlProjectBlock(entry));
  }
  lines.push('</section>');
  return lines.join('\n');
}

function renderHtml(grouped, alignment, opts) {
  const { generatedAt = new Date().toISOString(), daysInvisible = 0 } = opts || {};
  const css = `body{font-family:system-ui,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#14213d}h1{margin:0}.subtitle{color:#566273;font-size:13px;margin-bottom:24px}blockquote{border-left:3px solid #31572c;padding-left:12px;color:#3a3a3a;margin:0 0 24px}.peak{background:#fffaf0;border:1px solid rgba(20,33,61,.18);padding:16px;margin:0 0 16px}.peak-peak-3{background:#fef9f7}.project{margin:12px 0;padding:8px 0;border-top:1px solid rgba(20,33,61,.08)}.pill{display:inline-block;background:#efe7d2;border:1px solid rgba(20,33,61,.18);font-size:12px;padding:2px 8px;border-radius:10px;margin-right:4px}.cross-peak-note{font-style:italic;color:#566273;margin:6px 0 0 12px;font-size:13px}.next{margin-top:6px;font-size:14px}.risk{color:#b45309;font-size:13px;margin-top:4px}.empty-peak.soft{color:#b45309;padding:10px;background:#fff7e6;border-left:3px solid #b45309}.empty-peak.orange{color:#9a3412;padding:12px;background:#ffedd5;border-left:5px solid #ea580c;font-weight:600}.empty-peak.red{color:#7f1d1d;padding:14px;background:#fee2e2;border-left:6px solid #dc2626;font-weight:700}.unmapped{background:#fffbe6;border:1px solid #fbbf24;padding:12px}.off-peak{color:#566273;font-size:13px}`;

  const out = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>Strategic Outline</title>',
    `<style>${css}</style>`,
    '</head><body>',
    '<h1>Strategic Outline</h1>',
    `<div class="subtitle">Generated ${htmlEscape(generatedAt)}</div>`,
  ];
  if (alignment.northStar) out.push(`<blockquote>${htmlEscape(alignment.northStar)}</blockquote>`);
  for (const peak of grouped.peaks) out.push(htmlPeakBlock(peak, daysInvisible));

  if (grouped.foundation.length > 0) {
    out.push('<section class="peak"><h2>📚 Foundation</h2>');
    for (const s of grouped.foundation) {
      out.push(`<div class="project">▸ ${htmlEscape(s.id)} <span class="pill">${s.openTodos} todos</span></div>`);
    }
    out.push('</section>');
  }

  if (grouped.unmapped.length > 0) {
    out.push('<section class="unmapped"><h2>⚠ Unmapped projects</h2>');
    out.push('<p>These projects exist in config.json but are not assigned to any peak in <code>peak-alignment.json</code>:</p>');
    for (const s of grouped.unmapped) {
      out.push(`<div class="project">▸ ${htmlEscape(s.id)} <span class="pill">${s.milestonesTotal} milestones</span> <span class="pill">${s.openTodos} todos</span></div>`);
    }
    out.push('</section>');
  }

  if (grouped.offPeak.length > 0) {
    out.push('<section class="peak"><h2>📋 Off-peak / Operations</h2>');
    out.push(`<div class="off-peak">${grouped.offPeak.map((s) => `${htmlEscape(s.id)} (${s.openTodos})`).join(' · ')}</div>`);
    out.push('</section>');
  }

  out.push('</body></html>');
  return out.join('\n');
}

function escalatePeak(peakId, stateFile, now = new Date()) {
  let state = { invisibleSince: {} };
  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') state = parsed;
    } catch (_e) {
      // keep default
    }
  }
  state.invisibleSince = state.invisibleSince || {};

  if (!state.invisibleSince[peakId]) {
    state.invisibleSince[peakId] = now.toISOString();
    fs.mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return 0;
  }

  const since = new Date(state.invisibleSince[peakId]);
  const ms = now.getTime() - since.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function clearPeakInvisibility(peakId, stateFile) {
  if (!fs.existsSync(stateFile)) return;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_e) {
    return;
  }
  if (state && state.invisibleSince && state.invisibleSince[peakId]) {
    delete state.invisibleSince[peakId];
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
}

function listProjects(rootDir) {
  const config = readConfig(rootDir);
  if (config.__missing || config.__parseError) return [];
  const projects = Array.isArray(config.projects) ? config.projects : [];
  return projects.map((p) => p && p.id).filter(Boolean);
}

function regenerate(rootDir, opts = {}) {
  const now = opts.now || new Date();
  const stateFile = path.join(rootDir, 'strategic-outline-state.json');

  const projectIds = listProjects(rootDir);
  const statuses = projectIds.map((id) => gatherProjectStatus(rootDir, id));
  const alignment = loadAlignment(rootDir);
  const grouped = groupByPeak(statuses, alignment);

  // Track invisibility per peak; daysInvisible = max across empty peaks for v0 rendering
  let daysInvisible = 0;
  for (const peak of grouped.peaks) {
    if (peak.projects.length === 0) {
      const days = escalatePeak(peak.id, stateFile, now);
      if (days > daysInvisible) daysInvisible = days;
    } else {
      clearPeakInvisibility(peak.id, stateFile);
    }
  }

  const renderOpts = { generatedAt: now.toISOString(), daysInvisible };
  const md = renderMarkdown(grouped, alignment, renderOpts);
  const html = renderHtml(grouped, alignment, renderOpts);

  const markdownPath = path.join(rootDir, 'strategic-outline.md');
  const htmlPath = path.join(rootDir, 'strategic-outline.html');
  fs.writeFileSync(markdownPath, md);
  fs.writeFileSync(htmlPath, html);

  return { markdownPath, htmlPath, daysInvisible, projectCount: projectIds.length };
}

module.exports = {
  gatherProjectStatus, loadAlignment, groupByPeak,
  renderMarkdown, renderHtml,
  escalatePeak, clearPeakInvisibility,
  regenerate,
};
