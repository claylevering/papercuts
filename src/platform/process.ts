export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<ProcessResult>;
}

export const bunProcessRunner: ProcessRunner = {
  async run(
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<ProcessResult> {
    const subprocess = Bun.spawn([command, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    return { exitCode, stdout, stderr };
  },
};
