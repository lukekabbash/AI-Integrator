import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HISTORY_SIZES = [250, 1_000, 5_000];
const STREAM_EVENTS = 64;
const APPEND_BYTES = 32;
const WARMUP_SAMPLES = 10;
const MEASURED_SAMPLES = 40;
const FIXED_TIME = "2026-01-01T00:00:00.000Z";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentile(samples, ratio) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function rounded(value) {
  return Number(value.toFixed(4));
}

function summarize(surface, scenario, variant, samples, checksum) {
  return {
    surface,
    scenario,
    variant,
    sampleCount: samples.length,
    medianMs: rounded(percentile(samples, 0.5)),
    p95Ms: rounded(percentile(samples, 0.95)),
    minMs: rounded(Math.min(...samples)),
    maxMs: rounded(Math.max(...samples)),
    checksum,
  };
}

function measurePair(
  surface,
  scenario,
  referenceName,
  reference,
  candidateName,
  candidate,
  checksum,
) {
  for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
    reference();
    candidate();
  }

  const referenceSamples = [];
  const candidateSamples = [];
  let referenceChecksum = 0;
  let candidateChecksum = 0;
  const measure = (run, samples) => {
    const start = performance.now();
    const result = run();
    samples.push(performance.now() - start);
    return checksum(result);
  };

  for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
    if (index % 2 === 0) {
      referenceChecksum += measure(reference, referenceSamples);
      candidateChecksum += measure(candidate, candidateSamples);
    } else {
      candidateChecksum += measure(candidate, candidateSamples);
      referenceChecksum += measure(reference, referenceSamples);
    }
  }

  assert.equal(candidateChecksum, referenceChecksum);
  return [
    summarize(surface, scenario, referenceName, referenceSamples, referenceChecksum),
    summarize(surface, scenario, candidateName, candidateSamples, candidateChecksum),
  ];
}

function mcpItem(index) {
  const oldText = Array.from({ length: 16 }, (_, line) => `before ${index} ${line}`).join("\n");
  const newText = Array.from({ length: 16 }, (_, line) => `after ${index} ${line}`).join("\n");
  return {
    id: `item-${index}`,
    providerItemId: `item-${index}`,
    kind: "mcpTool",
    status: "completed",
    mcpTool: "edit",
    toolInput: JSON.stringify({
      path: `fixture/file-${index}.ts`,
      old_string: oldText,
      new_string: newText,
    }),
    truncated: false,
    updatedAt: FIXED_TIME,
  };
}

function assistantItem(index, body = "stream") {
  return {
    id: `item-${index}`,
    providerItemId: `item-${index}`,
    kind: "agentMessage",
    status: "inProgress",
    body,
    truncated: false,
    updatedAt: FIXED_TIME,
  };
}

function projectionEvent(seq, projectedItem) {
  return {
    seq,
    taskId: "benchmark-task",
    providerSessionId: "benchmark-session",
    provider: "codex",
    threadId: "benchmark-thread",
    turnId: "benchmark-turn",
    occurredAt: FIXED_TIME,
    projection: { kind: "itemChanged", item: projectedItem },
  };
}

function historyState(createRuntimeProjectionState, size) {
  const state = createRuntimeProjectionState("benchmark-task");
  const items = Array.from({ length: size }, (_, index) =>
    index === size - 1 ? assistantItem(index) : mcpItem(index),
  );
  return {
    ...state,
    lastSeq: size,
    items,
    firstSeen: Object.fromEntries(items.map((projectedItem) => [projectedItem.id, FIXED_TIME])),
  };
}

function burstForScenario(state, scenario, sample = 0) {
  const baseSeq = state.lastSeq + 1;
  if (scenario === "same-item-burst") {
    const target = state.items.at(-1);
    return Array.from({ length: STREAM_EVENTS }, (_, index) =>
      projectionEvent(baseSeq + index, {
        ...target,
        status: "inProgress",
        body: `${sample}:`.padEnd((index + 1) * APPEND_BYTES, "x"),
      }),
    );
  }
  if (scenario === "distinct-item-burst") {
    return Array.from({ length: STREAM_EVENTS }, (_, index) => {
      const target = state.items[state.items.length - STREAM_EVENTS + index];
      return projectionEvent(baseSeq + index, {
        ...target,
        status: "inProgress",
        body: `updated ${sample} ${index}`,
      });
    });
  }
  return Array.from({ length: STREAM_EVENTS }, (_, index) =>
    projectionEvent(baseSeq + index, {
      ...mcpItem(state.items.length + index),
      body: `appended ${sample} ${index}`,
    }),
  );
}

function growingAssistantStates(state, count) {
  const itemIndex = state.items.length - 1;
  const current = state.items[itemIndex];
  return Array.from({ length: count }, (_, sample) => {
    const items = [...state.items];
    items[itemIndex] = {
      ...current,
      body: `${sample}:`.padEnd((sample + 1) * APPEND_BYTES, "x"),
    };
    return { ...state, lastSeq: state.lastSeq + sample + 1, items };
  });
}

function sampleRunner(samples, run) {
  let index = 0;
  return () => run(samples[index++]);
}

function reductionChecksum(state) {
  const tail = state.items.at(-1);
  return state.lastSeq + state.items.length + (tail?.id.length ?? 0) + (tail?.body?.length ?? 0);
}

