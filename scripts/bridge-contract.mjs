const COMMAND_NAME = /^[a-z][a-z0-9_]*$/;

export function parseRustCommands(source, sourcePath = "<rust>") {
  const commands = [];
  const attribute = /#\[\s*tauri::command(?:\([^\]]*\))?\s*\]/g;

  for (const match of source.matchAll(attribute)) {
    const declarationStart = match.index + match[0].length;
    const declaration = source
      .slice(declarationStart)
      .match(
        /^(?:\s|#\[[^\]]*\])*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*/,
      );
    if (!declaration) {
      throw new Error(
        `${sourcePath}:${lineNumber(source, declarationStart)} has an unsupported Tauri command declaration`,
      );
    }

    const name = declaration[1];
    const nameOffset =
      declarationStart + declaration.index + declaration[0].lastIndexOf(name);
    const parametersOpen = source.indexOf("(", nameOffset + name.length);
    const parametersClose = findMatchingDelimiter(
      source,
      parametersOpen,
      "(",
      ")",
    );
    const parameters = splitTopLevel(
      source.slice(parametersOpen + 1, parametersClose),
      { trackAngles: true },
    )
      .map((parameter) => parseRustParameter(parameter, sourcePath, name))
      .filter(
        (parameter) => parameter && !isInjectedTauriParameter(parameter.type),
      );
    const bodyOpen = findFunctionBody(source, parametersClose + 1);
    const returnType = parseReturnType(
      source.slice(parametersClose + 1, bodyOpen),
    );

    commands.push({
      name,
      args: parameters.map((parameter) => ({
        rustName: parameter.name,
        jsName: rustNameToCamelCase(parameter.name),
        type: normalizeRustType(parameter.type),
        optional: isOptionalRustType(parameter.type),
      })),
      returnType,
      sourcePath,
      line: lineNumber(source, match.index),
    });
  }

  return commands;
}

export function parseBridgeInvocations(source, sourcePath = "<bridge>") {
  const invocations = [];
  const callName = /\b(nativeInvoke|invokeOrDemo)\b/g;

  for (const match of source.matchAll(callName)) {
    if (
      /\bfunction\s*$/.test(
        source.slice(Math.max(0, match.index - 24), match.index),
      )
    ) {
      continue;
    }

    let cursor = skipWhitespace(source, match.index + match[0].length);
    if (source[cursor] === "<") {
      cursor = findMatchingAngle(source, cursor) + 1;
      cursor = skipWhitespace(source, cursor);
    }
    if (source[cursor] !== "(") continue;

    const callClose = findMatchingDelimiter(source, cursor, "(", ")");
    const callArguments = splitTopLevel(source.slice(cursor + 1, callClose));
    const commandNames = parseCommandExpression(callArguments[0] ?? "");
    if (commandNames.length === 0) continue;

    const parsedArgs = parseInvokeArguments(callArguments[1]);
    for (const command of commandNames) {
      invocations.push({
        command,
        keys: parsedArgs.keys,
        complete: parsedArgs.complete,
        sourcePath,
        line: lineNumber(source, match.index),
      });
    }
  }

  return invocations;
}

export function parseRegisteredCommands(source) {
  const marker = "generate_handler![";
  const start = source.indexOf(marker);
  if (start < 0)
    throw new Error("could not locate tauri::generate_handler! registration");
  const open = start + marker.length - 1;
  const close = findMatchingDelimiter(source, open, "[", "]");
  const entries = splitTopLevel(source.slice(open + 1, close))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const path = entry.match(
      /^(?:[A-Za-z_][A-Za-z0-9_]*::)*([a-z][a-z0-9_]*)$/,
    );
    if (!path) throw new Error(`unsupported generate_handler entry: ${entry}`);
    return path[1];
  });
}

export function parseManifestCommands(source) {
  const manifest = source.match(
    /const APP_COMMANDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/,
  )?.[1];
  if (!manifest)
    throw new Error("could not locate build.rs APP_COMMANDS manifest");
  return [...manifest.matchAll(/"([a-z][a-z0-9_]*)"/g)].map(
    (match) => match[1],
  );
}

