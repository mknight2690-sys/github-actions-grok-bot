const OpenAI = require("openai");
const fs = require("fs");
const { execSync } = require("child_process");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "missing",
  baseURL: process.env.OPENAI_BASE_URL || "https://inference-api.nousresearch.com/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/mknight2690-sys/github-actions-grok-bot",
    "X-Title": "Cloud Agent",
  },
});

const model = process.env.MODEL || "poolside/laguna-s-2.1:free";
const maxSteps = parseInt(process.env.MAX_STEPS || "8", 10);
const mode = process.env.MODE || "once";
const isScheduled = process.env.EVENT_NAME === "schedule";

let memory = { messages: [], last_task: "", last_answer: "" };
try {
  memory = JSON.parse(fs.readFileSync(".agent-state/memory.json", "utf8"));
} catch {}

let task = process.env.TASK || "";
if (!task && isScheduled) {
  const inbox = fs.readFileSync(".agent-state/inbox.txt", "utf8").trim();
  if (inbox) {
    task = inbox.split("\n")[0];
    fs.writeFileSync(".agent-state/inbox.txt", inbox.split("\n").slice(1).join("\n"));
  } else {
    task = "Heartbeat: confirm you are alive in under 50 words.";
  }
}
if (!task) task = "Say hello and confirm the agent works.";

const system = `You are a multi-step agent in GitHub Actions.
Tools (reply with JSON when needed):
{"tool":"run_shell","command":"ls -la"}
{"tool":"write_file","path":"notes.md","content":"..."}
{"tool":"read_file","path":"notes.md"}
{"tool":"finish","answer":"final answer"}
When done, call finish. Last task: ${memory.last_task || "(none)"}`;

let messages = [{ role: "system", content: system }];
if (mode === "continue" && memory.messages && memory.messages.length) {
  messages = messages.concat(memory.messages.slice(-12));
}
messages.push({ role: "user", content: task });

let finalAnswer = "";
const stepsLog = [];

async function callModel() {
  try {
    const res = await client.chat.completions.create({
      model,
      messages,
      max_tokens: 1200,
      temperature: 0.3,
    });
    return res.choices[0]?.message?.content || "";
  } catch (err) {
    return "ERROR: " + err.message;
  }
}

function tryParseTool(text) {
  const match = text.match(/\{[\s\S]*?"tool"[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function executeTool(toolCall) {
  const tool = toolCall.tool;
  try {
    if (tool === "run_shell") {
      return execSync(toolCall.command || "echo ok", {
        encoding: "utf8",
        timeout: 20000,
      });
    }
    if (tool === "write_file") {
      fs.writeFileSync(toolCall.path || "out.txt", toolCall.content || "");
      return "Wrote " + toolCall.path;
    }
    if (tool === "read_file") {
      return fs.existsSync(toolCall.path)
        ? fs.readFileSync(toolCall.path, "utf8")
        : "not found";
    }
    if (tool === "finish") {
      return { finished: true, answer: toolCall.answer || "" };
    }
    return "Unknown tool";
  } catch (err) {
    return "Tool error: " + err.message;
  }
}

(async () => {
  console.log("Task:", task);
  console.log("Model:", model);

  for (let step = 1; step <= maxSteps; step++) {
    console.log("--- Step", step, "---");
    const reply = await callModel();
    console.log(reply);
    stepsLog.push({ step, reply });

    if (reply.startsWith("ERROR:")) {
      finalAnswer = reply;
      break;
    }

    const toolCall = tryParseTool(reply);
    if (toolCall) {
      const result = executeTool(toolCall);
      if (result && result.finished) {
        finalAnswer = result.answer;
        break;
      }
      messages.push({ role: "assistant", content: reply });
      messages.push({
        role: "user",
        content: "Tool result:\n" + (typeof result === "string" ? result : JSON.stringify(result)),
      });
    } else {
      messages.push({ role: "assistant", content: reply });
      if (step === maxSteps || reply.length > 200) {
        finalAnswer = reply;
        break;
      }
      messages.push({
        role: "user",
        content: "Continue or call finish when done.",
      });
    }
  }

  if (!finalAnswer) {
    finalAnswer = stepsLog.map((s) => s.reply).join("\n\n") || "No answer";
  }

  memory.last_task = task;
  memory.last_answer = finalAnswer;
  memory.messages = messages.slice(-20);
  fs.writeFileSync(".agent-state/memory.json", JSON.stringify(memory, null, 2));

  const md =
    "# Agent Result\n\n**Task:** " +
    task +
    "\n\n## Final Answer\n\n" +
    finalAnswer +
    "\n";
  fs.writeFileSync("agent-result.md", md);
  fs.writeFileSync("agent-result.txt", finalAnswer);
  console.log("Done:", finalAnswer.slice(0, 300));
})().catch((err) => {
  console.error(err);
  fs.writeFileSync("agent-result.txt", "Fatal: " + err.message);
  process.exit(1);
});
