import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SandboxRequest = {
  workspaceRoot: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
};

export type SandboxResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  auditId: string;
};

const allowedCommands = () => new Set(
  (process.env.AXIOM_TOOL_ALLOWED_COMMANDS ?? 'node,npm,git,rg,cat,python3')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

export class DockerSandboxExecutor {
  readonly kind = 'docker-sandbox' as const;
  private readonly image = process.env.AXIOM_TOOL_SANDBOX_IMAGE?.trim() || 'ubuntu:22.04';
  private readonly maxOutputBytes = Math.max(16_384, Number(process.env.AXIOM_TOOL_MAX_OUTPUT_BYTES ?? 1_000_000));

  describe() {
    return {
      kind: this.kind,
      image: this.image,
      network: 'disabled',
      filesystem: 'workspace-read-write-root-read-only',
      allowedCommands: [...allowedCommands()],
      configured: process.env.AXIOM_TOOL_EXECUTOR === 'docker',
    };
  }

  async probe() {
    if (process.env.AXIOM_TOOL_EXECUTOR !== 'docker') return { configured: false, available: false, detail: 'Docker 执行器未启用。' };
    try {
      await execFileAsync('docker', ['image', 'inspect', this.image], { timeout: 5_000, windowsHide: true });
      return { configured: true, available: true, detail: `沙箱镜像 ${this.image} 可用。` };
    } catch {
      return { configured: true, available: false, detail: `Docker 镜像 ${this.image} 不可用。` };
    }
  }

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    const auditId = randomUUID();
    const command = request.command.trim();
    if (!allowedCommands().has(command)) throw new Error(`Sandbox command is not allowlisted: ${command}`);
    if (!request.workspaceRoot || request.workspaceRoot.includes('..')) throw new Error('A bounded workspace root is required.');
    if (process.env.AXIOM_TOOL_EXECUTOR !== 'docker') throw new Error('Docker sandbox executor is disabled.');
    const startedAt = Date.now();
    const args = [
      'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '-v', `${request.workspaceRoot}:/workspace:rw`,
      '-w', '/workspace', this.image, command, ...(request.args ?? []),
    ];
    try {
      const result = await execFileAsync('docker', args, {
        timeout: Math.min(120_000, Math.max(1_000, request.timeoutMs ?? 30_000)),
        maxBuffer: this.maxOutputBytes,
        windowsHide: true,
      });
      return {
        stdout: result.stdout.slice(0, this.maxOutputBytes),
        stderr: result.stderr.slice(0, this.maxOutputBytes),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        auditId,
      };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      return {
        stdout: String(failure.stdout ?? '').slice(0, this.maxOutputBytes),
        stderr: String(failure.stderr ?? failure.message ?? '').slice(0, this.maxOutputBytes),
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
        durationMs: Date.now() - startedAt,
        auditId,
      };
    }
  }
}
