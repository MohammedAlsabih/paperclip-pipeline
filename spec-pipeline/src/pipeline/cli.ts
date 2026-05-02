#!/usr/bin/env node
import * as path from 'path';
import { runPipeline } from './run';

const [, , specArg, repoArg] = process.argv;

if (!specArg || !repoArg) {
  process.stderr.write('Usage: ts-node src/pipeline/cli.ts <spec.md> <repo-url>\n');
  process.stderr.write('  Example: ts-node src/pipeline/cli.ts demo/add-items-crud.md https://github.com/MohammedAlsabih/spec-pipeline-demo-app\n');
  process.exit(1);
}

runPipeline({
  specPath: path.resolve(specArg),
  repoUrl: repoArg,
  verbose: true,
}).then(result => {
  process.stdout.write(`\nDone. PR: ${result.pr_url}\n`);
  process.exit(0);
}).catch(err => {
  process.stderr.write(`\nPipeline failed: ${(err as Error).message}\n`);
  process.exit(1);
});
