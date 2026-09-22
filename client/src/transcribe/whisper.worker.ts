// Runs entirely inside a Web Worker so transcription never blocks the UI
// thread. Uses an open-source Whisper model via @huggingface/transformers
// (WASM, with WebGPU acceleration where the device supports it) — no cloud
// STT vendor, no subscription. The model file (~70MB, quantized) is fetched
// from the Hugging Face CDN once and cached by the browser; every run after
// that is fully offline.
import { pipeline as createPipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/whisper-base";

// The real `pipeline()` type is a huge overloaded union across every task
// type transformers.js supports; TS chokes trying to resolve it (TS2590).
// We only ever call it with one task, so narrow it to a plain function type
// once here instead of fighting the overload set at every call site.
type PipelineFn = (
  task: "automatic-speech-recognition",
  model: string,
  options?: Record<string, unknown>
) => Promise<AutomaticSpeechRecognitionPipeline>;
const pipeline = createPipeline as unknown as PipelineFn;

type InMessage = { type: "transcribe"; id: string; audio: Float32Array };

type OutMessage =
  | { type: "progress"; id: string; progress: number; status: string }
  | {
      type: "result";
      id: string;
      text: string;
      chunks: { text: string; start: number; end: number }[];
    }
  | { type: "error"; id: string; message: string };

function post(msg: OutMessage) {
  (self as unknown as Worker).postMessage(msg);
}

let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getPipeline(progressId: string) {
  if (!pipelinePromise) {
    pipelinePromise = pipeline("automatic-speech-recognition", MODEL_ID, {
      dtype: "q8",
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === "progress" && typeof p.progress === "number") {
          post({
            type: "progress",
            id: progressId,
            progress: p.progress,
            status: p.file ?? "model",
          });
        }
      },
    });
  }
  return pipelinePromise;
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  try {
    const transcriber = await getPipeline(msg.id);
    const output = await transcriber(msg.audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (Array.isArray(output) ? output[0] : output) as any;
    const rawChunks: { text: string; timestamp: [number, number | null] }[] =
      result.chunks ?? [];
    const chunks = rawChunks.map((c) => ({
      text: c.text as string,
      start: Math.round((c.timestamp?.[0] ?? 0) * 1000),
      end: Math.round((c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) * 1000),
    }));
    post({
      type: "result",
      id: msg.id,
      text: (result.text as string) ?? "",
      chunks,
    });
  } catch (err) {
    post({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
