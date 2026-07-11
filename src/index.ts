#!/usr/bin/env bun
import { homedir } from "node:os";

import { runCli, type CliEnvironment, type CliRuntime } from "./cli/run";
import { resolveRepoContext } from "./repository/context";
import { planSetup } from "./setup/adapters";
import { applySetup } from "./setup/applier";
import type { SetupPlan } from "./setup/types";
import { openSqliteStore } from "./storage/sqlite-store";

const CLIENT_VERSION = "0.1.0";

function buildEnvironment(): CliEnvironment {
  const papercutsHome = process.env["PAPERCUTS_HOME"];
  const codexHome = process.env["CODEX_HOME"];
  const pathValue = process.env["PATH"];

  return {
    cwd: process.cwd(),
    home: homedir(),
    ...(papercutsHome !== undefined ? { papercutsHome } : {}),
    ...(codexHome !== undefined ? { codexHome } : {}),
    ...(pathValue !== undefined ? { pathValue } : {}),
  };
}

async function* stdinChunks(): AsyncGenerator<Uint8Array> {
  for await (const chunk of Bun.stdin.stream()) {
    yield chunk;
  }
}

const runtime: CliRuntime = {
  io: {
    stdin: stdinChunks(),
    writeStdout(text: string): void {
      process.stdout.write(text);
    },
    writeStderr(text: string): void {
      process.stderr.write(text);
    },
    stdoutIsTty: process.stdout.isTTY === true,
  },
  environment: buildEnvironment(),
  openStore: openSqliteStore,
  resolveRepoContext,
  planSetup,
  applySetup: (plan: SetupPlan) => applySetup(plan),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  clientVersion: CLIENT_VERSION,
  runtimeVersion: `bun ${Bun.version}`,
};

const exitCode = await runCli(Bun.argv.slice(2), runtime);
process.exit(exitCode);
