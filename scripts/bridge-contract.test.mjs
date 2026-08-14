import assert from "node:assert/strict";
import test from "node:test";
import {
  commandSignatureLines,
  compareSignatureLines,
  duplicates,
  parseBridgeInvocations,
  parseManifestCommands,
  parseRegisteredCommands,
  parseRustCommands,
  validateInvocationArguments,
} from "./bridge-contract.mjs";

test("parses public Tauri arguments while excluding injected context", () => {
  const commands = parseRustCommands(`
    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn task_start(
      state: tauri::State<'_, AppState>,
      app: AppHandle,
      task_id: String,
      working_directory: Option<String>,
      request: StartRequest,
    ) -> CommandResult<StartOutcome> {
      todo!()
    }
  `);

  assert.deepEqual(commandSignatureLines(commands), [
    "task_start(taskId:String,workingDirectory?:Option<String>,request:StartRequest)->CommandResult<StartOutcome>",
  ]);
});

test("parses literal, conditional, empty, and spread invocation arguments", () => {
  const invocations = parseBridgeInvocations(`
    nativeInvoke("task_start", { taskId, workingDirectory: cwd, request });
    nativeInvoke(staged ? "git_stage" : "git_unstage", { repository, path });
    invokeOrDemo("task_list", undefined, () => []);
    nativeInvoke("acp_connect", { taskId, ...launchSelection });
  `);

  assert.deepEqual(
    invocations.map(({ command, keys, complete }) => ({
      command,
      keys,
      complete,
    })),
    [
      {
        command: "task_start",
        keys: ["taskId", "workingDirectory", "request"],
        complete: true,
      },
      { command: "git_stage", keys: ["repository", "path"], complete: true },
      { command: "git_unstage", keys: ["repository", "path"], complete: true },
      { command: "task_list", keys: [], complete: true },
      { command: "acp_connect", keys: ["taskId"], complete: false },
    ],
  );
});

test("reports unknown and missing invocation arguments", () => {
  const [command] = parseRustCommands(`
    #[tauri::command]
    fn task_start(task_id: String, model: Option<String>) -> Result<(), String> { Ok(()) }
  `);
  const invocations = parseBridgeInvocations(
    `
    nativeInvoke("task_start", { task: "wrong" });
  `,
    "bridge/tasks.ts",
  );
  const result = validateInvocationArguments(
    new Map([[command.name, command]]),
    invocations,
  );

  assert.equal(result.fullyAudited, 1);
  assert.deepEqual(result.failures, [
    "bridge/tasks.ts:2 task_start has unknown argument key(s): task",
    "bridge/tasks.ts:2 task_start is missing required argument key(s): taskId",
  ]);
});

test("parses registration and build manifests and detects snapshot deltas", () => {
  assert.deepEqual(
    parseRegisteredCommands(
      "tauri::generate_handler![task_create, commands::task_list,]",
    ),
    ["task_create", "task_list"],
  );
  assert.deepEqual(
    parseManifestCommands(
      'const APP_COMMANDS: &[&str] = &["task_create", "task_list"];',
    ),
    ["task_create", "task_list"],
  );
  assert.deepEqual(compareSignatureLines(["a()"], ["b()"]), {
    removed: ["a()"],
    added: ["b()"],
  });
  assert.deepEqual(duplicates(["a", "b", "a"]), ["a"]);
});
