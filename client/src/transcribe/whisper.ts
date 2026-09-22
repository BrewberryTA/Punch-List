// Main-thread wrapper around whisper.worker.ts — the actual on-device
// speech-to-text step. This is what replaced the original AssemblyAI/
// Deepgram plan: transcription happens locally in the browser via an
// open-source Whisper model, so there's no STT vendor, no ongoing
// subscription, and (after the model's one-time download) it works with
// zero signal, which matters more than any cloud API's price for a job
// site with no bars.

export interface TranscriptChunk {
  text: string;
  start: number; // ms from the start of the recording
  end: number;
}

export interface TranscriptionResult {
  text: string;
  chunks: TranscriptChunk[];
}

export type TranscriptionProgress = { progress: number; status: string };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  string,
  {
    resolve: (r: TranscriptionResult) => void;
    reject: (e: Error) => void;
    onProgress?: (p: TranscriptionProgress) => void;
  }
>();

interface WorkerOutMessage {
  type: "progress" | "result" | "error";
  id: string;
  progress?: number;
  status?: string;
  text?: string;
  chunks?: TranscriptChunk[];
  message?: string;
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      if (msg.type === "progress") {
        entry.onProgress?.({ progress: msg.progress ?? 0, status: msg.status ?? "" });
      } else if (msg.type === "result") {
        pending.delete(msg.id);
        entry.resolve({ text: msg.text ?? "", chunks: msg.chunks ?? [] });
      } else if (msg.type === "error") {
        pending.delete(msg.id);
        entry.reject(new Error(msg.message ?? "transcription failed"));
      }
    };
  }
  return worker;
}

// MediaRecorder gives us webm/opus at whatever the mic's native sample rate
// is; Whisper needs 16kHz mono Float32 samples. Decode + resample via
// OfflineAudioContext rather than shipping a resampling library.
async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtxCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioCtxCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    await decodeCtx.close();
  }

  const targetRate = 16000;
  const OfflineCtxCtor =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const offline = new OfflineCtxCtor(
    1,
    Math.max(1, Math.ceil(decoded.duration * targetRate)),
    targetRate
  );
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export async function transcribeAudioBlob(
  blob: Blob,
  onProgress?: (p: TranscriptionProgress) => void
): Promise<TranscriptionResult> {
  if (blob.size === 0) {
    return { text: "", chunks: [] };
  }
  const audio = await decodeTo16kMono(blob);
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    // Transfer the buffer instead of copying it — the worker owns it now.
    getWorker().postMessage({ type: "transcribe", id, audio }, [audio.buffer]);
  });
}
