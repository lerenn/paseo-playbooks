import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasPlaybooks, PLAYBOOKS_DIRS } from "./loader";
import { UserError } from "./runtime";

/** The starter playbook that "Create an example playbook" writes. Small on purpose: a step, a gate, a loop back. */
export const STARTER_FILES: Record<string, string> = {
  "hello.yaml": `title: Hello
description: Write a short note, then wait for approval.

inputs:
  topic: { type: string, required: true, description: What the note is about }

steps:
  - id: write
    role:
      name: writer
      agent: { mode: acceptEdits }
      prompt: "Add a short NOTES.md section about {{ inputs.topic }}."
    inputs: [topic]
    outputs:
      changes: { type: string }

  - id: approve
    needs: [write]
    gate: { question: "Approve the note, or reject it with a comment to send it back." }
    on:
      rejected: { goto: write }
`,
  "roles/writer/role.yaml": `title: Writer
readonly: false
`,
  "roles/writer/instructions.md": `You write short documentation changes. Edit only the files you are asked to change,
with your file edit tool. Do not run shell commands and do not commit.
Return what you changed in the \`changes\` output.
`,
};

/**
 * Writes the starter playbook into a workspace that has none, and returns the files created,
 * relative to the workspace. Never overwrites: a file that already exists is an error.
 */
export async function createStarter(workspaceDir: string): Promise<string[]> {
  if (await hasPlaybooks(workspaceDir)) throw new UserError("this workspace already has playbooks");
  const root = PLAYBOOKS_DIRS[0];
  const created: string[] = [];
  for (const [name, text] of Object.entries(STARTER_FILES)) {
    const file = path.join(workspaceDir, root, name);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, text, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UserError(`${root}/${name} already exists`);
      throw error;
    }
    created.push(`${root}/${name}`);
  }
  return created;
}
