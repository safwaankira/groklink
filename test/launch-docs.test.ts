// T19 phase D: the README top, the Questions section and llms.txt stay true to the code.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TOOLS } from "../src/client/mcp.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Jobs } from "../src/daemon/jobs.ts";
import { ERROR_CODES } from "../src/shared/protocol.ts";

const readme = readFileSync("README.md", "utf8");
const llms = readFileSync("llms.txt", "utf8");
/** Job error codes that aren't socket error codes. */
const APPROVAL_CODES = ["approval_denied", "approval_timeout", "approval_error", "approval_queue_full"];
/** Everything before the first `## ` heading after the title. */
const intro = (text: string) => text.slice(0, text.indexOf("\n## "));
const CRYPTO = /wallet|crypto|transaction|seed phrase|private key|mnemonic|claim|\btx\b|token sale|on-?chain/i;

test("README top: one line saying what it is with the number of MCP tools, then the two-line quick start", () => {
  const lines = readme.split("\n").filter((l) => l.trim());
  assert.equal(lines[0], "# Grok Link");
  assert.match(lines[1], new RegExp(`^\\*\\*Grok Link gives .* ${TOOLS.length} tools .*\\*\\*$`));
  assert.deepEqual(lines.slice(2, 6), ["```bash", "npm i -g groklink", "groklink setup", "```"]);
});

test("README has a Questions section with the four questions, 2-3 lines each", () => {
  const start = readme.indexOf("\n## Questions\n");
  assert.ok(start > 0);
  const section = readme.slice(start + 14, readme.indexOf("\n## ", start + 1));
  const questions = section.split("\n").filter((l) => l.startsWith("**"));
  assert.deepEqual(
    questions.map((q) => q.slice(2, q.indexOf("?") + 1)),
    ["Why not drive Grok Bot directly?", "Does it use extra tokens?", "Is it official?", "What can't it do?"],
  );
  for (const q of questions) {
    const sentences = q.slice(q.indexOf("?**") + 3).match(/[^.]+\./g) ?? [];
    assert.ok(sentences.length >= 2 && sentences.length <= 4, `${q.slice(0, 30)}: ${sentences.length} sentences`);
  }
  assert.match(section, /Is it official\?\*\* No\./);
  assert.match(section, /can't run remotely or hosted/);
  assert.match(section, /can't post video/);
});

test("README's token numbers match a groklink_job result from the unit fixture (no Bot message)", async () => {
  const home = mkdtempSync(join(tmpdir(), "gl-docs-"));
  const brief = "Reply with the word pong and nothing else.";
  const j = new Jobs({
    dir: join(home, "jobs"),
    events: new EventLog(join(home, "events.jsonl")),
    layer: {
      find: async () => ({ id: "b1", name: "Scout" }),
      send: async () => "nonce_1",
      wait: (_id, opts) =>
        new Promise((resolve) =>
          setTimeout(() => {
            opts.onUpdate({ key: "m1", role: "assistant", kind: "message", text: "pong", links: [], at: "2026-11-21T10:00:05.000Z" });
            resolve({ bot: "b1", status: "done", messages: [], elapsedMs: 5000 });
          }, 10),
        ),
      read: async () => [],
    },
    link: { connected: true },
    log: () => {},
    pollMs: 10,
  });
  try {
    j.start();
    const { jobId } = await j.create({ bot: "Scout", brief });
    let job = await j.get({ jobId });
    for (let i = 0; i < 200 && job.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      job = await j.get({ jobId });
    }
    assert.equal(job.status, "done");
    // What the MCP server returns for groklink_job: the job as indented JSON.
    const bytes = Buffer.byteLength(JSON.stringify(job, null, 2));
    const fixed = bytes - Buffer.byteLength(JSON.stringify("pong")) - Buffer.byteLength(JSON.stringify(brief)) + 4;
    assert.equal(bytes, 566);
    assert.equal(fixed, 520);
    assert.match(readme, /about 520 bytes of job fields: 566 bytes \(roughly 140 tokens\)/);
    const tools = Buffer.byteLength(
      JSON.stringify({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }),
    );
    assert.ok(tools > 6000 && tools < 8000, `tools/list is ${tools} bytes; the README says about 7 KB`);
    assert.match(readme, new RegExp(`The ${TOOLS.length} tool definitions add about 7 KB`));
  } finally {
    j.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("llms.txt: what it is, install, every tool with one line, every error code with what to do, and a link to the skill", () => {
  assert.match(llms, /^# Grok Link\n\n> Grok Link is an unofficial, open-source bridge/);
  assert.ok(llms.includes(`${TOOLS.length} tools`));
  assert.match(llms, /```bash\nnpm i -g groklink\ngroklink setup\n```/);
  assert.match(llms, /\[Agent skill\]\(skills\/groklink\/SKILL\.md\)/);
  const toolLines = llms.split("\n").filter((l) => /^- `groklink_/.test(l));
  assert.deepEqual(toolLines.map((l) => l.slice(3, l.indexOf("`", 3))).sort(), TOOLS.map((t) => t.name).sort());
  for (const l of toolLines) assert.ok(l.length > 30, l);
  const codes = llms.slice(llms.indexOf("## Error codes"));
  const listed = codes
    .split("\n")
    .filter((l) => l.startsWith("- `"))
    .map((l) => l.slice(3, l.indexOf("`", 3)));
  assert.deepEqual([...listed].sort(), [...ERROR_CODES, ...APPROVAL_CODES].sort());
  for (const l of codes.split("\n").filter((x) => x.startsWith("- `"))) assert.ok(l.split(": ")[1]?.length > 20, `what to do: ${l}`);
});

test("llms.txt ships in the package", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg.files.includes("llms.txt"));
});

test("no wallet or crypto wording in the README intro or the llms.txt intro; the rules stay in Safety policy", () => {
  // README intro: everything before Requirements (the top and the Why list).
  const readmeIntro = readme.slice(0, readme.indexOf("\n## Requirements"));
  assert.doesNotMatch(readmeIntro, CRYPTO);
  assert.doesNotMatch(intro(llms), CRYPTO);
  assert.doesNotMatch(llms, /wallet|crypto|transaction|seed phrase|mnemonic/i);
  const policy = readme.slice(readme.indexOf("\n## Safety policy"), readme.indexOf("\n## Security model"));
  for (const rule of ["`tx`", "`wallet`", "`claim`"]) assert.ok(policy.includes(rule), rule);
  // Outside that section, the three rules aren't described again.
  const rest = readme.replace(policy, "");
  assert.doesNotMatch(rest, /sign transactions|connect a wallet|submit claims/);
});
