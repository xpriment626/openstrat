import { realpathSync } from "node:fs";
import type { ReadStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { runOpenStratCli } from "./commands.js";

export { runOpenStratCli } from "./commands.js";
export * from "./home.js";
export * from "./runtime.js";
export * from "./session-store.js";
export * from "./slash-commands.js";
export * from "./trading-workbench.js";
export * from "./workbench-summary.js";
export * from "./workbench-tui.js";

export async function runProcessCli(): Promise<void> {
  const inputLines =
    process.argv.length === 2 && !isTty(process.stdin)
      ? await readInputLines(process.stdin)
      : undefined;
  const result = await runOpenStratCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    output: process.stdout,
    inputLines,
    cliEntrypoint: process.argv[1],
    stderr: (line) => console.error(line),
    stdout: (line) => console.log(line)
  });
  process.exitCode = result.exitCode;
}

if (isDirectCliInvocation()) {
  await runProcessCli();
}

function isDirectCliInvocation(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
}

function isTty(stream: NodeJS.ReadStream): stream is ReadStream {
  return stream.isTTY === true;
}

async function readInputLines(stream: NodeJS.ReadStream): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}
