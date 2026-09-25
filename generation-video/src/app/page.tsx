"use client";

import { FormEvent, useState } from "react";
import Image from "next/image";

type MediaType = "image" | "video";
type Generation =
  | { type: "image"; url: string }
  | { type: "video"; url: string; durationSeconds: number };

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelSide, setPanelSide] = useState<"left" | "right">("left");
  const [mediaType, setMediaType] = useState<MediaType | null>(null);
  const [isMediaMenuOpen, setIsMediaMenuOpen] = useState(false);

  async function generateMedia(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || !mediaType || isGenerating) return;

    const selectedMediaType = mediaType;
    setIsGenerating(true);
    setError(null);
    try {
      const response = await fetch(selectedMediaType === "video" ? "/api/generate-video" : "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedMediaType === "video" ? { prompt: prompt.trim() } : { prompt: prompt.trim(), shotId: `quick-${Date.now()}` }),
      });
      const result = await response.json() as { videoUrl?: string; assetUrl?: string; durationSeconds?: number; error?: string };
      if (!response.ok) throw new Error(result.error ?? `${selectedMediaType === "video" ? "Video" : "Image"} generation failed.`);
      if (selectedMediaType === "video" && result.videoUrl) setGeneration({ type: "video", url: result.videoUrl, durationSeconds: result.durationSeconds ?? 6 });
      else if (selectedMediaType === "image" && result.assetUrl) setGeneration({ type: "image", url: result.assetUrl });
      else throw new Error("The generation did not return an asset.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : `${selectedMediaType === "video" ? "Video" : "Image"} generation failed.`);
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className={`generator panel-${panelSide}`}>
      <aside className="video-panel">
        <div className="panel-header"><div className="brand"><span className="logo-mark">L</span><strong>Longform</strong></div><button className="move-panel" onClick={() => setPanelSide((current) => current === "left" ? "right" : "left")}>Move {panelSide === "left" ? "right →" : "← left"}</button></div>
        <div className="panel-content">
          <span className="section-label">Generated {generation?.type ?? mediaType ?? "media"}</span>
          {generation?.type === "video" ? <video className="result-video" controls autoPlay loop src={generation.url} /> : generation?.type === "image" ? <Image className="result-image" src={generation.url} alt="Generated result" width={1280} height={720} unoptimized /> : <div className={`empty-video ${isGenerating ? "rendering" : ""}`}><span>{isGenerating ? "◌" : "✦"}</span><p>{isGenerating ? `Rendering your ${mediaType}` : mediaType ? `Your ${mediaType} will appear here` : "Choose image or video to begin"}</p><small>{isGenerating && mediaType === "video" ? "Generating key image and motion" : "Select an output using the + button"}</small></div>}
          {generation?.type === "video" && <p className="video-meta">{generation.durationSeconds} second MP4 · BFL image + FFmpeg motion</p>}
        </div>
        <p className="panel-note">Generated files remain local in <code>output/</code>.</p>
      </aside>

      <section className="prompt-stage">
        <div className="prompt-content">
          <span className="eyebrow">AI video studio</span>
          <h1>What&apos;s on your mind today?</h1>
          <p>Describe a moment. Choose an image or a short visual video.</p>
          <div className="composer">
            <form className="prompt-form" onSubmit={generateMedia}>
              <div className="media-selector">
              <button className="add-button" type="button" aria-label="Choose media type" aria-expanded={isMediaMenuOpen} onClick={() => setIsMediaMenuOpen((open) => !open)}>+</button>
              </div>
              <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mediaType ? `Describe your ${mediaType}` : "Ask anything"} aria-label="Generation idea" maxLength={32000} />
              <button className="generate-button" aria-label={`Generate ${mediaType ?? "media"}`} disabled={!prompt.trim() || !mediaType || isGenerating}>{isGenerating ? <span className="spinner" /> : "↟"}</button>
            </form>
            {isMediaMenuOpen && <div className="media-menu"><button type="button" className={mediaType === "image" ? "selected" : ""} onClick={() => { setMediaType("image"); setIsMediaMenuOpen(false); }}><span className="media-icon">▧</span><span><strong>Image</strong><small>Generate a single image with FLUX</small></span></button><button type="button" className={mediaType === "video" ? "selected" : ""} onClick={() => { setMediaType("video"); setIsMediaMenuOpen(false); }}><span className="media-icon">▶</span><span><strong>Video</strong><small>Generate a 6-second motion clip</small></span></button></div>}
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
          <p className="hint">{mediaType ? (mediaType === "video" ? "BFL generates the key image; FFmpeg creates a six-second motion clip." : "BFL generates a still image.") : "Select Image or Video with + before you can generate."} Your BFL key stays on the server.</p>
        </div>
      </section>
    </main>
  );
}