function transcriptChecksum(events) {
  const first = events[0];
  const last = events.at(-1);
  return (
    events.length + (first?.id.length ?? 0) + (last?.id.length ?? 0) + (last?.body.length ?? 0)
  );
}

async function main() {
  const server = await createServer({
    root: desktopRoot,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });

  try {
    const runtimeProjection = await server.ssrLoadModule("/src/runtimeProjection.ts");
    const {
      applyRuntimeProjection,
      applyRuntimeProjectionBatch,
      createRuntimeProjectionState,
      createRuntimeTranscriptDeriver,
      runtimeTranscript,
    } = runtimeProjection;
    const measurements = [];
    const heaviestState = historyState(createRuntimeProjectionState, HISTORY_SIZES.at(-1));
    const sampleCount = WARMUP_SAMPLES + MEASURED_SAMPLES;

    for (const scenario of ["same-item-burst", "distinct-item-burst", "append-burst"]) {
      const eventSamples = Array.from({ length: sampleCount }, (_, sample) =>
        burstForScenario(heaviestState, scenario, sample),
      );
      for (const events of eventSamples) {
        assert.deepEqual(
          applyRuntimeProjectionBatch(heaviestState, events),
          events.reduce(applyRuntimeProjection, heaviestState),
        );
      }
      measurements.push(
        ...measurePair(
          "reduction",
          scenario,
          "sequential",
          sampleRunner(eventSamples, (events) =>
            events.reduce(applyRuntimeProjection, heaviestState),
          ),
          "batch",
          sampleRunner(eventSamples, (events) =>
            applyRuntimeProjectionBatch(heaviestState, events),
          ),
          reductionChecksum,
        ),
      );
    }

    for (const size of HISTORY_SIZES) {
      const state = historyState(createRuntimeProjectionState, size);
      const stateSamples = growingAssistantStates(state, sampleCount);
      const verificationDeriver = createRuntimeTranscriptDeriver();
      for (const sample of stateSamples) {
        assert.deepEqual(verificationDeriver(sample), runtimeTranscript(sample));
      }
      const measuredDeriver = createRuntimeTranscriptDeriver();
      measurements.push(
        ...measurePair(
          "derivation",
          `history-${size}`,
          "canonical",
          sampleRunner(stateSamples, runtimeTranscript),
          "cached",
          sampleRunner(stateSamples, measuredDeriver),
          transcriptChecksum,
        ),
      );
    }

    const combinedEventSamples = Array.from({ length: sampleCount }, (_, sample) =>
      burstForScenario(heaviestState, "same-item-burst", sample),
    );
    const verificationDeriver = createRuntimeTranscriptDeriver();
    for (const events of combinedEventSamples) {
      const sequentialState = events.reduce(applyRuntimeProjection, heaviestState);
      const batchedState = applyRuntimeProjectionBatch(heaviestState, events);
      assert.deepEqual(batchedState, sequentialState);
      assert.deepEqual(verificationDeriver(batchedState), runtimeTranscript(sequentialState));
    }
    const combinedDeriver = createRuntimeTranscriptDeriver();
    combinedDeriver(heaviestState);
    measurements.push(
      ...measurePair(
        "reduction-and-derivation",
        "same-item-burst",
        "sequential-canonical",
        sampleRunner(combinedEventSamples, (events) => {
          const state = events.reduce(applyRuntimeProjection, heaviestState);
          return { state, transcript: runtimeTranscript(state) };
        }),
        "batch-cached",
        sampleRunner(combinedEventSamples, (events) => {
          const state = applyRuntimeProjectionBatch(heaviestState, events);
          return { state, transcript: combinedDeriver(state) };
        }),
        ({ state, transcript }) => reductionChecksum(state) + transcriptChecksum(transcript),
      ),
    );

    const [source, harness] = await Promise.all([
      readFile(new URL("../src/runtimeProjection.ts", import.meta.url)),
      readFile(fileURLToPath(import.meta.url)),
    ]);
    const report = {
      schemaVersion: 1,
      suite: "renderer-projection-v1",
      sourceFingerprint: createHash("sha256").update(source).digest("hex"),
      harnessFingerprint: createHash("sha256").update(harness).digest("hex"),
      environment: {
        node: process.versions.node,
        v8: process.versions.v8,
        platform: platform(),
        arch: arch(),
      },
      fixture: {
        fixtureId: "renderer-projection-20260715",
        historyItems: HISTORY_SIZES,
        historicalMcpItems: 4_999,
        editLinesPerSide: 16,
        streamEventsPerBurst: STREAM_EVENTS,
        appendBytesPerEvent: APPEND_BYTES,
        warmupSamples: WARMUP_SAMPLES,
        measuredSamples: MEASURED_SAMPLES,
      },
      measurements,
      equivalence: {
        reducerState: true,
        canonicalTranscript: true,
        finalSequence: heaviestState.lastSeq + STREAM_EVENTS,
      },
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const output = argumentValue("--out");
    if (output) {
      const outputPath = resolve(process.cwd(), output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, json, "utf8");
    }
    process.stdout.write(json);
  } finally {
    await server.close();
  }
}

await main();