export function commandSignatureLines(commands) {
  return [...commands]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((command) => {
      const args = command.args
        .map(
          (argument) =>
            `${argument.jsName}${argument.optional ? "?" : ""}:${argument.type}`,
        )
        .join(",");
      return `${command.name}(${args})->${command.returnType}`;
    });
}

export function compareSignatureLines(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    removed: expected.filter((line) => !actualSet.has(line)),
    added: actual.filter((line) => !expectedSet.has(line)),
  };
}

export function validateInvocationArguments(commandMap, invocations) {
  const failures = [];
  let fullyAudited = 0;

  for (const invocation of invocations) {
    const command = commandMap.get(invocation.command);
    if (!command) continue;
    const allowed = new Set(command.args.map((argument) => argument.jsName));
    const required = command.args
      .filter((argument) => !argument.optional)
      .map((argument) => argument.jsName);
    const supplied = new Set(invocation.keys);
    const unknown = invocation.keys.filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      failures.push(
        `${invocation.sourcePath}:${invocation.line} ${invocation.command} has unknown argument key(s): ${unknown.join(", ")}`,
      );
    }
    if (invocation.complete) {
      fullyAudited += 1;
      const missing = required.filter((key) => !supplied.has(key));
      if (missing.length > 0) {
        failures.push(
          `${invocation.sourcePath}:${invocation.line} ${invocation.command} is missing required argument key(s): ${missing.join(", ")}`,
        );
      }
    }
  }

  return { failures, fullyAudited };
}

