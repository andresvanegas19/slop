"use client";

/*
 * All studio state and actions (moved from app/page.tsx; behaviour unchanged).
 * Components read the returned view model; API calls, request bodies, storage keys and copy live here.
 */
import { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, SyntheticEvent, useEffect, useRef, useState } from "react";
import type { AppendResult, AskResult, BusyState, CommandResult, ContinueAction, FrameGrab, HistoryItem, HistoryKind, LiveProgress, MediaType, NewVideoSuggestion, PendingOp, Project, ProjectFrame, RangeDrag, RenderResult, ThreadEntry, TimeWindow } from "../types";
import { FRAME_STEP, MAX_UPLOAD_BYTES, RANGE_MIN_SEC, clampRange, captureVideoThumb, defaultRange, errorMessage, formatBytes, formatWindow, frameIndexAt, historyItemFromProject, isAbortError, isProject, isTimeWindow, isVideoFile, issueMessages, kindLabel, mergeThread, nowIso, memoryChips, ragLabels, readJson, threadFromProject } from "../utils";
import { readHistory, setHistoryOpen, updateHistory, useHistory, useHistoryOpen } from "./historyStore";
import { useStories } from "./useStories";
import { loadContinueMode, loadLocalThread, saveContinueMode, saveLocalThread } from "./storage";
import { useAbortSlot } from "./useAbortSlot";
import { emptyLive, reduceLive } from "../live";
import type { StreamEvent } from "../stream";
import { cancelJob as cancelServerJob, fetchActiveJobs, fetchJob, loadStoredJobs, removeStoredJob, resumeJob as resumeServerJob, runJob, saveStoredJob, subscribeStoredJobs, updateStoredJob, type StoredJob } from "../jobs";
import { useVideoAttachment } from "./useVideoAttachment";
import { presetDuration, researchCompanyFor } from "../research-detect";
import type { Storyline } from "@/lib/storyline";
import { getActiveResearchId, setActiveResearch, startResearchSession, useActiveResearch, useResearch, type ResearchTarget } from "./useResearch";

