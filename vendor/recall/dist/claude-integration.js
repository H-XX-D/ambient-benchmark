// R7 Claude integration helpers. Pure settings/config transforms only; bundled
// hook assets and full sync commands are later surfaces.
const AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const HOOK_MARKER = "recall-session-start.py";
const MCP_NAME = "recall";
export function recallHookGroups(hookCommandPath, opts) {
    const quoted = JSON.stringify(hookCommandPath);
    const writeGate = opts?.writeGate;
    // The python UserPromptSubmit/Stop hooks are fail-open: a crash or missing
    // interpreter just skips the marker stamp or the write gate, never blocking
    // the turn. The node write-gate hooks below are fail-closed: on the Stop
    // event, no durable write this turn holds the turn. Both can run side by
    // side, but only if the python entry runs first (it stamps the turn-start
    // marker the node Stop hook reads); array order below is load-bearing.
    const promptHooks = [{ type: "command", command: `python3 ${quoted} --prompt`, timeout: 10 }];
    const stopHooks = [{ type: "command", command: `python3 ${quoted} --stop`, timeout: 10 }];
    if (writeGate) {
        promptHooks.push({ type: "command", command: writeGate.promptHookCommand });
        stopHooks.push({ type: "command", command: writeGate.stopHookCommand });
    }
    return {
        SessionStart: {
            hooks: [{ type: "command", command: `python3 ${quoted}`, timeout: 15, statusMessage: "Consulting Recall memory..." }],
        },
        UserPromptSubmit: {
            hooks: promptHooks,
        },
        Stop: {
            hooks: stopHooks,
        },
    };
}
export function mergeClaudeSettings(existing, opts) {
    const next = { ...(existing ?? {}) };
    const changed = [];
    const groups = recallHookGroups(opts.hookCommandPath, opts.writeGate ? { writeGate: opts.writeGate } : undefined);
    const hooks = { ...(next.hooks ?? {}) };
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
        const previous = Array.isArray(hooks[event]) ? hooks[event] : [];
        const withoutRecall = previous.filter((group) => !isRecallHookGroup(group));
        const replacement = [...withoutRecall, groups[event]];
        if (JSON.stringify(previous) !== JSON.stringify(replacement))
            changed.push(`hooks.${event}`);
        hooks[event] = replacement;
    }
    next.hooks = hooks;
    const env = { ...(next.env ?? {}) };
    const disableAutoMemory = opts.disableAutoMemory ?? true;
    if (disableAutoMemory) {
        if (env[AUTO_MEMORY_ENV] !== "1") {
            env[AUTO_MEMORY_ENV] = "1";
            changed.push(`env.${AUTO_MEMORY_ENV}`);
        }
    }
    else if (AUTO_MEMORY_ENV in env) {
        delete env[AUTO_MEMORY_ENV];
        changed.push(`env.${AUTO_MEMORY_ENV} (removed)`);
    }
    next.env = env;
    return { next, changed };
}
export function upsertClaudeMcpServer(existing, mcpCommand) {
    const next = { ...(existing ?? {}) };
    const servers = { ...(next.mcpServers ?? {}) };
    const desired = { type: "stdio", command: mcpCommand, args: [], env: {} };
    const changed = JSON.stringify(servers[MCP_NAME]) !== JSON.stringify(desired);
    servers[MCP_NAME] = desired;
    next.mcpServers = servers;
    return { next, changed };
}
function isRecallHookGroup(group) {
    const hooks = group?.hooks;
    if (!Array.isArray(hooks))
        return false;
    return hooks.some((hook) => {
        const command = hook?.command;
        return typeof command === "string" && command.includes(HOOK_MARKER);
    });
}
