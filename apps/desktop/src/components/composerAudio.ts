export function formatVoiceElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Box-filter downsample to 24 kHz signed 16-bit PCM. No anti-alias filter;
 * averaging each output window is adequate for speech into a transcriber. */
export function encodePcm16(samples: Float32Array, sourceRate: number): Int16Array {
  const targetRate = 24000;
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const pcm = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor((index * sourceRate) / targetRate);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor(((index + 1) * sourceRate) / targetRate)),
    );
    let sum = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) sum += samples[sampleIndex];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    pcm[index] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
  }
  return pcm;
}

/** Serializes buffered PCM chunks to base64 for the one-shot native upload.
 * Int16Array is little-endian on every supported platform, matching the WAV
 * container the backend wraps around these bytes. */
export function pcmChunksToBase64(chunks: Int16Array[]): string {
  let totalSamples = 0;
  for (const chunk of chunks) totalSamples += chunk.length;
  const bytes = new Uint8Array(totalSamples * 2);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.byteLength;
  }
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}