export function useStudio() {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingKind, setGeneratingKind] = useState<HistoryKind>("clip");
  const [generationLive, setGenerationLive] = useState<LiveProgress | null>(null);
  // The prompt of the running new generation (shown on the main stage while it works).
  const [generatingPrompt, setGeneratingPrompt] = useState("");
  // Jobs interrupted by a server restart (from localStorage), offered for Resume.
  const [interruptedJobs, setInterruptedJobs] = useState<StoredJob[]>([]);
  const restoredRef = useRef(false);
  const [isStartingResearch, setIsStartingResearch] = useState(false);
  const homeResearch = useActiveResearch();
  const [error, setError] = useState<string | null>(null);
  const [narrationMessages, setNarrationMessages] = useState<string[]>([]);
  const [mediaType, setMediaType] = useState<MediaType | null>(null);
  const [isMediaMenuOpen, setIsMediaMenuOpen] = useState(false);
  const [storyboard, setStoryboard] = useState<unknown | null>(null);
  const [storyboardFileName, setStoryboardFileName] = useState<string | null>(null);
  const [storyboardError, setStoryboardError] = useState<string | null>(null);

  const history = useHistory();
  const isHistoryOpen = useHistoryOpen();
  const [notice, setNotice] = useState<string | null>(null);
  const generationAbort = useAbortSlot();
  const editAbort = useAbortSlot();

  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [grab, setGrab] = useState<FrameGrab | null>(null);
  const [videoReload, setVideoReload] = useState(0);
  const [editingAt, setEditingAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [range, setRangeState] = useState<TimeWindow | null>(null);
  const [confirmCut, setConfirmCut] = useState(false);
  const [confirmRemoveFrame, setConfirmRemoveFrame] = useState<number | null>(null);
  const [sourceProject, setSourceProject] = useState<HistoryItem | null>(null);
  const [isHistoryPickerOpen, setIsHistoryPickerOpen] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);
  const [rangeLimit, setRangeLimit] = useState<string | null>(null);
  const rangeRef = useRef<TimeWindow | null>(null);
  const rangeDragRef = useRef<RangeDrag | null>(null);
  const rangeLimitTimerRef = useRef<number | null>(null);
  const [flashWindow, setFlashWindow] = useState<TimeWindow | null>(null);
  const grabKeyRef = useRef(0);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const [grabConfirmed, setGrabConfirmed] = useState<number | null>(null);
  const [continueAction, setContinueAction] = useState<ContinueAction>("auto");
  const { attachment, clearAttachment, startUpload, setLocalDuration } = useVideoAttachment();
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [localThread, setLocalThread] = useState<ThreadEntry[]>([]);
  const [pendingOp, setPendingOp] = useState<PendingOp | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const threadIdRef = useRef(0);
  const threadRef = useRef<HTMLDivElement>(null);
  const [editedNote, setEditedNote] = useState<string | null>(null);
  const [presetLength, setPresetLength] = useState(10);
  // "Stories" (+ menu): N different 3-beat stories → pick one → one continuous video (see useStories / StoryPicker).
  const [storyCount, setStoryCount] = useState(3);
  const [storyLength, setStoryLength] = useState(5);
  const stories = useStories({ onProjects: addStoryProjects });
  function addStoryProjects(projects: Project[]) {
    {
      const items: HistoryItem[] = projects.map((created) => ({
        projectId: created.id,
        title: created.title || "Story",
        videoUrl: created.videoUrl,
        thumbUrl: created.frames[0]?.imageUrl ?? "",
        durationSeconds: created.durationSeconds,
        createdAt: created.createdAt || new Date().toISOString(),
        kind: "clip",
        generatedSeconds: created.durationSeconds,
      }));
      updateHistory((existing) => [...items, ...existing.filter((item) => !items.some((added) => added.projectId === item.projectId))]);
      if (items[0]) void openProject(items[0]);
    }
  }
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const isScrubbingRef = useRef(false);
  const grabOnSeekRef = useRef(false);
  const ignorePauseRef = useRef(false);
  const seekOnLoadRef = useRef<number | null>(null);
  const openRequestRef = useRef(0);
  const openProjectIdRef = useRef<string | null>(null);

  const isEditorOpen = openProjectId !== null;
  const isContinueMode = isEditorOpen;
  const isEditing = editingAt !== null;
  const openItem = history.find((item) => item.projectId === openProjectId);
  const openTitle = project?.title ?? openItem?.title ?? "project";
  // The research session shown in the thread: the one linked to the open video, or the active one on the home screen.
  const researchTarget: ResearchTarget | null = isEditorOpen
    ? openItem?.researchSessionId ? { id: openItem.researchSessionId, prompt: openItem.title, company: "", durationSec: openItem.generatedSeconds ?? openItem.durationSeconds } : null
    : homeResearch;
  const research = useResearch(researchTarget);
  const duration = videoDuration > 0 ? videoDuration : project?.durationSeconds ?? 0;
  const lastFrame = project?.frames[project.frames.length - 1];
  const timelineTotal = Math.max(duration, lastFrame ? lastFrame.startSec + lastFrame.durationSec : 0, 0.001);
  const targetSec = grab?.atSec ?? currentTime;
  const targetFrame = project ? frameIndexAt(project.frames, targetSec) : 0;
  const isStoryboardProject = project?.kind === "storyboard";
  const isAppendMode = isContinueMode && continueAction === "append";
  const isAutoMode = isContinueMode && continueAction === "auto";
  const isAtEnd = isAutoMode && Boolean(project) && duration > 0 && (grab?.atSec ?? currentTime) >= duration - 0.25;
  const editWindow = project && isContinueMode && !isAppendMode && !isAtEnd ? range ?? defaultRange(project.frames, targetSec) : null;
  const attachDisabledReason = isContinueMode
    ? isStoryboardProject ? "Append isn't supported for storyboards yet" : continueAction === "edit" ? "Switch to Append shot to add a video" : null
    : null;

  useEffect(() => {
    if (!isEditorOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      openRequestRef.current += 1;
      openProjectIdRef.current = null;
      setOpenProjectId(null);
      setProject(null);
      setProjectError(null);
      setGrab(null);
      setLocalThread([]);
      setPendingOp(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isEditorOpen]);

  useEffect(() => {
    if (!isGenerating || isEditorOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") generationAbort.abort();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isGenerating, isEditorOpen, generationAbort]);

  // New research questions / answers also scroll the conversation.
  const researchMessages = research.session ? research.session.questions.length + research.session.questions.filter((question) => question.answered).length + (research.session.competitors ? 1 : 0) + (research.session.storylineWriting ? 1 : 0) + (research.session.storyline?.version ?? 0) : 0;
  const threadLength = isContinueMode && project ? Object.values(project.chats ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0) + localThread.length : 0;
  useEffect(() => {
    const container = threadRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [threadLength, pendingOp, researchMessages]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) setCurrentTime(video.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  async function selectStoryboard(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setStoryboard(null);
    setStoryboardFileName(null);
    setStoryboardError(null);
    setError(null);
    setNarrationMessages([]);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setStoryboardError("Choose a .json storyboard file.");
      return;
    }
    try {
      setStoryboard(JSON.parse(await file.text()) as unknown);
      setStoryboardFileName(file.name);
    } catch {
      setStoryboardError("The selected file is not valid JSON.");
    }
  }

  function selectMediaType(next: MediaType | null) {
    setMediaType(next);
    setIsMediaMenuOpen(false);
    setError(null);
    setNarrationMessages([]);
  }

  const attachmentReady = attachment?.status === "done";
  const attachmentBlocking = attachment !== null && attachment.status !== "done";
  const canSubmit = attachmentBlocking
    ? false
    : isAppendMode
    ? Boolean(project) && !isEditing && !isStoryboardProject && (Boolean(sourceProject) || attachmentReady || Boolean(prompt.trim()))
    : isAutoMode
    ? Boolean(project) && !isEditing && (Boolean(sourceProject) || attachmentReady || Boolean(prompt.trim()))
    : isContinueMode
    ? Boolean(project) && !isEditing && Boolean(prompt.trim())
    : attachmentReady
    ? !isGenerating && !isStartingResearch
    : !isGenerating && !isStartingResearch && (mediaType === "storyboard" ? Boolean(storyboard) : mediaType === "rawtree" ? true : mediaType === "stories" ? Boolean(prompt.trim()) && !stories.isBusy : Boolean(prompt.trim()));
  const latestClip = history.find((item) => item.kind === "clip");
  // Length of a freshly generated quick clip (edits/cuts change durationSeconds, so prefer the original length).
  const clipSeconds = latestClip ? latestClip.generatedSeconds ?? latestClip.durationSeconds : null;
  const clipCopy = clipSeconds ? `${clipSeconds}-second` : "short";

  function submitComposer(event: FormEvent<HTMLFormElement>) {
    if (isAppendMode) return appendShot(event);
    if (isAutoMode) return runAutoCommand(event);
    if (isContinueMode) return askFrame(event);
    if (attachment) return createFromUpload(event);
    return generateMedia(event);
  }

  /* ---- Video attachments ---- */

  function attachFile(file: File) {
    setError(null);
    setNotice(null);
    if (attachDisabledReason && !(isContinueMode && continueAction === "edit" && !isStoryboardProject)) {
      setError(attachDisabledReason);
      return;
    }
    if (!isVideoFile(file)) {
      setError(`“${file.name}” isn't a supported video. Attach an MP4, MOV, WebM, or M4V file.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`“${file.name}” is ${formatBytes(file.size)}. Videos can be at most 200 MB.`);
      return;
    }
    clearAttachment();
    setSourceProject(null);
    setIsHistoryPickerOpen(false);
    if (isContinueMode && continueAction === "edit") setContinueAction("append");
    else if (!isContinueMode) setMediaType(null);
    setIsMediaMenuOpen(false);

    startUpload(file);
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) attachFile(file);
  }

  function openFilePicker() {
    if (attachDisabledReason) {
      setError(attachDisabledReason);
      return;
    }
    fileInputRef.current?.click();
  }

  function hasFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function onComposerDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function onComposerDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachDisabledReason ? "none" : "copy";
  }

  function onComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function onComposerDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const file = Array.from(event.dataTransfer.files).find(isVideoFile) ?? event.dataTransfer.files[0];
    if (!file) return;
    if (isContinueMode && continueAction === "edit" && !isStoryboardProject) setContinueAction("append");
    attachFile(file);
  }

  function onComposerPaste(event: ClipboardEvent<HTMLDivElement>) {
    const file = Array.from(event.clipboardData.files).find(isVideoFile);
    if (!file) return;
    event.preventDefault();
    if (isContinueMode && continueAction === "edit" && !isStoryboardProject) setContinueAction("append");
    attachFile(file);
  }

  function selectContinueAction(next: ContinueAction) {
    if (next === "append" && isStoryboardProject) return;
    if (next === "edit" && attachment) clearAttachment();
    if (next === "edit") {
      setSourceProject(null);
      setIsHistoryPickerOpen(false);
    }
    setContinueAction(next);
    saveContinueMode(next);
    setError(null);
  }

  async function createFromUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const upload = attachment?.upload;
    if (!canSubmit || !upload) return;

    await runUpload({ uploadId: upload.id, filename: upload.filename, promptText: prompt.trim() });
  }

  async function runUpload(params: { uploadId: string; filename: string; promptText: string }, attach?: string) {
    const { promptText } = params;
    const controller = generationAbort.begin();
    setIsGenerating(true);
    setGeneratingKind("upload");
    setGeneratingPrompt(promptText || params.filename);
    setGenerationLive(null);
    setError(null);
    setNotice(null);
    setNarrationMessages([]);
    try {
      const { ok, status, result } = await runJob<{ project?: unknown; error?: unknown }>(
        "/api/projects/from-upload",
        promptText ? { uploadId: params.uploadId, prompt: promptText } : { uploadId: params.uploadId },
        (event, at) => setGenerationLive((current) => reduceLive(current ?? emptyLive(at), event, at)),
        controller.signal,
        { attach, meta: { kind: "upload", prompt: promptText || params.filename, op: params }, nonJsonError: (code) => `Could not import the video (HTTP ${code}).` },
      );
      if (!ok) {
        console.error(`[generate] /api/projects/from-upload failed with HTTP ${status}`, result);
        throw new Error(errorMessage(result, "Could not import the video."));
      }
      if (!isProject(result.project)) throw new Error("The server did not return a project for the uploaded video.");
      const item = historyItemFromProject(result.project, "upload", promptText || params.filename);
      updateHistory((items) => [item, ...items.filter((existing) => existing.projectId !== item.projectId)]);
      if (!attach) {
        setPrompt("");
        clearAttachment();
      }
      void openProject(item);
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setNotice("Import cancelled");
        return;
      }
      console.error("[generate] import from upload failed", caughtError);
      setError(caughtError instanceof Error ? caughtError.message : "Could not import the video.");
    } finally {
      generationAbort.release(controller);
      setIsGenerating(false);
    }
  }

  async function generateMedia(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    if (mediaType === "stories") {
      const storyPrompt = prompt.trim();
      setError(null);
      setPrompt("");
      await stories.start(storyPrompt, storyCount, storyLength);
      return;
    }

    const kind: HistoryKind = mediaType ?? "clip";
    const promptText = prompt.trim();
    const lengthSec = presetLength;
    // Company shorts, or a prompt that names a company ("make a video for Coca-Cola"), research the company (and its
    // competitors) first. On the first home prompt Liquid decides whether it names one; later prompts use the rules.
    const firstPrompt = !isEditorOpen && !homeResearch;
    if (firstPrompt && kind !== "company") setIsStartingResearch(true);
    const researchCompany = await researchCompanyFor(kind, promptText, firstPrompt).finally(() => setIsStartingResearch(false));
    if (researchCompany !== null && promptText) {
      await beginResearch(promptText, researchCompany, lengthSec);
      return;
    }
    await runGeneration(kind, promptText, lengthSec);
  }

  async function beginResearch(promptText: string, company: string, lengthSec: number) {
    setIsStartingResearch(true);
    setError(null);
    setNotice(null);
    setNarrationMessages([]);
    setIsMediaMenuOpen(false);
    try {
      const id = await startResearchSession(promptText);
      setActiveResearch({ id, prompt: promptText, company, durationSec: lengthSec, startedAt: nowIso() });
      setPrompt("");
    } catch (caughtError) {
      console.error("[research] could not start company research", caughtError);
      setError(caughtError instanceof Error ? caughtError.message : "Could not start researching the company.");
    } finally {
      setIsStartingResearch(false);
    }
  }

  /** "Create video now": the agent writes a storyline from the request + research (shown for review, not rendered yet). */
  function createVideoFromResearch(template?: string) {
    const session = research.session;
    if (!session || isGenerating) return;
    void research.requestStoryline(presetDuration(session.durationSec), template);
  }

  /** "Approve & create": saves the user's storyline edits, then renders it with its template (preset). */
  async function approveStoryline(edits: Record<string, unknown> | null) {
    const session = research.session;
    if (!session?.storyline || isGenerating) return;
    const storyline = edits ? await research.saveStorylineEdits(edits) : session.storyline;
    if (!storyline) return;
    await runGeneration(storyline.template === "company" ? "company" : "ad", session.prompt, storyline.duration_sec, session.id, undefined, storyline);
  }

  async function runGeneration(kind: HistoryKind, promptText: string, lengthSec: number, researchSessionId?: string, attach?: string, storyline?: Storyline) {
    const failureLabel = kind === "rawtree" ? "The competitor summary failed." : kind === "storyboard" ? "Storyboard rendering failed." : kind === "ad" ? "The ad could not be created." : kind === "company" ? "The company short could not be created." : "Video generation failed.";
    const controller = generationAbort.begin();
    setIsGenerating(true);
    setGeneratingKind(kind);
    setGeneratingPrompt(kind === "storyboard" ? storyboardFileName ?? "" : kind === "rawtree" ? "" : promptText);
    setGenerationLive(null);
    setError(null);
    setNotice(null);
    setNarrationMessages([]);
    try {
      const endpoint = kind === "rawtree" ? "/api/slop-video" : kind === "storyboard" ? "/api/render-storyboard" : kind === "ad" || kind === "company" ? "/api/generate-preset" : "/api/generate-video";
      const requestBody = kind === "rawtree" ? {}
        : kind === "storyboard" ? storyboard
        : kind === "ad" ? { preset: storyline?.template ?? "ad", prompt: promptText, durationSec: lengthSec, aspect: "16:9", ...(researchSessionId ? { researchSessionId } : {}), ...(storyline ? { storyline } : {}) }
        : kind === "company" ? { preset: "company", prompt: promptText, durationSec: lengthSec, ...(researchSessionId ? { researchSessionId } : {}), ...(storyline ? { storyline } : {}) }
        : { prompt: promptText };
      const { ok, status, result } = await runJob<RenderResult>(
        endpoint,
        requestBody,
        (event, at) => setGenerationLive((current) => reduceLive(current ?? emptyLive(at), event, at)),
        controller.signal,
        { attach, meta: { kind: "generation", prompt: promptText, op: { kind, promptText, lengthSec, ...(researchSessionId ? { researchSessionId } : {}) } } },
      );
      if (!ok) {
        console.error(`[generate] ${endpoint} failed with HTTP ${status}`, result);
        const messages = issueMessages(result.details);
        if (kind === "storyboard" && errorMessage(result, "") === "Narration requires review." && messages.length > 0) {
          setNarrationMessages(messages);
        }
        throw new Error(errorMessage(result, failureLabel));
      }
      if (typeof result.videoUrl !== "string") throw new Error("The generation did not return a video.");

      const durationSeconds = typeof result.durationSeconds === "number" ? result.durationSeconds : isProject(result.project) ? result.project.durationSeconds : 0;
      if ((kind === "storyboard" || kind === "ad" || kind === "company") && result.narrationAvailable === false) {
        setNarrationMessages(["Narration could not be generated on this system; the video was rendered without it."]);
      }
      if (!isProject(result.project)) {
        console.error("[generate] response did not include a project; it cannot be added to history", result);
        throw new Error("The video rendered, but the server did not return a project to save in history.");
      }
      const created = result.project;
      const item: HistoryItem = {
        projectId: created.id,
        title: created.title || (kind === "clip" || kind === "ad" || kind === "company" ? promptText || kindLabel(kind) : kindLabel(kind)),
        videoUrl: created.videoUrl || result.videoUrl,
        thumbUrl: created.frames[0]?.imageUrl ?? "",
        durationSeconds,
        createdAt: created.createdAt || new Date().toISOString(),
        kind,
        generatedSeconds: durationSeconds,
        ...(researchSessionId ? { researchSessionId } : {}),
      };
      updateHistory((items) => [item, ...items.filter((existing) => existing.projectId !== item.projectId)]);
      // The research now lives with the video (reopening it shows the session); leave the home screen's copy.
      if (researchSessionId && getActiveResearchId() === researchSessionId) setActiveResearch(null);
      if (kind === "ad" || kind === "company") {
        if (!researchSessionId && !attach) setPrompt("");
        void openProject(item);
      }
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setNotice("Generation cancelled");
        return;
      }
      console.error("[generate] generation failed", caughtError);
      setError(caughtError instanceof Error ? caughtError.message : failureLabel);
    } finally {
      generationAbort.release(controller);
      setIsGenerating(false);
    }
  }

  function resetPlayer() {
    setCurrentTime(0);
    setVideoDuration(0);
    setIsPlaying(false);
    setGrab(null);
    setRange(null);
    setEditedNote(null);
    seekOnLoadRef.current = null;
  }

  function setRange(next: TimeWindow | null) {
    rangeRef.current = next;
    setRangeState(next);
  }

  function showRangeLimit(message: string | null) {
    if (!message) return;
    setRangeLimit(message);
    if (rangeLimitTimerRef.current !== null) window.clearTimeout(rangeLimitTimerRef.current);
    rangeLimitTimerRef.current = window.setTimeout(() => setRangeLimit(null), 1400);
  }

  function applyRange(start: number, end: number, keep: "start" | "end" | "length") {
    if (!project) return null;
    const { range: next, limit } = clampRange(project.frames, start, end, keep);
    setRange(next);
    showRangeLimit(limit);
    return next;
  }

  async function openProject(item: HistoryItem) {
    const requestId = ++openRequestRef.current;
    openProjectIdRef.current = item.projectId;
    setOpenProjectId(item.projectId);
    setProject(null);
    setProjectError(null);
    resetPlayer();
    const rememberedMode = loadContinueMode();
    setContinueAction(attachment && rememberedMode === "edit" ? "append" : rememberedMode);
    setLocalThread(loadLocalThread(item.projectId));
    setPendingOp(null);
    retryRef.current = null;
    setSourceProject(null);
    setIsHistoryPickerOpen(false);
    disarmConfirm();
    setIsMediaMenuOpen(false);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(item.projectId)}`);
      const result = await readJson<{ project?: unknown; error?: unknown }>(response, `Could not load this project (HTTP ${response.status}).`);
      if (!response.ok) {
        console.error(`[editor] loading project ${item.projectId} failed with HTTP ${response.status}`, result);
        throw new Error(errorMessage(result, "Could not load this project."));
      }
      if (!isProject(result.project)) throw new Error("The server did not return a project.");
      if (requestId === openRequestRef.current) setProject(result.project);
    } catch (caughtError) {
      console.error("[editor] could not open project", caughtError);
      if (requestId === openRequestRef.current) setProjectError(caughtError instanceof Error ? caughtError.message : "Could not load this project.");
    }
  }

  function closeEditor() {
    setLocalThread([]);
    setPendingOp(null);
    retryRef.current = null;
    setSourceProject(null);
    setIsHistoryPickerOpen(false);
    disarmConfirm();
    openRequestRef.current += 1;
    openProjectIdRef.current = null;
    setOpenProjectId(null);
    setProject(null);
    setProjectError(null);
    resetPlayer();
  }

  /* ---- Player ---- */

  function grabCurrentFrame(options: { confirm?: boolean; focusComposer?: boolean } = {}) {
    const video = videoRef.current;
    if (!video || !project) return;
    const atSec = video.currentTime;
    const key = ++grabKeyRef.current;
    const frameImage = project.frames.find((frame) => frame.index === frameIndexAt(project.frames, atSec))?.imageUrl ?? null;
    const setThumb = (thumbUrl: string) => setGrab((current) => current && current.key === key ? { ...current, thumbUrl, captured: true } : current);

    // The grab itself never waits for the thumbnail; the frame image is the fallback.
    setGrab({ key, atSec, thumbUrl: frameImage, captured: false });
    if (!rangeRef.current) setRange(defaultRange(project.frames, atSec));
    const immediate = captureVideoThumb(video);
    if (immediate) {
      setThumb(immediate);
    } else {
      let done = false;
      const retry = () => {
        if (done) return;
        done = true;
        const later = captureVideoThumb(video);
        if (later) setThumb(later);
      };
      const withFrameCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
      withFrameCallback.requestVideoFrameCallback?.(() => retry());
      video.addEventListener("seeked", retry, { once: true });
      video.currentTime = atSec;
    }
    if (options.confirm) {
      setGrabConfirmed(key);
      window.setTimeout(() => setGrabConfirmed((current) => current === key ? null : current), 1500);
    }
    if (options.focusComposer) promptInputRef.current?.focus({ preventScroll: true });
  }

  function pauseQuietly() {
    const video = videoRef.current;
    if (!video || video.paused) return;
    ignorePauseRef.current = true;
    video.pause();
  }

  function seekTo(seconds: number, grabAfterSeek: boolean) {
    const video = videoRef.current;
    const clamped = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.001));
    setCurrentTime(clamped);
    if (!video) return;
    grabOnSeekRef.current = grabAfterSeek;
    video.currentTime = clamped;
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch((caughtError: unknown) => console.error("[editor] video playback failed", caughtError));
    } else {
      video.pause();
    }
  }

  function secondsFromPointer(clientX: number) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return ((clientX - rect.left) / rect.width) * timelineTotal;
  }

  function onTimelinePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!duration || !project) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-range-drag]")?.dataset.rangeDrag;
    event.currentTarget.setPointerCapture(event.pointerId);
    pauseQuietly();
    const at = secondsFromPointer(event.clientX);
    const editable = isContinueMode && !isAppendMode;
    if (editable && (handle === "start" || handle === "end" || handle === "move") && editWindow) {
      rangeDragRef.current = { mode: handle, startX: event.clientX, anchorSec: at, original: editWindow, moved: false, pointerId: event.pointerId };
      return;
    }
    rangeDragRef.current = { mode: "new", startX: event.clientX, anchorSec: at, original: null, moved: false, pointerId: event.pointerId };
    isScrubbingRef.current = true;
    seekTo(at, false);
  }

  function onTimelinePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = rangeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const at = secondsFromPointer(event.clientX);
    if (!drag.moved && Math.abs(event.clientX - drag.startX) > 4) drag.moved = true;
    if (drag.mode === "new") {
      if (drag.moved && isContinueMode && !isAppendMode) {
        isScrubbingRef.current = false;
        applyRange(drag.anchorSec, at, at >= drag.anchorSec ? "start" : "end");
      } else if (!drag.moved) {
        seekTo(at, false);
      }
      return;
    }
    const original = drag.original;
    if (!original || !drag.moved) return;
    if (drag.mode === "start") applyRange(Math.min(at, original.endSec - RANGE_MIN_SEC / 2), original.endSec, "end");
    else if (drag.mode === "end") applyRange(original.startSec, Math.max(at, original.startSec + RANGE_MIN_SEC / 2), "start");
    else {
      const delta = at - drag.anchorSec;
      applyRange(original.startSec + delta, original.endSec + delta, "length");
    }
  }

  function onTimelinePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = rangeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    rangeDragRef.current = null;
    isScrubbingRef.current = false;
    if (drag.mode === "new" && !drag.moved) {
      // A simple click grabs a new moment (with a fresh default range around it).
      if (isContinueMode && !isAppendMode) setRange(null);
      seekTo(secondsFromPointer(event.clientX), true);
      return;
    }
    // A drawn or adjusted range: park the playhead on its start and grab that frame for the preview.
    const current = rangeRef.current;
    if (current) seekTo(current.startSec, true);
  }

  function onTimelinePointerCancel() {
    rangeDragRef.current = null;
    isScrubbingRef.current = false;
  }

  function onPlayerKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === "End" && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      goToEnd();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && event.target === timelineRef.current && range && !isAppendMode) {
      event.preventDefault();
      requestCutRange();
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && (event.shiftKey || event.altKey) && project && editWindow) {
      event.preventDefault();
      pauseQuietly();
      const step = (event.key === "ArrowRight" ? 1 : -1) * FRAME_STEP;
      if (event.shiftKey) applyRange(editWindow.startSec, editWindow.endSec + step, "start");
      else applyRange(editWindow.startSec + step, editWindow.endSec, "end");
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      pauseQuietly();
      const video = videoRef.current;
      const base = video ? video.currentTime : currentTime;
      seekTo(base + (event.key === "ArrowRight" ? 1 : -1) / 30, true);
    } else if (event.key === " " && event.target === event.currentTarget) {
      event.preventDefault();
      togglePlay();
    }
  }

  /* ---- Continue editing: every message becomes a chat thread entry ---- */

  function nextThreadId(prefix: string) {
    threadIdRef.current += 1;
    return `${prefix}-${threadIdRef.current}`;
  }

  function addLocalThread(projectId: string, entries: ThreadEntry[]) {
    const next = [...loadLocalThread(projectId), ...entries];
    saveLocalThread(projectId, next);
    if (openProjectIdRef.current === projectId) setLocalThread(next);
  }

  function startThreadOp(user: ThreadEntry, detail: string, retry: () => void, target?: PendingOp["target"]) {
    retryRef.current = retry;
    setPendingOp({ user, detail, error: null, target });
  }

  /** Folds a streamed progress event into the pending bubble (ignored once it has failed or been replaced). */
  function applyLiveEvent(userId: string, event: StreamEvent, at = Date.now()) {
    setPendingOp((current) => current && current.user.id === userId && !current.error ? { ...current, live: reduceLive(current.live ?? emptyLive(at), event, at) } : current);
  }

  function failThreadOp(message: string) {
    setPendingOp((current) => current ? { ...current, error: message, live: undefined } : current);
  }

  function retryThreadOp() {
    const retry = retryRef.current;
    if (!retry || isEditing) return;
    retry();
  }

  function askFrame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = prompt.trim();
    if (!project || !message || isEditing) return;
    const requestedWindow = range ?? defaultRange(project.frames, grab?.atSec ?? videoRef.current?.currentTime ?? currentTime);
    const momentSec = grab?.atSec ?? (range ? (range.startSec + range.endSec) / 2 : videoRef.current?.currentTime ?? currentTime);
    const frameIndex = frameIndexAt(project.frames, requestedWindow.startSec);
    setPrompt("");
    void runAsk({
      projectId: project.id,
      frameIndex,
      message,
      atSec: Math.round(momentSec * 1000) / 1000,
      window: requestedWindow,
      thumbUrl: grab?.thumbUrl ?? project.frames.find((frame) => frame.index === frameIndex)?.imageUrl,
    });
  }

  async function runAsk(params: { projectId: string; frameIndex: number; message: string; atSec: number; window: TimeWindow; thumbUrl?: string | null }, attach?: string) {
    const { projectId, frameIndex, message, atSec, window: requestedWindow } = params;
    pauseQuietly();
    const controller = editAbort.begin();
    const detail = `Regenerating ${formatWindow(requestedWindow)}…`;
    const pendingUser: ThreadEntry = { id: nextThreadId("pending"), role: "user", text: message, at: nowIso(), context: `${formatWindow(requestedWindow)} · shot ${frameIndex + 1}`, thumbUrl: params.thumbUrl ?? undefined };
    startThreadOp(pendingUser, detail, () => void runAsk(params), { window: requestedWindow });
    setEditingAt(atSec);
    setRange(requestedWindow);
    setBusy({ label: "Updating your video", detail });
    setError(null);
    setNotice(null);
    setEditedNote(null);
    try {
      const { ok, status, result } = await runJob<AskResult>(
        `/api/projects/${encodeURIComponent(projectId)}/frames/${frameIndex}/ask`,
        { message, atSec, rangeStartSec: Math.round(requestedWindow.startSec * 1000) / 1000, rangeEndSec: Math.round(requestedWindow.endSec * 1000) / 1000 },
        (event, at) => applyLiveEvent(pendingUser.id, event, at),
        controller.signal,
        { attach, meta: { kind: "ask", projectId, prompt: message, op: params }, nonJsonError: (code) => `Frame assistant unavailable (HTTP ${code}). The server endpoint isn't ready yet.` },
      );
      if (!ok) {
        console.error(`[editor] frame ask failed with HTTP ${status}`, result);
        throw new Error(errorMessage(result, `The frame assistant could not answer (HTTP ${status}).`));
      }
      if (!isProject(result.project)) throw new Error("The server did not return the updated project.");
      const updated = result.project;
      const edited = result.edited === true;
      if (edited) {
        updateHistory((items) => items.map((item) => item.projectId === projectId ? {
          ...item,
          title: updated.title || item.title,
          videoUrl: updated.videoUrl || item.videoUrl,
          thumbUrl: updated.frames[0]?.imageUrl ?? item.thumbUrl,
          durationSeconds: updated.durationSeconds || item.durationSeconds,
        } : item));
      }
      if (openProjectIdRef.current !== projectId) return;
      // The server saved both messages in project.chats; the thread renders from there.
      setProject(updated);
      setPendingOp(null);
      retryRef.current = null;
      const editedWindow = isTimeWindow(result.window) ? result.window : requestedWindow;
      if (edited) {
        setEditedNote("Frame updated · video re-rendered");
        setIsPlaying(false);
        setVideoDuration(0);
        seekOnLoadRef.current = editedWindow.startSec;
        setCurrentTime(editedWindow.startSec);
        setVideoReload((current) => current + 1);
        setFlashWindow(editedWindow);
        setRange(editedWindow);
        window.setTimeout(() => setFlashWindow((current) => current === editedWindow ? null : current), 1800);
      }
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setPendingOp(null);
        setNotice("Edit cancelled");
        return;
      }
      console.error("[editor] frame ask failed", caughtError);
      if (openProjectIdRef.current !== projectId) return;
      failThreadOp(caughtError instanceof Error ? caughtError.message : "The frame assistant could not answer.");
    } finally {
      editAbort.release(controller);
      setEditingAt(null);
      setBusy(null);
    }
  }

  function appendShot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !canSubmit) return;
    const promptText = prompt.trim();
    const upload = attachment?.status === "done" ? attachment.upload : undefined;
    const source = sourceProject;
    if (!promptText && !upload && !source) return;
    setPrompt("");
    clearAttachment();
    setSourceProject(null);
    setIsHistoryPickerOpen(false);
    void runAppend({
      projectId: project.id,
      prompt: source ? undefined : promptText || undefined,
      uploadId: source ? undefined : upload?.id,
      uploadName: upload?.filename,
      uploadThumb: upload?.thumbUrl,
      source: source ? { projectId: source.projectId, title: source.title, thumbUrl: source.thumbUrl } : undefined,
    });
  }

  async function runAppend(params: { projectId: string; prompt?: string; uploadId?: string; uploadName?: string; uploadThumb?: string; source?: { projectId: string; title: string; thumbUrl: string } }, attach?: string) {
    const { projectId, source } = params;
    pauseQuietly();
    const controller = editAbort.begin();
    const detail = source ? `Adding “${source.title}”…` : params.uploadId ? "Adding your clip…" : "Generating the next shot…";
    const userEntry: ThreadEntry = {
      id: nextThreadId("user"),
      role: "user",
      text: source ? `Append “${source.title}”` : params.prompt ?? `Append ${params.uploadName ?? "my clip"}`,
      at: nowIso(),
      context: source ? "Append shot · from history" : params.uploadId ? `Append shot · ${params.uploadName ?? "uploaded clip"}` : "Append shot",
      thumbUrl: source?.thumbUrl || params.uploadThumb,
    };
    startThreadOp(userEntry, detail, () => void runAppend(params), { append: true });
    setEditingAt(project?.durationSeconds ?? 0);
    setBusy({ label: "Appending to your video", detail });
    setError(null);
    setNotice(null);
    setEditedNote(null);
    try {
      const body: { uploadId?: string; prompt?: string; sourceProjectId?: string } = {};
      if (source) body.sourceProjectId = source.projectId;
      else {
        if (params.uploadId) body.uploadId = params.uploadId;
        if (params.prompt) body.prompt = params.prompt;
      }
      const { ok, status, result } = await runJob<AppendResult>(`/api/projects/${encodeURIComponent(projectId)}/append`, body, (event, at) => applyLiveEvent(userEntry.id, event, at), controller.signal, {
        attach,
        meta: { kind: "append", projectId, prompt: userEntry.text, op: params },
        nonJsonError: (code) => `Append unavailable (HTTP ${code}). The server endpoint isn't ready yet.`,
      });
      if (!ok) {
        console.error(`[editor] append failed with HTTP ${status}`, result);
        throw new Error(errorMessage(result, status === 422 ? "Append isn't supported for this project." : `Could not append the shot (HTTP ${status}).`));
      }
      if (!isProject(result.project)) throw new Error("The server did not return the updated project.");
      const updated = result.project;
      updateHistory((items) => items.map((item) => item.projectId === projectId ? {
        ...item,
        title: updated.title || item.title,
        videoUrl: updated.videoUrl || item.videoUrl,
        thumbUrl: updated.frames[0]?.imageUrl ?? item.thumbUrl,
        durationSeconds: updated.durationSeconds || item.durationSeconds,
      } : item));
      const appendedIndex = typeof result.appendedFrameIndex === "number" ? result.appendedFrameIndex : updated.frames.length - 1;
      const appended = updated.frames.find((frame) => frame.index === appendedIndex) ?? updated.frames[updated.frames.length - 1];
      const startSec = appended?.startSec ?? 0;
      const enhancedPrompt = typeof result.enhancedPrompt === "string" && result.enhancedPrompt.trim() ? result.enhancedPrompt.trim() : undefined;
      addLocalThread(projectId, [
        { ...userEntry, id: nextThreadId("local") },
        {
          id: nextThreadId("local"),
          role: "assistant",
          text: source ? `“${source.title}” was added to the end of the video.` : appended?.source === "upload" ? "Your clip was added to the end of the video." : "I generated the next shot and added it to the end.",
          at: nowIso(),
          edited: true,
          note: `Shot ${(appended?.index ?? appendedIndex) + 1} appended at ${startSec.toFixed(1)}s · video re-rendered`,
          afterUrl: appended?.imageUrl,
          enhancedPrompt,
          ragSources: ragLabels(result.ragSources),
          memorySources: memoryChips(result.memorySources),
        },
      ]);
      if (openProjectIdRef.current !== projectId) return;
      setPendingOp(null);
      retryRef.current = null;
      setProject(updated);
      setEditedNote("Shot appended · video re-rendered");
      setGrab({ key: ++grabKeyRef.current, atSec: startSec, thumbUrl: appended?.imageUrl ?? null, captured: false });
      flashRange({ startSec, endSec: updated.durationSeconds });
      setIsPlaying(false);
      setVideoDuration(0);
      seekOnLoadRef.current = startSec;
      setCurrentTime(startSec);
      setVideoReload((current) => current + 1);
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setPendingOp(null);
        setNotice("Append cancelled");
        return;
      }
      console.error("[editor] append failed", caughtError);
      if (openProjectIdRef.current !== projectId) return;
      failThreadOp(caughtError instanceof Error ? caughtError.message : "Could not append the shot.");
    } finally {
      editAbort.release(controller);
      setEditingAt(null);
      setBusy(null);
    }
  }

  function armConfirm(kind: "cut" | number) {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    if (kind === "cut") {
      setConfirmCut(true);
      setConfirmRemoveFrame(null);
    } else {
      setConfirmRemoveFrame(kind);
      setConfirmCut(false);
    }
    confirmTimerRef.current = window.setTimeout(() => {
      setConfirmCut(false);
      setConfirmRemoveFrame(null);
    }, 3000);
  }

  function disarmConfirm() {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    setConfirmCut(false);
    setConfirmRemoveFrame(null);
  }

  type MutateOptions = { projectId: string; url: string; method: "POST" | "DELETE"; body?: unknown; busy: BusyState; note: string; seekSec: number; failure: string; cancelled: string; userText: string; context: string; thumbUrl?: string; window?: TimeWindow };

  /** Runs a structural edit (cut a range / remove a shot) that returns the updated project. */
  async function mutateProject(options: MutateOptions, attach?: string) {
    const { projectId } = options;
    pauseQuietly();
    disarmConfirm();
    const controller = editAbort.begin();
    const userEntry: ThreadEntry = { id: nextThreadId("user"), role: "user", text: options.userText, at: nowIso(), context: options.context, thumbUrl: options.thumbUrl };
    startThreadOp(userEntry, options.busy.detail, () => void mutateProject(options), { window: options.window ?? null });
    setEditingAt(options.seekSec);
    setBusy(options.busy);
    setError(null);
    setNotice(null);
    setEditedNote(null);
    try {
      const { ok, status, result } = await runJob<{ project?: unknown; removed?: unknown; error?: unknown }>(options.url, options.body, (event, at) => applyLiveEvent(userEntry.id, event, at), controller.signal, {
        attach,
        method: options.method,
        meta: { kind: "mutate", projectId, prompt: options.userText, op: options },
        nonJsonError: (code) => `${options.failure} (HTTP ${code}). The server endpoint isn't ready yet.`,
      });
      if (!ok) {
        console.error(`[editor] ${options.method} ${options.url} failed with HTTP ${status}`, result);
        throw new Error(errorMessage(result, `${options.failure} (HTTP ${status}).`));
      }
      if (!isProject(result.project)) throw new Error("The server did not return the updated project.");
      const updated = result.project;
      updateHistory((items) => items.map((item) => item.projectId === projectId ? {
        ...item,
        videoUrl: updated.videoUrl || item.videoUrl,
        thumbUrl: updated.frames[0]?.imageUrl ?? item.thumbUrl,
        durationSeconds: updated.durationSeconds,
      } : item));
      const removedSec = typeof result.removed === "number" ? result.removed : null;
      addLocalThread(projectId, [
        { ...userEntry, id: nextThreadId("local") },
        { id: nextThreadId("local"), role: "assistant", text: `Done — the video is now ${updated.durationSeconds.toFixed(1)}s long${removedSec !== null ? ` (${removedSec.toFixed(1)}s removed)` : ""}.`, at: nowIso(), edited: true, note: options.note },
      ]);
      if (openProjectIdRef.current !== projectId) return;
      setPendingOp(null);
      retryRef.current = null;
      const seekSec = Math.min(options.seekSec, Math.max(0, updated.durationSeconds - 0.05));
      setProject(updated);
      setRange(null);
      setGrab(null);
      setEditedNote(options.note);
      setIsPlaying(false);
      setVideoDuration(0);
      seekOnLoadRef.current = seekSec;
      setCurrentTime(seekSec);
      setVideoReload((current) => current + 1);
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setPendingOp(null);
        setNotice(options.cancelled);
        return;
      }
      console.error("[editor] structural edit failed", caughtError);
      if (openProjectIdRef.current !== projectId) return;
      failThreadOp(caughtError instanceof Error ? caughtError.message : options.failure);
    } finally {
      editAbort.release(controller);
      setEditingAt(null);
      setBusy(null);
    }
  }

  function requestCutRange() {
    if (!project || !range || isStoryboardProject || isEditing) return;
    if (!confirmCut) {
      armConfirm("cut");
      return;
    }
    const cut = range;
    const length = (cut.endSec - cut.startSec).toFixed(1);
    void mutateProject({
      projectId: project.id,
      url: `/api/projects/${encodeURIComponent(project.id)}/cut`,
      method: "POST",
      body: { rangeStartSec: Math.round(cut.startSec * 1000) / 1000, rangeEndSec: Math.round(cut.endSec * 1000) / 1000 },
      busy: { label: "Removing part of your video", detail: `Removing ${formatWindow(cut)}…` },
      note: `Removed ${formatWindow(cut)} · video re-rendered`,
      seekSec: cut.startSec,
      failure: "Could not remove that range",
      cancelled: "Remove cancelled",
      userText: `Remove ${formatWindow(cut)}`,
      window: cut,
      context: `Removed ${length}s`,
      thumbUrl: grab?.thumbUrl ?? undefined,
    });
  }

  function requestRemoveFrame(frame: ProjectFrame) {
    if (!project || project.frames.length < 2 || isStoryboardProject || isEditing) return;
    if (confirmRemoveFrame !== frame.index) {
      armConfirm(frame.index);
      return;
    }
    const span = formatWindow({ startSec: frame.startSec, endSec: frame.startSec + frame.durationSec });
    void mutateProject({
      projectId: project.id,
      url: `/api/projects/${encodeURIComponent(project.id)}/frames/${frame.index}`,
      method: "DELETE",
      busy: { label: "Removing a shot", detail: `Removing shot ${frame.index + 1} (${span})…` },
      note: `Shot ${frame.index + 1} removed · video re-rendered`,
      seekSec: frame.startSec,
      failure: "Could not remove that shot",
      cancelled: "Remove cancelled",
      userText: `Remove shot ${frame.index + 1}`,
      window: { startSec: frame.startSec, endSec: frame.startSec + frame.durationSec },
      context: `Removed ${frame.durationSec.toFixed(1)}s · ${span}`,
      thumbUrl: frame.imageUrl,
    });
  }

  /* ---- Auto mode: the server decides what the prompt means ---- */

  function goToEnd() {
    const video = videoRef.current;
    if (!video || !duration) return;
    pauseQuietly();
    setRange(null);
    setGrab(null);
    seekTo(duration, false);
  }

  function runAutoCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !canSubmit) return;
    const message = prompt.trim();
    const upload = attachment?.status === "done" ? attachment.upload : undefined;
    const source = sourceProject;
    if (!message && !upload && !source) return;
    const atEnd = isAtEnd;
    const endSec = duration || project.durationSeconds;
    const requestedWindow = atEnd || upload || source ? null : range ?? defaultRange(project.frames, grab?.atSec ?? videoRef.current?.currentTime ?? currentTime);
    const momentSec = atEnd ? endSec : grab?.atSec ?? (range ? (range.startSec + range.endSec) / 2 : videoRef.current?.currentTime ?? currentTime);
    const frameIndex = frameIndexAt(project.frames, requestedWindow?.startSec ?? momentSec);
    setPrompt("");
    clearAttachment();
    setSourceProject(null);
    setIsHistoryPickerOpen(false);
    void runCommand({
      projectId: project.id,
      message,
      atSec: Math.round(momentSec * 1000) / 1000,
      atEnd,
      window: requestedWindow,
      frameIndex,
      thumbUrl: source?.thumbUrl || upload?.thumbUrl || (atEnd ? undefined : grab?.thumbUrl ?? project.frames.find((frame) => frame.index === frameIndex)?.imageUrl),
      previousDuration: project.durationSeconds,
      uploadId: upload?.id,
      uploadName: upload?.filename,
      source: source ? { projectId: source.projectId, title: source.title } : undefined,
    });
  }

  async function runCommand(params: { projectId: string; message: string; atSec: number; atEnd: boolean; window: TimeWindow | null; frameIndex: number; thumbUrl?: string | null; previousDuration: number; uploadId?: string; uploadName?: string; source?: { projectId: string; title: string } }, attach?: string) {
    const { projectId, message, window: requestedWindow, source } = params;
    pauseQuietly();
    const controller = editAbort.begin();
    const detail = "Working out what to do…";
    const context = source ? "Auto · from history" : params.uploadId ? `Auto · ${params.uploadName ?? "attached clip"}` : params.atEnd ? "Auto · at the end" : requestedWindow ? `Auto · ${formatWindow(requestedWindow)} · shot ${params.frameIndex + 1}` : "Auto";
    const userEntry: ThreadEntry = {
      id: nextThreadId("user"),
      role: "user",
      text: message || (source ? `Append “${source.title}”` : `Append ${params.uploadName ?? "my clip"}`),
      at: nowIso(),
      context,
      thumbUrl: params.thumbUrl ?? undefined,
    };
    startThreadOp(userEntry, detail, () => void runCommand(params), requestedWindow ? { window: requestedWindow } : { append: params.atEnd || Boolean(params.uploadId || source) });
    setEditingAt(params.atSec);
    if (requestedWindow) setRange(requestedWindow);
    setBusy({ label: "Working on your video", detail });
    setError(null);
    setNotice(null);
    setEditedNote(null);
    try {
      const body: Record<string, unknown> = { message };
      body.atSec = params.atSec;
      if (requestedWindow) {
        body.rangeStartSec = Math.round(requestedWindow.startSec * 1000) / 1000;
        body.rangeEndSec = Math.round(requestedWindow.endSec * 1000) / 1000;
      }
      if (params.uploadId) body.uploadId = params.uploadId;
      if (source) body.sourceProjectId = source.projectId;
      const { ok, status, result } = await runJob<CommandResult>(`/api/projects/${encodeURIComponent(projectId)}/command`, body, (event, at) => applyLiveEvent(userEntry.id, event, at), controller.signal, {
        attach,
        meta: { kind: "command", projectId, prompt: userEntry.text, op: params },
        nonJsonError: (code) => `Auto mode unavailable (HTTP ${code}). The server endpoint isn't ready yet.`,
      });
      if (!ok) {
        console.error(`[editor] command failed with HTTP ${status}`, result);
        throw new Error(errorMessage(result, `Could not work out what to do (HTTP ${status}).`));
      }
      if (!isProject(result.project)) throw new Error("The server did not return the updated project.");
      const updated = result.project;
      const action = typeof result.action === "string" ? result.action : "answer";
      if (action === "new_video") {
        // Nothing changed: offer to start the new video instead (see ChatThread's suggestion buttons).
        const raw = (result.suggestion ?? {}) as { preset?: unknown; prompt?: unknown };
        const suggestion: NewVideoSuggestion = {
          preset: raw.preset === "company" || raw.preset === "ad" ? raw.preset : "clip",
          prompt: typeof raw.prompt === "string" && raw.prompt.trim() ? raw.prompt.trim() : message,
        };
        const reply = typeof result.reply === "string" && result.reply.trim() ? result.reply.trim() : "This sounds like a new video rather than a change to this one.";
        addLocalThread(projectId, [
          { ...userEntry, id: nextThreadId("local") },
          { id: nextThreadId("local"), role: "assistant", text: reply, at: nowIso(), action: { label: "✦ New video", detectedBy: result.detectedBy === "rules" ? "rules" : "llm" }, suggestion },
        ]);
        if (openProjectIdRef.current !== projectId) return;
        setPendingOp(null);
        retryRef.current = null;
        return;
      }
      const changed = action !== "answer";
      if (changed) {
        updateHistory((items) => items.map((item) => item.projectId === projectId ? {
          ...item,
          title: updated.title || item.title,
          videoUrl: updated.videoUrl || item.videoUrl,
          thumbUrl: updated.frames[0]?.imageUrl ?? item.thumbUrl,
          durationSeconds: updated.durationSeconds || item.durationSeconds,
        } : item));
      }
      const resultWindow = isTimeWindow(result.window) ? result.window : requestedWindow;
      const appendedIndexes = Array.isArray(result.appendedFrameIndexes) ? result.appendedFrameIndexes.filter((value): value is number => typeof value === "number") : [];
      const appendedFrames = appendedIndexes.map((index) => updated.frames.find((frame) => frame.index === index)).filter((frame): frame is ProjectFrame => Boolean(frame));
      const firstAppended = appendedFrames[0] ?? (action === "append_shot" || action === "append_attachment" ? updated.frames[updated.frames.length - 1] : undefined);
      const removed = typeof result.removed === "number" ? result.removed : Math.max(0, params.previousDuration - updated.durationSeconds);
      const added = Math.max(0, updated.durationSeconds - params.previousDuration);
      const shotCount = Math.max(1, appendedFrames.length);
      const pill = action === "edit_range" ? `✎ Edited ${resultWindow ? formatWindow(resultWindow) : `${params.atSec.toFixed(1)}s`}`
        : action === "append_shot" ? `＋ Extended +${added.toFixed(added % 1 === 0 ? 0 : 1)}s (${shotCount} new shot${shotCount === 1 ? "" : "s"})`
        : action === "cut_range" ? `✂ Removed ${removed.toFixed(1)}s`
        : action === "append_attachment" ? "＋ Appended clip"
        : "💬 Answer";
      const editedFrame = action === "edit_range" && resultWindow ? updated.frames.find((frame) => frame.index === frameIndexAt(updated.frames, resultWindow.startSec)) : undefined;
      const reply = typeof result.reply === "string" && result.reply.trim() ? result.reply.trim() : typeof result.summary === "string" ? result.summary.trim() : "";
      addLocalThread(projectId, [
        { ...userEntry, id: nextThreadId("local") },
        {
          id: nextThreadId("local"),
          role: "assistant",
          text: reply,
          at: nowIso(),
          edited: changed,
          action: { label: pill, detectedBy: result.detectedBy === "rules" ? "rules" : "llm" },
          note: action === "edit_range" ? "Frame updated · video re-rendered" : action === "cut_range" ? `Removed ${removed.toFixed(1)}s · video re-rendered` : action === "append_shot" || action === "append_attachment" ? "Video re-rendered" : undefined,
          beforeUrl: action === "edit_range" ? (typeof result.grabbedFrameUrl === "string" ? result.grabbedFrameUrl : params.thumbUrl ?? undefined) : undefined,
          afterUrl: action === "edit_range" ? editedFrame?.imageUrl : firstAppended?.imageUrl,
          enhancedPrompt: typeof result.enhancedPrompt === "string" && result.enhancedPrompt.trim() ? result.enhancedPrompt.trim() : undefined,
          ragSources: ragLabels(result.ragSources),
          memorySources: memoryChips(result.memorySources),
        },
      ]);
      if (openProjectIdRef.current !== projectId) return;
      setPendingOp(null);
      retryRef.current = null;
      setProject(updated);
      if (!changed) return;
      setIsPlaying(false);
      setVideoDuration(0);
      setVideoReload((current) => current + 1);
      if (action === "edit_range" && resultWindow) {
        setEditedNote("Frame updated · video re-rendered");
        seekOnLoadRef.current = resultWindow.startSec;
        setCurrentTime(resultWindow.startSec);
        setFlashWindow(resultWindow);
        setRange(resultWindow);
        window.setTimeout(() => setFlashWindow((current) => current === resultWindow ? null : current), 1800);
      } else if (action === "cut_range") {
        const seekSec = Math.min(resultWindow?.startSec ?? params.atSec, Math.max(0, updated.durationSeconds - 0.05));
        setEditedNote(`Removed ${removed.toFixed(1)}s · video re-rendered`);
        setRange(null);
        setGrab(null);
        seekOnLoadRef.current = seekSec;
        setCurrentTime(seekSec);
      } else {
        const startSec = firstAppended?.startSec ?? params.previousDuration;
        setEditedNote(action === "append_shot" ? `Extended +${added.toFixed(1)}s · video re-rendered` : "Clip appended · video re-rendered");
        setRange(null);
        setGrab({ key: ++grabKeyRef.current, atSec: startSec, thumbUrl: firstAppended?.imageUrl ?? null, captured: false });
        flashRange({ startSec, endSec: updated.durationSeconds });
        seekOnLoadRef.current = startSec;
        setCurrentTime(startSec);
      }
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setPendingOp(null);
        setNotice("Cancelled");
        return;
      }
      console.error("[editor] command failed", caughtError);
      if (openProjectIdRef.current !== projectId) return;
      failThreadOp(caughtError instanceof Error ? caughtError.message : "Could not work out what to do.");
    } finally {
      editAbort.release(controller);
      setEditingAt(null);
      setBusy(null);
    }
  }

  function flashRange(window: TimeWindow) {
    setFlashWindow(window);
    globalThis.setTimeout(() => setFlashWindow((current) => current === window ? null : current), 1800);
  }

  /** "Start new" on a new-video suggestion: leave the editor and submit the prompt as a new video of that kind. */
  function startSuggestedVideo(suggestion: NewVideoSuggestion) {
    if (isGenerating || isStartingResearch) return;
    closeEditor();
    setError(null);
    setNotice(null);
    if (suggestion.preset === "company") {
      void researchCompanyFor("company", suggestion.prompt, false)
        .catch(() => "")
        .then((company) => beginResearch(suggestion.prompt, company ?? "", presetLength));
      return;
    }
    setMediaType(suggestion.preset === "ad" ? "ad" : null);
    void runGeneration(suggestion.preset === "ad" ? "ad" : "clip", suggestion.prompt, presetLength);
  }

  /* ---- Background jobs: re-attach after a reload, resume after a server restart ---- */

  /** Rebuilds the UI of a stored job by re-running its action in "attach" mode (replayed events restore progress). */
  async function restoreJob(entry: StoredJob) {
    const op = (entry.op ?? {}) as Record<string, unknown>;
    const openFor = (projectId: string | undefined) => {
      if (!projectId) return false;
      // readHistory(): on the first render useHistory() still returns the (empty) hydration snapshot.
      const item = readHistory().find((candidate) => candidate.projectId === projectId)
        ?? { projectId, title: "project", videoUrl: "", thumbUrl: "", durationSeconds: 0, createdAt: nowIso(), kind: "clip" as const };
      if (openProjectIdRef.current !== projectId) void openProject(item);
      return true;
    };
    switch (entry.kind) {
      case "generation": {
        const kind = (typeof op.kind === "string" ? op.kind : "clip") as HistoryKind;
        return runGeneration(kind, typeof op.promptText === "string" ? op.promptText : entry.prompt, typeof op.lengthSec === "number" ? op.lengthSec : presetLength, typeof op.researchSessionId === "string" ? op.researchSessionId : undefined, entry.jobId);
      }
      case "upload":
        return runUpload(op as Parameters<typeof runUpload>[0], entry.jobId);
      case "ask":
      case "append":
      case "mutate":
      case "command": {
        // The edit shows on its project: open it and put the pending bubble (and the player's loading frame) back.
        if (!openFor(entry.projectId)) {
          removeStoredJob(entry.jobId);
          return;
        }
        if (entry.kind === "ask") return runAsk(op as Parameters<typeof runAsk>[0], entry.jobId);
        if (entry.kind === "append") return runAppend(op as Parameters<typeof runAppend>[0], entry.jobId);
        if (entry.kind === "mutate") return mutateProject(op as MutateOptions, entry.jobId);
        return runCommand(op as Parameters<typeof runCommand>[0], entry.jobId);
      }
      case "stories-render": {
        // The story picker can't be rebuilt, but the rendered videos still land in history.
        const { ok, result } = await runJob<{ projects?: unknown }>("", undefined, () => undefined, undefined, { attach: entry.jobId, meta: entry });
        if (ok && Array.isArray(result.projects)) addStoryProjects(result.projects.filter(isProject));
        return;
      }
      default:
        removeStoredJob(entry.jobId);
    }
  }

  useEffect(() => {
    const sync = () => setInterruptedJobs(loadStoredJobs().filter((entry) => entry.interrupted));
    sync();
    return subscribeStoredJobs(sync);
  }, []);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      // Jobs this browser started (localStorage) plus any active server job for this user it doesn't know about.
      const stored = loadStoredJobs();
      const active = await fetchActiveJobs().catch(() => []);
      for (const job of active) {
        if (stored.some((entry) => entry.jobId === job.id)) continue;
        const kind: HistoryKind | null = job.kind === "clip" ? "clip" : job.kind === "preset" ? "ad" : job.kind === "storyboard" ? "storyboard" : job.kind === "rawtree" ? "rawtree" : null;
        if (!kind) continue;
        const entry: StoredJob = { jobId: job.id, kind: "generation", prompt: job.prompt ?? "", startedAt: Date.parse(job.createdAt) || Date.now(), op: { kind, promptText: job.prompt ?? "", lengthSec: presetLength } };
        saveStoredJob(job.status === "interrupted" ? { ...entry, interrupted: true } : entry);
        stored.push(job.status === "interrupted" ? { ...entry, interrupted: true } : entry);
      }
      const checked = await Promise.all(stored.map(async (entry) => ({ entry, snapshot: await fetchJob(entry.jobId).catch(() => undefined) })));
      const live: StoredJob[] = [];
      const finished: StoredJob[] = [];
      for (const { entry, snapshot } of checked) {
        if (snapshot === undefined) continue; // server unreachable: try again next load
        if (snapshot === null || snapshot.status === "cancelled") removeStoredJob(entry.jobId);
        else if (snapshot.status === "interrupted") updateStoredJob(entry.jobId, { interrupted: true });
        else if (snapshot.status === "done" || snapshot.status === "error") finished.push(entry);
        else live.push(entry);
      }
      // Results that arrived while the tab was closed: apply them (history item / project update), then note it.
      for (const entry of finished.sort((a, b) => a.startedAt - b.startedAt)) {
        await restoreJob(entry);
        setNotice("Finished while you were away");
      }
      // Running jobs: the newest generation and the newest edit get their live UI back (one of each can show).
      const newest = (kinds: string[]) => live.filter((entry) => kinds.includes(entry.kind)).sort((a, b) => b.startedAt - a.startedAt)[0];
      const generation = newest(["generation", "upload"]);
      const edit = newest(["ask", "append", "mutate", "command"]);
      const other = live.filter((entry) => !["generation", "upload", "ask", "append", "mutate", "command"].includes(entry.kind));
      if (generation) void restoreJob(generation);
      if (edit) void restoreJob(edit);
      other.forEach((entry) => void restoreJob(entry));
    })();
    // Runs once per page load; restoreJob reads the latest state through refs/history at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resumeInterruptedJob(entry: StoredJob) {
    setError(null);
    try {
      await resumeServerJob(entry.jobId);
      updateStoredJob(entry.jobId, { interrupted: false });
      await restoreJob({ ...entry, interrupted: false });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not resume the job.");
    }
  }

  function dismissInterruptedJob(entry: StoredJob) {
    void cancelServerJob(entry.jobId);
    removeStoredJob(entry.jobId);
  }

  function pickSourceProject(item: HistoryItem) {
    clearAttachment();
    setSourceProject(item);
    setIsHistoryPickerOpen(false);
    if (continueAction === "edit") setContinueAction("append");
    setError(null);
  }

  /* ---- <video> events ---- */

  function onVideoLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    if (Number.isFinite(video.duration)) setVideoDuration(video.duration);
    if (seekOnLoadRef.current !== null) {
      video.currentTime = seekOnLoadRef.current;
      seekOnLoadRef.current = null;
    }
  }

  function onVideoTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
    if (!isScrubbingRef.current) setCurrentTime(event.currentTarget.currentTime);
  }

  function onVideoPause() {
    setIsPlaying(false);
    if (ignorePauseRef.current) {
      ignorePauseRef.current = false;
      return;
    }
    if (!isScrubbingRef.current) grabCurrentFrame({ confirm: true, focusComposer: true });
  }

  function onVideoSeeked() {
    if (!grabOnSeekRef.current) return;
    grabOnSeekRef.current = false;
    grabCurrentFrame();
  }

  function clearSelection() {
    setGrab(null);
    setRange(null);
    disarmConfirm();
  }

  const thread = isContinueMode && project ? mergeThread(threadFromProject(project), localThread) : [];
  const hasThread = isContinueMode && (thread.length > 0 || pendingOp !== null);
  const playheadPercent = Math.min(100, (currentTime / timelineTotal) * 100);
  const grabPercent = grab ? Math.min(100, (grab.atSec / timelineTotal) * 100) : null;
  const isGrabFresh = grab !== null && grabConfirmed === grab.key;

  return {
    // generation / composer
    prompt, setPrompt, isGenerating, generatingKind, generationLive, generatingPrompt, isStartingResearch,
    interruptedJobs, resumeInterruptedJob, dismissInterruptedJob, startSuggestedVideo,
    research, createVideoFromResearch, approveStoryline, dismissResearch: () => setActiveResearch(null), error, notice, narrationMessages,
    mediaType, isMediaMenuOpen, setIsMediaMenuOpen, selectMediaType, storyboardFileName, storyboardError, selectStoryboard,
    presetLength, setPresetLength, clipCopy, canSubmit, submitComposer, promptInputRef,
    stories, storyCount, setStoryCount, storyLength, setStoryLength,
    cancelGeneration: generationAbort.abort, cancelEdit: editAbort.abort,
    // history
    history, isHistoryOpen, setHistoryOpen, openProject,
    // attachments + sources
    attachment, clearAttachment, setLocalDuration, fileInputRef, onFileInputChange, openFilePicker, attachDisabledReason,
    isDragOver, onComposerDragEnter, onComposerDragOver, onComposerDragLeave, onComposerDrop, onComposerPaste,
    sourceProject, setSourceProject, isHistoryPickerOpen, setIsHistoryPickerOpen, pickSourceProject,
    // editor
    isEditorOpen, isContinueMode, openProjectId, openItem, openTitle, project, projectError, closeEditor,
    continueAction, selectContinueAction, isAppendMode, isAutoMode, isAtEnd, isStoryboardProject, isEditing, busy, editedNote,
    // player
    videoRef, videoReload, isMuted, setIsMuted, isPlaying, setIsPlaying, currentTime, setCurrentTime, duration, setVideoDuration,
    onVideoLoadedMetadata, onVideoTimeUpdate, onVideoPause, onVideoSeeked, togglePlay, pauseQuietly, grabCurrentFrame, onPlayerKeyDown,
    // timeline + range
    timelineRef, timelineTotal, targetSec, targetFrame, editWindow, range, rangeLimit, flashWindow, grab, grabPercent, playheadPercent, isGrabFresh,
    onTimelinePointerDown, onTimelinePointerMove, onTimelinePointerUp, onTimelinePointerCancel,
    confirmCut, confirmRemoveFrame, requestCutRange, requestRemoveFrame, clearSelection, goToEnd,
    // thread
    thread, hasThread, threadRef, pendingOp, retryThreadOp,
  };
}

export type Studio = ReturnType<typeof useStudio>;