export function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function parseRustParameter(parameter, sourcePath, commandName) {
  const trimmed = parameter.trim();
  if (!trimmed) return undefined;
  const withoutAttributes = trimmed.replace(/^(?:#\[[^\]]*\]\s*)+/, "");
  const colon = findTopLevelCharacter(withoutAttributes, ":", {
    trackAngles: true,
  });
  if (colon < 0) {
    throw new Error(
      `${sourcePath} ${commandName} has an unsupported parameter: ${trimmed}`,
    );
  }
  const pattern = withoutAttributes
    .slice(0, colon)
    .trim()
    .replace(/^mut\s+/, "");
  const name = pattern.replace(/^r#/, "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `${sourcePath} ${commandName} has an unsupported parameter pattern: ${pattern}`,
    );
  }
  return { name, type: withoutAttributes.slice(colon + 1).trim() };
}

function isInjectedTauriParameter(type) {
  const compact = type.replace(/\s+/g, "").replace(/^&(?:mut)?/, "");
  // `Webview` is injected the same way `Window` is — a command takes it to
  // learn which renderer called it, and the renderer never sends it.
  return /(?:^|::)(?:State|AppHandle|Window|WebviewWindow|Webview)(?:<|$)/.test(
    compact,
  );
}

function isOptionalRustType(type) {
  return /(?:^|::)Option\s*</.test(type.replace(/^\s*&(?:\s*mut)?\s*/, ""));
}

function rustNameToCamelCase(name) {
  return name.replace(/_([a-z0-9])/g, (_, character) =>
    character.toUpperCase(),
  );
}

function normalizeRustType(type) {
  return type
    .replace(/\s+/g, " ")
    .replace(/\s*([<>()\[\],:&])\s*/g, "$1")
    .trim();
}

function parseReturnType(betweenParametersAndBody) {
  const arrow = betweenParametersAndBody.indexOf("->");
  if (arrow < 0) return "()";
  const returnAndWhere = betweenParametersAndBody.slice(arrow + 2).trim();
  const where = findTopLevelWord(returnAndWhere, "where", {
    trackAngles: true,
  });
  return normalizeRustType(
    where < 0 ? returnAndWhere : returnAndWhere.slice(0, where),
  );
}

function parseCommandExpression(expression) {
  const commands = [];
  for (const match of expression.matchAll(/["']([a-z][a-z0-9_]*)["']/g)) {
    if (COMMAND_NAME.test(match[1]) && !commands.includes(match[1]))
      commands.push(match[1]);
  }
  return commands;
}

function parseInvokeArguments(expression) {
  if (expression === undefined || /^\s*(?:undefined)?\s*$/.test(expression)) {
    return { keys: [], complete: true };
  }
  const trimmed = expression.trim();
  if (!trimmed.startsWith("{")) return { keys: [], complete: false };
  const close = findMatchingDelimiter(trimmed, 0, "{", "}");
  if (trimmed.slice(close + 1).trim()) return { keys: [], complete: false };

  const keys = [];
  let complete = true;
  for (const property of splitTopLevel(trimmed.slice(1, close))) {
    const entry = property.trim();
    if (!entry) continue;
    if (entry.startsWith("...") || entry.startsWith("[")) {
      complete = false;
      continue;
    }
    const key = entry.match(
      /^(?:([A-Za-z_$][A-Za-z0-9_$]*)|["']([^"']+)["'])\s*(?::|$)/,
    );
    if (!key) {
      complete = false;
      continue;
    }
    keys.push(key[1] ?? key[2]);
  }
  return { keys, complete };
}

function findFunctionBody(source, start) {
  const body = findTopLevelCharacter(source.slice(start), "{");
  if (body < 0) throw new Error("could not locate command function body");
  return start + body;
}

function splitTopLevel(source, options = {}) {
  const segments = [];
  let start = 0;
  scanCode(source, options, (index, character, depth) => {
    if (character === "," && depth === 0) {
      segments.push(source.slice(start, index));
      start = index + 1;
    }
  });
  segments.push(source.slice(start));
  return segments;
}

function findTopLevelCharacter(source, target, options = {}) {
  let found = -1;
  scanCode(source, options, (index, character, depth) => {
    if (found < 0 && character === target && depth === 0) found = index;
  });
  return found;
}

function findTopLevelWord(source, target, options = {}) {
  let found = -1;
  scanCode(source, options, (index, _character, depth) => {
    if (
      found < 0 &&
      depth === 0 &&
      source.slice(index, index + target.length) === target &&
      !/[A-Za-z0-9_]/.test(source[index - 1] ?? "") &&
      !/[A-Za-z0-9_]/.test(source[index + target.length] ?? "")
    ) {
      found = index;
    }
  });
  return found;
}

function scanCode(source, options, visit) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  let angleDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return;
      continue;
    }
    if (character === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 1;
      continue;
    }
    if (isQuoteStart(source, index)) {
      index = skipQuoted(source, index, character);
      continue;
    }
    const depth = stack.length + angleDepth;
    visit(index, character, depth);
    if (pairs[character]) stack.push(pairs[character]);
    else if (stack.at(-1) === character) stack.pop();
    else if (options.trackAngles && character === "<") angleDepth += 1;
    else if (options.trackAngles && character === ">" && angleDepth > 0)
      angleDepth -= 1;
  }
}

function findMatchingDelimiter(source, openIndex, open, close) {
  if (source[openIndex] !== open)
    throw new Error(`expected ${open} at offset ${openIndex}`);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === "/" && next === "*") {
      const commentClose = source.indexOf("*/", index + 2);
      index = commentClose < 0 ? source.length : commentClose + 1;
      continue;
    }
    if (isQuoteStart(source, index)) {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`unclosed ${open} at offset ${openIndex}`);
}

function findMatchingAngle(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (isQuoteStart(source, index)) {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === "<") depth += 1;
    else if (character === ">") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`unclosed type arguments at offset ${openIndex}`);
}

function skipQuoted(source, openIndex, quote) {
  for (let index = openIndex + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return source.length - 1;
}

function isQuoteStart(source, index) {
  const quote = source[index];
  if (quote === '"' || quote === "`") return true;
  if (quote !== "'") return false;
  // Rust lifetimes use apostrophes without a closing quote.
  return !/^'[A-Za-z_][A-Za-z0-9_]*(?=\s*[,>:)]|$)/.test(source.slice(index));
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}
