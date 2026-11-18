// Help text rendering. Everything is derived from the `commands` table of
// cli.js (and GLOBAL_FLAGS) so usage, errors and the README table never drift.

/**
 * @typedef {{type:'boolean'|'string'|'number'|'list', alias?:string, description?:string, value?:string}} FlagDef
 * @typedef {{name:string, summary:string, usage:string, flags:Record<string,FlagDef>, run:Function}} CommandDef
 */

/** @param {string} name @param {FlagDef} def */
function flagLabel(name, def) {
  const alias = def.alias ? `-${def.alias}, ` : "";
  const value = def.type === "boolean" ? "" : ` <${def.value ?? (def.type === "number" ? "n" : "value")}>`;
  return `${alias}--${name}${value}`;
}

/** @param {Record<string,FlagDef>} flags @param {string} indent */
function renderFlags(flags, indent = "  ") {
  const rows = Object.entries(flags).map(([name, def]) => [flagLabel(name, def), def.description ?? ""]);
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, text]) => `${indent}${label.padEnd(width)}  ${text}`.trimEnd()).join("\n");
}

/**
 * @param {CommandDef[]} commands
 * @param {Record<string,FlagDef>} globalFlags
 * @param {string} version
 */
export function renderHelp(commands, globalFlags, version) {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines = [
    `inactivity ${version}`,
    "Spread GitHub Projects tasks over team members' Claude accounts (Pharo projects, beta).",
    "",
    "Usage: inactivity <command> [options]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Global options (accepted by every command):",
    renderFlags(globalFlags),
    "",
    "Run `inactivity <command> --help` for the options of one command.",
    "Exit codes: 0 ok, 1 error, 2 usage, 3 doctor found a failing check, 4 run ended with a task-level failure.",
  ];
  return lines.join("\n");
}

/** @param {CommandDef} command @param {Record<string,FlagDef>} globalFlags */
export function renderCommandHelp(command, globalFlags) {
  const lines = [`inactivity ${command.name}: ${command.summary}`, "", `Usage: ${command.usage}`];
  if (Object.keys(command.flags).length) {
    lines.push("", "Options:", renderFlags(command.flags));
  }
  lines.push("", "Global options: " + Object.keys(globalFlags).map((n) => `--${n}`).join(" "));
  return lines.join("\n");
}

/** Markdown table of the commands, used to keep the README in sync. @param {CommandDef[]} commands */
export function commandsMarkdownTable(commands) {
  const rows = commands.map((c) => `| \`${c.usage.replace(/\|/g, "\\|")}\` | ${c.summary} |`);
  return ["| Command | Purpose |", "| --- | --- |", ...rows].join("\n");
}

/** Human formatter for results printed without --json. @param {unknown} value */
export function formatText(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}-`;
  if (typeof value !== "object") return `${pad}${String(value)}`;
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}(none)`;
    if (value.every((v) => v === null || typeof v !== "object")) return `${pad}${value.join(", ")}`;
    return value
      .map((v) => {
        const inner = formatText(v, indent + 1).split("\n");
        inner[0] = `${pad}- ${inner[0].trimStart()}`;
        return inner.join("\n");
      })
      .join("\n");
  }
  const lines = [];
  for (const [key, v] of Object.entries(value)) {
    if (v !== null && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
      const simple = Array.isArray(v) && v.every((x) => x === null || typeof x !== "object");
      if (simple) lines.push(`${pad}${key}: ${v.join(", ")}`);
      else lines.push(`${pad}${key}:`, formatText(v, indent + 1));
    } else if (v !== null && typeof v === "object") {
      lines.push(`${pad}${key}: ${Array.isArray(v) ? "(none)" : "{}"}`);
    } else {
      lines.push(`${pad}${key}: ${v === null || v === undefined ? "-" : v}`);
    }
  }
  return lines.join("\n");
}
