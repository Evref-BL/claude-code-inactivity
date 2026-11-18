// OS scheduler integration (design 8.3 / 8.4) and the pure tick decision state machine (8.1).
// Everything here is either pure or goes through injected `deps` (exec, fs, platform).

import { DispatchError, ensurePrivateDir } from './util.js';

export const DEFAULT_LABEL = 'io.inactivity.tick';
export const WIN_TASK_NAME = 'ClaudeCodeInActivity';
export const CRON_BEGIN = '# BEGIN inactivity';
export const CRON_END = '# END inactivity';
export const PLATFORMS = ['darwin', 'linux-systemd', 'linux-cron', 'win32'];

// ---------------------------------------------------------------------------
// Quoting helpers
// ---------------------------------------------------------------------------

/** @param {string} s */
export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** systemd ExecStart/Environment word quoting: double quotes when needed, `%` doubled. */
export function systemdQuote(arg) {
  const s = String(arg).replace(/%/g, '%%');
  if (s !== '' && /^[A-Za-z0-9_@%:./=+,-]+$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** POSIX shell single-quote quoting (used in crontab lines). */
export function shQuote(arg) {
  const s = String(arg);
  if (s !== '' && /^[A-Za-z0-9_@%:./=+,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Crontab treats an unescaped `%` as a newline. */
function cronEscape(s) {
  return s.replace(/%/g, '\\%');
}

/** Windows: wrap in double quotes, escaping embedded quotes the schtasks /TR way (\"). */
function winQuote(arg) {
  return '\\"' + String(arg) + '\\"';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Where each platform keeps its job files.
 * @param {{platform:string, home:string, label?:string}} opts
 */
export function schedulerPaths(opts) {
  const label = opts.label ?? DEFAULT_LABEL;
  const home = opts.home;
  switch (opts.platform) {
    case 'darwin':
      return { plist: `${home}/Library/LaunchAgents/${label}.plist` };
    case 'linux-systemd':
      return {
        service: `${home}/.config/systemd/user/inactivity.service`,
        timer: `${home}/.config/systemd/user/inactivity.timer`,
      };
    default:
      return {};
  }
}

function checkOpts(opts) {
  if (!PLATFORMS.includes(opts.platform)) {
    throw new DispatchError('bad-platform', `Unknown scheduler platform: ${opts.platform}`);
  }
  for (const k of ['nodePath', 'scriptPath', 'stateDir', 'home']) {
    if (typeof opts[k] !== 'string' || opts[k] === '') {
      throw new DispatchError('bad-schedule-options', `Missing option: ${k}`);
    }
  }
  const n = opts.intervalMinutes ?? 10;
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    throw new DispatchError('bad-schedule-options', 'intervalMinutes must be an integer in 1..60');
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {'darwin'|'linux-systemd'|'linux-cron'|'win32'} opts.platform
 * @param {string} opts.nodePath
 * @param {string} opts.scriptPath
 * @param {number} [opts.intervalMinutes]
 * @param {Record<string,string>} [opts.env]        PATH etc. captured at install time
 * @param {string} opts.stateDir
 * @param {string} [opts.label]
 * @param {string} opts.home
 * @param {string} [opts.pharoHome]                 exported as INACTIVITY_HOME when set
 * @param {number|null} [opts.uid]                  darwin: numeric uid for launchctl domain
 * @returns {{files:{path:string,content:string,mode:number}[], install:object[], uninstall:object[], notes:string[], cron?:{begin:string,end:string,block:string}}}
 */
export function renderScheduler(opts) {
  checkOpts(opts);
  const interval = opts.intervalMinutes ?? 10;
  const label = opts.label ?? DEFAULT_LABEL;
  const env = { ...(opts.env ?? {}) };
  const o = { ...opts, interval, label, env };
  const plan =
    opts.platform === 'darwin' ? renderDarwin(o)
    : opts.platform === 'linux-systemd' ? renderSystemd(o)
    : opts.platform === 'linux-cron' ? renderCron(o)
    : renderWindows(o);
  // The log directory must exist before the first tick (systemd/launchd/cron redirect into it).
  return { ...plan, dirs: [`${opts.stateDir}/logs`] };
}

function renderDarwin(o) {
  const { plist } = schedulerPaths(o);
  const uid = o.uid ?? '$(id -u)';
  const domain = `gui/${uid}`;
  const envVars = { ...o.env, HOME: o.home };
  if (o.pharoHome) envVars.INACTIVITY_HOME = o.pharoHome;
  const envXml = Object.keys(envVars)
    .sort()
    .map((k) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(envVars[k])}</string>`)
    .join('\n');
  const log = `${o.stateDir}/logs/tick.log`;
  const args = [o.nodePath, o.scriptPath, 'tick', '--json']
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${o.interval * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(o.stateDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
  return {
    files: [{ path: plist, content, mode: 0o644 }],
    install: [
      { cmd: 'launchctl', args: ['bootout', `${domain}/${o.label}`], ignoreFailure: true },
      { cmd: 'launchctl', args: ['bootstrap', domain, plist] },
    ],
    uninstall: [{ cmd: 'launchctl', args: ['bootout', `${domain}/${o.label}`], ignoreFailure: true }],
    removeFiles: [plist],
    notes: [
      'StartInterval does not fire while the Mac sleeps; the first tick after wake is the catch-up.',
      'Suggestion (not executed): sudo pmset repeat wakeorpoweron MTWRF 05:55:00',
    ],
  };
}

function renderSystemd(o) {
  const { service, timer } = schedulerPaths(o);
  const envVars = { ...o.env };
  if (o.pharoHome) envVars.INACTIVITY_HOME = o.pharoHome;
  const envLines = Object.keys(envVars)
    .sort()
    .map((k) => `Environment=${systemdQuote(`${k}=${envVars[k]}`)}`)
    .join('\n');
  const exec = [o.nodePath, o.scriptPath, 'tick', '--json'].map(systemdQuote).join(' ');
  const serviceText = `[Unit]
Description=inactivity tick (claim, resolve and run board tasks)

[Service]
Type=oneshot
WorkingDirectory=${systemdQuote(o.stateDir)}
${envLines}
ExecStart=${exec}
StandardOutput=append:${o.stateDir.replace(/%/g, '%%')}/logs/tick.log
StandardError=append:${o.stateDir.replace(/%/g, '%%')}/logs/tick.log
`;
  const timerText = `[Unit]
Description=inactivity tick timer

[Timer]
OnCalendar=*:0/${o.interval}
Persistent=true
RandomizedDelaySec=60
AccuracySec=1min
Unit=inactivity.service

[Install]
WantedBy=timers.target
`;
  return {
    files: [
      { path: service, content: serviceText, mode: 0o644 },
      { path: timer, content: timerText, mode: 0o644 },
    ],
    install: [
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', 'inactivity.timer'] },
    ],
    uninstall: [
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'inactivity.timer'], ignoreFailure: true },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'], ignoreFailure: true },
    ],
    removeFiles: [service, timer],
    notes: [
      'Persistent=true makes systemd run a missed tick right after wake (catch-up).',
      'To run without an open session (printed, not executed): loginctl enable-linger $USER',
    ],
  };
}

/** The crontab block (markers included, trailing newline). */
export function cronBlock(o) {
  const envLines = [];
  if (o.env?.PATH) envLines.push(`PATH=${o.env.PATH}`);
  if (o.pharoHome) envLines.push(`INACTIVITY_HOME=${o.pharoHome}`);
  const log = `${o.stateDir}/logs/tick.log`;
  const line =
    `*/${o.interval} * * * * ` +
    [o.nodePath, o.scriptPath, 'tick', '--json'].map((a) => cronEscape(shQuote(a))).join(' ') +
    ` >> ${cronEscape(shQuote(log))} 2>&1`;
  return [CRON_BEGIN, ...envLines, line, CRON_END].join('\n') + '\n';
}

function renderCron(o) {
  const block = cronBlock(o);
  return {
    files: [],
    install: [{ cmd: 'crontab', args: ['-'], cron: 'install' }],
    uninstall: [{ cmd: 'crontab', args: ['-'], cron: 'uninstall' }],
    removeFiles: [],
    cron: { begin: CRON_BEGIN, end: CRON_END, block },
    notes: ['cron does not catch up missed runs while the machine is off; the next tick after boot does.'],
  };
}

/** The schtasks create command line parts. */
function schtasksCreateArgs(o) {
  const tr = [o.nodePath, o.scriptPath].map(winQuote).join(' ') + ' tick --json';
  return ['/Create', '/TN', WIN_TASK_NAME, '/SC', 'MINUTE', '/MO', String(o.interval), '/TR', tr, '/F'];
}

function renderWindows(o) {
  return {
    files: [],
    install: [{ cmd: 'schtasks', args: schtasksCreateArgs(o) }],
    uninstall: [{ cmd: 'schtasks', args: ['/Delete', '/TN', WIN_TASK_NAME, '/F'], ignoreFailure: true }],
    removeFiles: [],
    notes: [
      'The task runs while the user is logged on; no password is stored.',
      'Catch-up after sleep ("run as soon as possible after a missed start") needs an XML import and is not generated in beta.',
    ],
  };
}

/**
 * Human-readable rendering of a command list (used for `schedule print` and the schtasks golden).
 * @param {{cmd:string,args:string[]}[]} commands
 */
export function formatCommands(commands) {
  return commands.map((c) => [c.cmd, ...c.args.map(displayQuote)].join(' ')).join('\n') + '\n';
}

function displayQuote(a) {
  return /^[A-Za-z0-9_@%:./=+,\\-]+$/.test(a) ? a : '"' + a + '"';
}

// ---------------------------------------------------------------------------
// crontab merging (pure)
// ---------------------------------------------------------------------------

/** Remove the inactivity block (and only it) from a crontab text. */
export function stripCronBlock(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === CRON_BEGIN) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.trim() === CRON_END) skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Replace (or append) the inactivity block; idempotent. */
export function mergeCrontab(existing, block) {
  const base = stripCronBlock(existing).replace(/\n+$/, '');
  return (base === '' ? '' : base + '\n') + block;
}

/** Crontab text after uninstall (may be empty). */
export function removeFromCrontab(existing) {
  const base = stripCronBlock(existing).replace(/\n+$/, '');
  return base === '' ? '' : base + '\n';
}

// ---------------------------------------------------------------------------
// Platform detection and install / uninstall
// ---------------------------------------------------------------------------

/** @param {import('./types.js').Deps|any} deps */
export async function detectPlatform(deps) {
  if (deps.platform === 'darwin') return 'darwin';
  if (deps.platform === 'win32') return 'win32';
  try {
    const r = await deps.exec('systemctl', ['--user', '--version']);
    if (r.code === 0) return 'linux-systemd';
  } catch {
    /* no systemctl */
  }
  return 'linux-cron';
}

async function readCrontab(deps) {
  try {
    const r = await deps.exec('crontab', ['-l']);
    return r.code === 0 ? r.stdout : '';
  } catch {
    return '';
  }
}

async function runCommands(deps, commands, results) {
  for (const c of commands) {
    let r;
    try {
      r = await deps.exec(c.cmd, c.args, c.stdin !== undefined ? { stdin: c.stdin } : undefined);
    } catch (e) {
      results.push({ cmd: c.cmd, args: c.args, ok: false, code: null });
      if (c.ignoreFailure) continue;
      throw new DispatchError('schedule-command-failed', `${c.cmd} could not run: ${e.message}`);
    }
    const ok = r.code === 0;
    results.push({ cmd: c.cmd, args: c.args, ok, code: r.code });
    if (!ok && !c.ignoreFailure) {
      throw new DispatchError(
        'schedule-command-failed',
        `${c.cmd} ${c.args.join(' ')} exited with ${r.code}: ${(r.stderr || '').trim()}`,
      );
    }
  }
}

/**
 * Write the job files and run the install commands.
 * @returns {Promise<{dryRun:boolean, files:string[], commands:object[], notes:string[]}>}
 */
export async function installScheduler(deps, plan, { dryRun = false } = {}) {
  const files = plan.files.map((f) => f.path);
  const planned = plan.install.map((c) => ({ cmd: c.cmd, args: c.args }));
  if (dryRun) return { dryRun: true, files, commands: planned, notes: plan.notes };
  for (const d of plan.dirs ?? []) await ensurePrivateDir(deps.fs, d); // logs: owner-only
  for (const f of plan.files) {
    await deps.fs.mkdir(dirnameOf(f.path), { recursive: true });
    await deps.fs.writeFile(f.path, f.content, { mode: f.mode });
    if (f.mode !== undefined) await deps.fs.chmod(f.path, f.mode);
  }
  const results = [];
  if (plan.cron) {
    const merged = mergeCrontab(await readCrontab(deps), plan.cron.block);
    await runCommands(deps, [{ cmd: 'crontab', args: ['-'], stdin: merged }], results);
  } else {
    await runCommands(deps, plan.install, results);
  }
  return { dryRun: false, files, commands: results, notes: plan.notes };
}

/**
 * Run the uninstall commands and remove generated files. Never throws on missing pieces.
 */
export async function uninstallScheduler(deps, plan, { dryRun = false } = {}) {
  const removed = [...(plan.removeFiles ?? [])];
  const planned = plan.uninstall.map((c) => ({ cmd: c.cmd, args: c.args }));
  if (dryRun) return { dryRun: true, files: removed, commands: planned, notes: [] };
  const results = [];
  if (plan.cron) {
    const text = removeFromCrontab(await readCrontab(deps));
    if (text === '') {
      await runCommands(deps, [{ cmd: 'crontab', args: ['-r'], ignoreFailure: true }], results);
    } else {
      await runCommands(deps, [{ cmd: 'crontab', args: ['-'], stdin: text, ignoreFailure: true }], results);
    }
  } else {
    await runCommands(deps, plan.uninstall, results);
  }
  for (const p of removed) {
    await deps.fs.rm(p, { force: true });
  }
  return { dryRun: false, files: removed, commands: results, notes: [] };
}

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p.slice(0, 1) : p.slice(0, i);
}

// ---------------------------------------------------------------------------
// copyApp (8.4 step 2)
// ---------------------------------------------------------------------------

async function exists(fs, p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy bin/, src/, templates/, package.json into <stateDir>/app/<version>/ and repoint
 * <stateDir>/app/current (symlink swapped by rename; a copy on Windows).
 * @returns {Promise<{dir:string, current:string, scriptPath:string}>}
 */
export async function copyApp(deps, { fromRoot, stateDir, version }) {
  if (!version || /[\\/]/.test(version) || version === '.' || version === '..') {
    throw new DispatchError('bad-version', `Invalid app version: ${version}`);
  }
  const fs = deps.fs;
  const appDir = `${stateDir}/app`;
  const dir = `${appDir}/${version}`;
  const current = `${appDir}/current`;
  await fs.mkdir(appDir, { recursive: true });
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const entry of ['bin', 'src', 'templates', 'schemas']) {
    const from = `${fromRoot}/${entry}`;
    if (await exists(fs, from)) await fs.cp(from, `${dir}/${entry}`, { recursive: true });
  }
  if (!(await exists(fs, `${fromRoot}/package.json`))) {
    throw new DispatchError('bad-app-root', `package.json not found in ${fromRoot}`);
  }
  await fs.cp(`${fromRoot}/package.json`, `${dir}/package.json`);
  if (deps.platform === 'win32') {
    const tmp = `${appDir}/current.new`;
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.cp(dir, tmp, { recursive: true });
    await fs.rm(current, { recursive: true, force: true });
    await fs.rename(tmp, current);
  } else {
    const tmp = `${appDir}/current.tmp-${deps.randomHex ? deps.randomHex() : '0000'}`;
    await fs.rm(tmp, { force: true });
    await fs.symlink(version, tmp);
    await fs.rename(tmp, current);
  }
  return { dir, current, scriptPath: `${current}/bin/inactivity.js` };
}

// ---------------------------------------------------------------------------
// schedulerStatus
// ---------------------------------------------------------------------------

/**
 * Probe whether the job is installed and whether it points at `scriptPath`.
 * @returns {Promise<{installed:boolean, scriptPath:string|null, current:boolean, platform:string}>}
 */
export async function schedulerStatus(deps, opts) {
  const platform = opts.platform ?? (await detectPlatform(deps));
  let found = null;
  let installed = false;
  try {
    if (platform === 'darwin') {
      const { plist } = schedulerPaths({ ...opts, platform });
      const text = await deps.fs.readFile(plist, 'utf8');
      installed = true;
      const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/.exec(text);
      if (m) found = xmlUnescape(m[1]);
    } else if (platform === 'linux-systemd') {
      const { service } = schedulerPaths({ ...opts, platform });
      const text = await deps.fs.readFile(service, 'utf8');
      installed = true;
      const m = /^ExecStart=(.*)$/m.exec(text);
      if (m) found = systemdWords(m[1])[1] ?? null;
    } else if (platform === 'linux-cron') {
      const text = await readCrontab(deps);
      if (text.includes(CRON_BEGIN)) {
        installed = true;
        const m = /^\*\/\d+ \* \* \* \* (.*?) >> /m.exec(text);
        if (m) found = shWords(m[1].replace(/\\%/g, '%'))[1] ?? null;
      }
    } else {
      const r = await deps.exec('schtasks', ['/Query', '/TN', WIN_TASK_NAME, '/FO', 'LIST', '/V']);
      if (r.code === 0) {
        installed = true;
        const m = /Task To Run:\s*(.*)/.exec(r.stdout);
        if (m) found = winWords(m[1])[1] ?? null;
      }
    }
  } catch {
    installed = false;
  }
  return {
    installed,
    scriptPath: found,
    current: installed && found !== null && opts.scriptPath !== undefined && found === opts.scriptPath,
    platform,
  };
}

function xmlUnescape(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function systemdWords(line) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) {
    words.push((m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]).replace(/%%/g, '%'));
  }
  return words;
}

function shWords(line) {
  const words = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) words.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]);
  return words;
}

function winWords(line) {
  const words = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) words.push(m[1] !== undefined ? m[1] : m[2]);
  return words;
}

// ---------------------------------------------------------------------------
// Pure tick decision state machine (8.1)
// ---------------------------------------------------------------------------

/**
 * @typedef {'idle'|'claim'|'wait'|'resolve'|'execute'|'done'} TickPhase
 *
 * @param {object} input
 * @param {import('./types.js').CyclePhases} input.phases   from policy.cyclePhases(team, now)
 * @param {Date} input.now
 * @param {object|null} [input.cycleState]  state.cycles[<projectId>:<cycle>] (4.5) or null
 * @param {boolean} [input.hasOffer]        policy.buildOffer(...) != null for the open round
 * @param {boolean} [input.paused]
 * @param {string|null} [input.limitUntil]  state.limit.until (ISO) or null
 * @param {boolean} [input.hasLeaks]        local leaked images/worktrees awaiting the janitor
 * @returns {{phase:TickPhase, reason:string, needsNetwork:boolean, claimRounds:(1|2)[], resolveRounds:(1|2)[], executeTasks:string[]}}
 */
export function decideTick(input) {
  const { phases, now } = input;
  const cs = input.cycleState ?? null;
  const hasOffer = input.hasOffer !== false;
  const out = (phase, reason, extra = {}) => ({
    phase,
    reason,
    needsNetwork: false,
    claimRounds: [],
    resolveRounds: [],
    executeTasks: [],
    ...extra,
  });

  if (!phases.active) return out('idle', 'inactive-day', { needsNetwork: false });
  if (input.paused) return out('idle', 'paused');

  const r1 = phases.rounds[1];
  const rounds = /** @type {(1|2)[]} */ ([1, 2]).filter((r) => phases.rounds[r]);
  const t = now.getTime();
  const end = phases.executionEnd.getTime();

  if (t < r1.claimStart.getTime()) {
    return out('idle', 'before-window', { needsNetwork: false });
  }
  if (t >= end) {
    return out('done', input.hasLeaks ? 'janitor-only' : 'execution-ended');
  }

  const claimRounds = [];
  const resolveRounds = [];
  for (const r of rounds) {
    const rp = phases.rounds[r];
    const claimed = cs?.claimed?.[r] ?? null;
    const resolved = cs?.resolved?.[r] ?? null;
    if (rp.state === 'open' && !claimed && hasOffer) claimRounds.push(r);
    if (rp.state === 'resolved' && !resolved) resolveRounds.push(r);
  }

  // Tasks assigned to me, not yet started, not finished.
  const assigned = cs?.assigned ?? {};
  const pending = Object.keys(assigned)
    .filter((k) => !assigned[k].startedAt && !assigned[k].outcome)
    .sort();
  const limited = input.limitUntil ? new Date(input.limitUntil).getTime() > t : false;
  const canExecute = phases.executionOpen && !limited && pending.length > 0;

  if (claimRounds.length > 0) {
    return out('claim', `round-${claimRounds[0]}-open`, {
      needsNetwork: true,
      claimRounds,
      resolveRounds,
      executeTasks: canExecute ? pending : [],
    });
  }
  if (resolveRounds.length > 0) {
    // Catch-up: a round that closed while the machine slept is resolved now, however late.
    return out('resolve', `round-${resolveRounds[0]}-resolved`, {
      needsNetwork: true,
      resolveRounds,
      executeTasks: canExecute ? pending : [],
    });
  }
  if (canExecute) {
    return out('execute', 'assigned-pending', { needsNetwork: true, executeTasks: pending });
  }

  // Nothing to do right now: is something still coming?
  const waiting = rounds.some((r) => {
    const s = phases.rounds[r].state;
    return s === 'pending' || s === 'open' || s === 'closed';
  });
  if (waiting) {
    const why = rounds.some((r) => phases.rounds[r].state === 'closed') ? 'grace-period' : 'window-pending';
    return out('wait', limited ? 'limit' : why);
  }
  if (limited && pending.length > 0) return out('wait', 'limit');
  return out('done', 'all-resolved');
}
