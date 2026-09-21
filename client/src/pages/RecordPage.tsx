import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getDb, type LocalMedia, type LocalWalkthrough } from "../offline/db";
import { syncAll } from "../offline/sync";

type Phase = "idle" | "recording" | "finishing" | "done";

export function RecordPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [photoCount, setPhotoCount] = useState(0);
  const [videoClipCount, setVideoClipCount] = useState(0);
  const [recordingVideoClip, setRecordingVideoClip] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const walkthroughIdRef = useRef<string>(crypto.randomUUID());
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<number | undefined>(undefined);

  const audioStreamRef = useRef<MediaStream | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const clipRecorderRef = useRef<MediaRecorder | null>(null);
  const clipChunksRef = useRef<Blob[]>([]);
  const clipStartRef = useRef<number>(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    return () => {
      stopAllTracks();
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopAllTracks() {
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    videoStreamRef.current?.getTracks().forEach((t) => t.stop());
  }

  async function startWalkthrough() {
    if (!projectId) return;
    setError(null);
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      audioStreamRef.current = audioStream;

      let videoStream: MediaStream | null = null;
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        videoStreamRef.current = videoStream;
        if (videoRef.current) {
          videoRef.current.srcObject = videoStream;
          await videoRef.current.play().catch(() => undefined);
        }
      } catch {
        // Camera preview is optional — narration + audio recording still
        // works without it, photo/video capture just won't be available.
        setError(
          "Camera not available — you can still record audio, but photo/video capture is off for this walkthrough."
        );
      }

      audioChunksRef.current = [];
      const recorder = new MediaRecorder(audioStream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      audioRecorderRef.current = recorder;
      recorder.start(1000);

      startTimeRef.current = Date.now();
      timerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 250);

      setPhase("recording");
    } catch (e) {
      setError(
        "Couldn't access the microphone. Check site permissions and try again."
      );
    }
  }

  function capturedAtMs() {
    return Date.now() - startTimeRef.current;
  }

  async function snapPhoto() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !videoStreamRef.current) return;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85)
    );
    if (!blob) return;

    const media: LocalMedia = {
      id: crypto.randomUUID(),
      walkthroughId: walkthroughIdRef.current,
      kind: "photo",
      blob,
      capturedAtMs: capturedAtMs(),
      uploaded: false,
      createdAt: new Date().toISOString(),
    };
    const db = await getDb();
    await db.put("media", media);
    setPhotoCount((c) => c + 1);
    setFlash(true);
    setTimeout(() => setFlash(false), 200);
  }

  function toggleVideoClip() {
    if (!recordingVideoClip) {
      const stream = videoStreamRef.current;
      if (!stream) return;
      clipChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) clipChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(clipChunksRef.current, { type: "video/webm" });
        const media: LocalMedia = {
          id: crypto.randomUUID(),
          walkthroughId: walkthroughIdRef.current,
          kind: "video",
          blob,
          capturedAtMs: clipStartRef.current,
          uploaded: false,
          createdAt: new Date().toISOString(),
        };
        const db = await getDb();
        await db.put("media", media);
        setVideoClipCount((c) => c + 1);
      };
      clipStartRef.current = capturedAtMs();
      recorder.start();
      clipRecorderRef.current = recorder;
      setRecordingVideoClip(true);
    } else {
      clipRecorderRef.current?.stop();
      setRecordingVideoClip(false);
    }
  }

  async function finishWalkthrough() {
    if (!projectId) return;
    setPhase("finishing");
    if (timerRef.current) window.clearInterval(timerRef.current);

    const recorder = audioRecorderRef.current;
    const audioBlob: Blob = await new Promise((resolve) => {
      if (!recorder) return resolve(new Blob());
      recorder.onstop = () =>
        resolve(new Blob(audioChunksRef.current, { type: "audio/webm" }));
      recorder.stop();
    });

    stopAllTracks();

    const walkthrough: LocalWalkthrough = {
      id: walkthroughIdRef.current,
      projectId,
      projectName: "", // filled in by caller screens from server data if needed
      status: "ready_to_sync",
      audioBlob,
      audioUploaded: false,
      createdAt: new Date().toISOString(),
    };
    const db = await getDb();
    await db.put("walkthroughs", walkthrough);

    void syncAll();
    setPhase("done");
    navigate(`/walkthroughs/${walkthroughIdRef.current}`);
  }

  function formatElapsed(ms: number) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, "0")}`;
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Walkthrough</h1>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="camera-frame">
        <video ref={videoRef} muted playsInline className="camera-preview" />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {flash && <div className="flash" />}
      </div>

      {phase === "idle" && (
        <button className="primary big" onClick={startWalkthrough}>
          ● Start Recording
        </button>
      )}

      {phase === "recording" && (
        <>
          <div className="record-status">
            <span className="rec-dot" /> Recording — {formatElapsed(elapsedMs)}
          </div>
          <div className="capture-row">
            <button className="primary" onClick={snapPhoto}>
              📷 Photo ({photoCount})
            </button>
            <button
              className={recordingVideoClip ? "danger" : "primary"}
              onClick={toggleVideoClip}
            >
              {recordingVideoClip ? "■ Stop clip" : `🎥 Video (${videoClipCount})`}
            </button>
          </div>
          <button className="secondary big" onClick={finishWalkthrough}>
            Finish Walkthrough
          </button>
        </>
      )}

      {phase === "finishing" && <p>Wrapping up…</p>}
    </div>
  );
}
