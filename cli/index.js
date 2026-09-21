#!/usr/bin/env node
/**
 * CLI controller for the persistent GitHub Actions cloud agent.
 *
 *   node index.js "Do something"
 *   node index.js --mode continue "Follow up"
 *   node index.js --inbox "Queue for scheduled run"
 *   node index.js --loop "Run this prompt forever (Ctrl+C to stop)"
 */

import { Octokit } from '@octokit/rest';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || '',
    model: process.env.MODEL || 'openai/gpt-oss-20b',
    maxSteps: process.env.MAX_STEPS || '8',
    mode: 'once',
    inbox: false,
    loop: false,
    task: '',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i+1]) { opts.token = args[++i]; }
    else if (args[i] === '--owner' && args[i+1]) { opts.owner = args[++i]; }
    else if (args[i] === '--repo' && args[i+1]) { opts.repo = args[++i]; }
    else if (args[i] === '--model' && args[i+1]) { opts.model = args[++i]; }
    else if (args[i] === '--max-steps' && args[i+1]) { opts.maxSteps = args[++i]; }
    else if (args[i] === '--mode' && args[i+1]) { opts.mode = args[++i]; }
    else if (args[i] === '--inbox') { opts.inbox = true; }
    else if (args[i] === '--loop') { opts.loop = true; }
    else if (!args[i].startsWith('--')) {
      opts.task = args.slice(i).join(' ');
      break;
    }
  }
  return opts;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runOnce(octokit, opts, modeOverride) {
  const mode = modeOverride || opts.mode;

  await octokit.actions.createWorkflowDispatch({
    owner: opts.owner,
    repo: opts.repo,
    workflow_id: 'agent.yml',
    ref: 'main',
    inputs: {
      task: opts.task,
      model: opts.model,
      max_steps: opts.maxSteps,
      mode,
    },
  });

  let runId = null;
  for (let i = 0; i < 25; i++) {
    await sleep(2500);
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: opts.owner,
      repo: opts.repo,
      workflow_id: 'agent.yml',
      per_page: 5,
    });
    if (runs.workflow_runs[0]) {
      runId = runs.workflow_runs[0].id;
      break;
    }
  }
  if (!runId) throw new Error('Could not find workflow run');

  let status = 'in_progress';
  let conclusion = null;
  while (status === 'queued' || status === 'in_progress') {
    await sleep(4000);
    const { data: run } = await octokit.actions.getWorkflowRun({
      owner: opts.owner,
      repo: opts.repo,
      run_id: runId,
    });
    status = run.status;
    conclusion = run.conclusion;
    process.stdout.write(`\r   Status: ${status}${conclusion ? ' (' + conclusion + ')' : ''}   `);
  }
  console.log('');

  if (conclusion !== 'success') {
    throw new Error(`Workflow ended with: ${conclusion}`);
  }

  const { data: artifacts } = await octokit.actions.listWorkflowRunArtifacts({
    owner: opts.owner,
    repo: opts.repo,
    run_id: runId,
  });
  const artifact = artifacts.artifacts.find(a => a.name === 'agent-result');
  if (!artifact) throw new Error('No agent-result artifact');

  const { data: zipData } = await octokit.actions.downloadArtifact({
    owner: opts.owner,
    repo: opts.repo,
    artifact_id: artifact.id,
    archive_format: 'zip',
  });

  const zipPath = path.join(process.cwd(), `agent-result-${runId}.zip`);
  fs.writeFileSync(zipPath, Buffer.from(zipData));

  const zip = new AdmZip(zipPath);
  let text = '';
  zip.getEntries().forEach(entry => {
    if (entry.entryName.endsWith('.txt') || entry.entryName.endsWith('.md')) {
      const content = entry.getData().toString('utf8');
      if (entry.entryName.endsWith('.txt')) text = content;
      console.log(`\n=== ${entry.entryName} ===\n${content}`);
    }
  });

  console.log(`\nRun: https://github.com/${opts.owner}/${opts.repo}/actions/runs/${runId}`);
  return { runId, text };
}

async function main() {
  const opts = parseArgs();

  if (!opts.token || !opts.owner || !opts.repo) {
    console.error(`
Missing token / owner / repo.

  set GITHUB_TOKEN=ghp_...
  set GITHUB_OWNER=your-username
  set GITHUB_REPO=your-repo

  node index.js "task"
  node index.js --loop "run this forever (Ctrl+C to stop)"
  node index.js --inbox "queue for next scheduled run"
`);
    process.exit(1);
  }

  if (!opts.task) {
    console.error('Please provide a task.');
    process.exit(1);
  }

  console.log('🚀 Persistent Cloud Agent CLI');
  console.log(`   Repo:  ${opts.owner}/${opts.repo}`);
  console.log(`   Mode:  ${opts.mode}${opts.loop ? ' + LOOP' : ''}${opts.inbox ? ' (inbox)' : ''}`);
  console.log(`   Model: ${opts.model}`);
  console.log(`   Task:  ${opts.task}\n`);

  const octokit = new Octokit({ auth: opts.token });

  // Credential check
  try {
    const { data: user } = await octokit.users.getAuthenticated();
    console.log(`Authenticated as: ${user.login}\n`);
  } catch (err) {
    if (err.status === 401) {
      console.error(`
❌ Bad credentials (401)

Your GitHub token is invalid, expired, or missing required scopes.

Fix:
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token (classic)
3. Enable these scopes:
   - repo
   - workflow
4. Copy the new token (starts with ghp_)
5. Use it with no extra spaces or quotes
`);
      process.exit(1);
    }
    throw err;
  }

  if (opts.inbox) {
    console.log('Queuing task into persistent inbox...');
    let sha = null;
    let content = opts.task + '\n';
    try {
      const { data } = await octokit.repos.getContent({
        owner: opts.owner, repo: opts.repo, path: '.agent-state/inbox.txt',
      });
      sha = data.sha;
      content = Buffer.from(data.content, 'base64').toString('utf8') + opts.task + '\n';
    } catch {}
    await octokit.repos.createOrUpdateFileContents({
      owner: opts.owner, repo: opts.repo,
      path: '.agent-state/inbox.txt',
      message: 'agent: queue task for scheduled run',
      content: Buffer.from(content).toString('base64'),
      sha: sha || undefined,
    });
    console.log('✅ Queued. Next scheduled run (every 5 min) will pick it up.');
    return;
  }

  if (opts.loop) {
    console.log('Infinite loop started. Press Ctrl+C to stop.\n');
    let iteration = 0;
    while (true) {
      iteration += 1;
      console.log(`\n========== LOOP ITERATION ${iteration} ==========`);
      try {
        await runOnce(octokit, opts, iteration === 1 ? opts.mode : 'continue');
      } catch (err) {
        console.error(`Iteration error: ${err.message}`);
        console.log('Retrying in 15 seconds...');
        await sleep(15000);
        continue;
      }
      console.log('Waiting 8 seconds before next iteration...');
      await sleep(8000);
    }
  }

  // Single run
  await runOnce(octokit, opts);
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
