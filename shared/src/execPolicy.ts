/**
 * Execution policy for the `execute` tool (binary allowlist).
 *
 * Single source of truth, shared by the agent and the VS Code extension: two
 * copies of this list would drift, and a drift here is a security boundary
 * silently opening.
 *
 * Scope: a guardrail against ACCIDENTS (and against silently bypassing the
 * audited git backend), NOT a sandbox. Any allowlisted interpreter can still
 * spawn whatever it likes; the reason `execute` has no shell is that the shell
 * re-parsed our payloads, and that failure mode is what this change removes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BinaryNotAllowedError } from './types';

export const EXEC_ALLOWLIST: ReadonlySet<string> = new Set<string>([
    'bash', 'sh', 'dash', 'ash', 'env', 'nice',
    'timeout', 'xargs', 'nohup', 'setsid', 'stdbuf', 'ionice',
    'ssh', 'scp', 'rsync', 'node', 'npm',
    'npx', 'yarn', 'pnpm', 'python', 'python3', 'pip',
    'pip3', 'uv', 'go', 'cargo', 'make', 'gcc',
    'g++', 'rg', 'grep', 'find', 'fd', 'sed',
    'awk', 'cut', 'tr', 'sort', 'uniq', 'wc',
    'head', 'tail', 'tee', 'diff', 'patch', 'dirname',
    'basename', 'realpath', 'readlink', 'which', 'true', 'false',
    'test', 'ls', 'cat', 'mkdir', 'rmdir', 'cp',
    'mv', 'rm', 'chmod', 'chown', 'touch', 'ln',
    'stat', 'file', 'tree', 'du', 'df', 'date',
    'sleep', 'pwd', 'id', 'whoami', 'hostname', 'printenv',
    'uname', 'ps', 'jq', 'yq', 'zg', 'sg',
    'ripsed', 'base64', 'md5sum', 'sha256sum', 'openssl', 'tar',
    'zip', 'unzip', 'gzip', 'gunzip', 'zcat', 'docker',
    'docker-compose', 'kubectl', 'helm', 'systemctl', 'crontab', 'curl',
    'wget', 'sqlite3', 'ldd', 'strace',
    'echo', 'printf', 'seq', 'expr', 'nproc', 'nl', 'od', 'xxd',
    'comm', 'join', 'split', 'paste', 'column', 'tac', 'truncate',
    'less', 'more', 'numfmt', 'shuf', 'tsort',
]);

/** Message used when a binary is rejected - lists what IS available. */
export function allowlistHint(): string {
    return 'Allowed: ' + Array.from(EXEC_ALLOWLIST).sort().join(', ');
}

/**
 * Resolve an allowlisted binary to a spawnable command.
 *
 * Rejects anything not on the allowlist, including path forms that would dodge
 * it: the check is on the BASENAME, and an absolute path must exist. A bare
 * name is returned as-is so PATH resolution happens normally; shell:false means
 * the name is never re-interpreted.
 */
export function resolveAllowedBinary(name: string): string {
    const base = path.basename(name);
    if (!EXEC_ALLOWLIST.has(base)) {
        throw new BinaryNotAllowedError(name, allowlistHint());
    }
    if (name.includes(path.sep)) {
        const abs = path.resolve(name);
        if (!fs.existsSync(abs)) {
            throw new Error(`Binary not found: ${abs}`);
        }
        return abs;
    }
    return base;
}
