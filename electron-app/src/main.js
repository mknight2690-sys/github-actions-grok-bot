const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

let mainWindow;
let loopAbort = false;
let Octokit = null;

async function getOctokit() {
  if (!Octokit) {
    const mod = await import('@octokit/rest');
    Octokit = mod.Octokit;
  }
  return Octokit;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Persistent Cloud Agent',
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const configPath = path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch {
    return { token: '', owner: '', repo: '', model: 'openai/gpt-oss-20b', openrouterKey: '' };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, cfg) => { saveConfig(cfg); return true; });
ipcMain.handle('stop-loop', () => { loopAbort = true; return true; });

async function runOneAgent({ token, owner, repo, model, task, maxSteps, mode, openrouterKey }) {
  const OctokitClass = await getOctokit();
  const octokit = new OctokitClass({ auth: token });

  try {
    await octokit.users.getAuthenticated();
  } catch (err) {
    if (err.status === 401) {
      throw new Error('Bad GitHub credentials (401). Use a classic PAT with repo + workflow scopes.');
    }
    throw err;
  }

  const inputs = {
    task,
    model: model || 'openai/gpt-oss-20b',
    max_steps: String(maxSteps || 8),
    mode: mode || 'once',
  };
  if (openrouterKey && openrouterKey.trim()) {
    inputs.openrouter_key = openrouterKey.trim();
  }

  await octokit.actions.createWorkflowDispatch({
    owner, repo,
    workflow_id: 'agent.yml',
    ref: 'main',
    inputs,
  });

  let runId = null;
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner, repo, workflow_id: 'agent.yml', per_page: 5,
    });
    if (runs.workflow_runs[0]) {
      runId = runs.workflow_runs[0].id;
      break;
    }
  }
  if (!runId) throw new Error('Could not find workflow run.');

  let status = 'in_progress';
  let conclusion = null;
  while (status === 'queued' || status === 'in_progress') {
    if (loopAbort) throw new Error('Loop stopped by user');
    await new Promise(r => setTimeout(r, 4000));
    const { data: run } = await octokit.actions.getWorkflowRun({ owner, repo, run_id: runId });
    status = run.status;
    conclusion = run.conclusion;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status', { status, conclusion, runId });
    }
  }

  if (conclusion !== 'success') {
    throw new Error('Workflow finished with: ' + conclusion);
  }

  const { data: artifacts } = await octokit.actions.listWorkflowRunArtifacts({
    owner, repo, run_id: runId,
  });
  const artifact = artifacts.artifacts.find(a => a.name === 'agent-result');
  if (!artifact) throw new Error('No agent-result artifact found');

  const { data: zipData } = await octokit.actions.downloadArtifact({
    owner, repo, artifact_id: artifact.id, archive_format: 'zip',
  });

  const zipPath = path.join(app.getPath('temp'), 'agent-result-' + runId + '.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipData));

  const zip = new AdmZip(zipPath);
  let resultText = '';
  zip.getEntries().forEach(entry => {
    if (entry.entryName.endsWith('.txt')) resultText = entry.getData().toString('utf8');
    else if (entry.entryName.endsWith('.md') && !resultText) resultText = entry.getData().toString('utf8');
  });

  return {
    runId,
    resultText: resultText || 'No text result',
    url: 'https://github.com/' + owner + '/' + repo + '/actions/runs/' + runId,
  };
}

ipcMain.handle('run-agent', async (_, opts) => {
  loopAbort = false;
  return runOneAgent(opts);
});

ipcMain.handle('run-loop', async (_, opts) => {
  loopAbort = false;
  let iteration = 0;
  while (!loopAbort) {
    iteration += 1;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status', { status: 'loop iteration ' + iteration, conclusion: null, runId: null });
    }
    try {
      const res = await runOneAgent({ ...opts, mode: iteration === 1 ? (opts.mode || 'once') : 'continue' });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('loop-result', { iteration, resultText: res.resultText, url: res.url, runId: res.runId });
      }
      await new Promise(r => setTimeout(r, 8000));
    } catch (err) {
      if (loopAbort || (err.message && err.message.includes('Loop stopped'))) break;
      await new Promise(r => setTimeout(r, 15000));
    }
  }
  return { stopped: true, iterations: iteration };
});

ipcMain.handle('queue-inbox', async (_, { token, owner, repo, task }) => {
  const OctokitClass = await getOctokit();
  const octokit = new OctokitClass({ auth: token });
  let sha = null;
  let content = task + '\n';
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: '.agent-state/inbox.txt' });
    sha = data.sha;
    content = Buffer.from(data.content, 'base64').toString('utf8') + task + '\n';
  } catch {}
  await octokit.repos.createOrUpdateFileContents({
    owner, repo, path: '.agent-state/inbox.txt',
    message: 'agent: queue task',
    content: Buffer.from(content).toString('base64'),
    sha: sha || undefined,
  });
  return true;
});
