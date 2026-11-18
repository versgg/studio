// The surface the preload exposes to the renderer as `window.studio`.

import type { DubJob, DubLook, DubScan, DubSpoken, DubText, DubVoice, DubVoiceLine } from './dub'
import type { DubChange } from './dub-retry'
import type { StemsJob } from './stems'
import type { TrItem, TrJob, TrLine, TrStems, TrText, TrVoice, TrVoiceChoice } from './translate'
import type { CcDraft, CcProject } from './capcut'
export type { Stem, StemsJob } from './stems'

/** A link looked up for Media › Download (main/download.ts `Probe`). */
export type DownloadProbe = { probe: string; url: string; platform: string; platformLabel: string; title: string; uploader?: string; duration: number; ladder: { id: string; label: string; res?: string }[]; thumb: string | null }
/** A download into a project (main/download.ts `DownloadJob`). */
export type DownloadJob = { id: string; project: string; url: string; title: string; platform: string; kind: 'mp4' | 'mp3'; quality: string; vmake: string; serverId: string; state: 'queued' | 'working' | 'saving' | 'saved' | 'failed' | 'cancelled'; stage: string; fraction: number; file?: string; bytes?: number; error?: string; imported?: boolean; startedAt: number }

/** A sound the Translations tab can speak again: the voice that spoke it and what it says. */
export type TrSound = {
  voiceId?: string
  model?: string
  speed?: number
  name?: string
  text?: string
  original?: string
  lang?: string
  /** A dub's clone that isn't kept (or a translation's, `translation`): cloned again from this sample for the take, then deleted. */
  clone?: { sample: string; name: string; translation?: boolean }
  /** A voiceover Studio didn't make, as it was heard (main/voice-read.ts): its sentences in seconds into the file (none: no speech), how its voice was found, or why it wasn't. */
  read?: { sentences: { text: string; start: number; end: number; words?: { text: string; start: number; end: number }[] }[]; how?: 'studio' | 'history' | 'name' | 'picked'; note?: string; language?: string; mixed?: boolean }
}
/** Overlay text a dub left in the picture as filmed: in the dub's own time; `dir` is its folder's name. */
export type TrFilmed = { dir: string; text: string; startUs: number; endUs: number; box: { x: number; y: number; w: number; h: number } }
/** What was said in a dubbed clip's own sound (`source`), in seconds of that file. */
export type TrHeard = { source: string; language: string; lines: { text: string; start: number; end: number }[] }

export type LinkState = 'connecting' | 'connected' | 'disconnected'

export interface EngineProcess {
  state: 'starting' | 'running' | 'restarting' | 'failed' | 'stopped'
  pid?: number
  restarts?: number
  error?: string
}

export interface EngineStatus {
  link: LinkState
  process?: EngineProcess
}

export interface PlayerStats {
  fpsIn: number
  fpsDraw: number
  framesReceived: number
  dropped: number
  frameWidth: number
  frameHeight: number
  copyUsAvg: number
  copyUsMax: number
  uploadMsAvg: number
  uploadMsP95: number
  latencyMsAvg: number
  latencyMsP95: number
  intervalJitterMs: number
}

export interface AppPaths {
  documents: string
  videos: string
  projects: string
}

export type KeyName = 'vmake' | 'elevenlabs'

export interface ServiceError {
  error: string
  /** The key was refused (wrong or expired). */
  auth?: boolean
}

export interface VmakeAccount {
  balance: number | null
  /** By model; a model missing here isn't offered now. */
  prices: Record<string, { credits: number | null; durationLimit: number; remain: number | null }>
  /** Every model Studio knows, in order: its own, then any Vmake added since. */
  models: Record<string, { name: string; note: string }>
  /** When Vmake last answered (ms); null while it's Studio's own list and prices. */
  checked: number | null
}

/**
 * A text removal on Vmake. The main process keeps it beside its project (`jobs.json`) and
 * runs it to the end whether or not the project is open (src/main/vmake-jobs.ts).
 */
export interface VmakeJob {
  /** Also the clip's busy mark (`Clip.busy`). */
  id: string
  /** The project's folder. */
  project: string
  /** The timeline clip it's for; none for a library item. */
  clipId?: string
  mediaId: string
  name: string
  /** Where the cleaned video goes. */
  out: string
  state: 'preparing' | 'uploading' | 'charging' | 'working' | 'downloading' | 'done' | 'failed' | 'cancelled'
  stage: string
  fraction: number
  /** Why it failed, or what cancelling it meant. */
  reason?: string
  startedAt: number
  /** Seconds of video sent. */
  seconds?: number
  /** When Vmake charged for it, and how long it should take from then (vmake-estimate.ts). */
  chargedAt?: number
  expectedMs?: number
  /** The estimate is a first guess: no job had finished yet. */
  firstGuess?: boolean
  /** Vmake sends a progress number of its own, so `fraction` is that rather than the clock. */
  reported?: boolean
  /** Started by a visual dub, which takes the result itself. */
  dub?: string
}

export interface ElevenAccount {
  tier: string
  used: number
  limit: number
  canClone: boolean
  resetsAt: number | null
}

/** One round of Voice Design: what the previews say, and three new voices (`audio` plays as it is). */
export interface DesignRound {
  text: string
  previews: { id: string; audio: string; seconds: number }[]
}

export interface ElevenModel {
  id: string
  name: string
  maxChars: number
  languages: string[]
}

export interface Voice {
  id: string
  name: string
  /** cloned, professional, generated, premade, famous, high_quality, or library (the public Voice Library). */
  category: string
  description: string
  labels: Record<string, string>
  previewUrl: string | null
  ownerId?: string
}

/** Captions from the transcript server: each word with the part it was heard in, times in seconds from that part's start. */
export interface Transcript {
  words: { part: number; word: string; start: number; end: number }[]
  /** The language heard, as a code ("sv"). */
  language: string
  /** Where the script's words replaced misheard ones (the timings stay). */
  changes: { part: number; heard: string; script: string; note: string; at: number }[]
  /** The proofread's one line; null without a script. */
  summary: string | null
  /** Why a script was given but the words weren't checked against it (they're as heard); else null. */
  unchecked: string | null
}

/** A sound in the Audio tab's library: a built-in sound effect or a file in the music folder. */
export interface SoundFile {
  id: string
  name: string
  /** The effect's kind, or the music file's top folder inside the music folder ("" at the top). */
  kind: string
  path: string
  durationUs: number
  /** 24 bars (0-100) from the real sound; sound effects only. */
  bars?: number[]
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface FrameSource {
  id: string
  width: number
  height: number
  fps: number
  sourceFps: number
  sourceWidth: number
  sourceHeight: number
}

export interface StudioApi {
  platform: string
  /** Tests run with STUDIO_SILENT=1: previews make no sound. */
  silent: boolean
  /** STUDIO_DEBUG_DRAG=1: every step of a clip drag is written to the log. */
  debugDrag: boolean
  /** A line for Studio's log (userData/logs): what went wrong, or a drag traced. */
  log(kind: string, what: unknown): void
  engine: {
    call(method: string, params?: Record<string, unknown>): Promise<any>
    onStatus(cb: (status: EngineStatus) => void): () => void
    /** Notifications pushed by the engine (project.changed, playback.position, export.*). */
    onEvent(cb: (method: string, params: any) => void): () => void
  }
  player: {
    attach(canvasId: string): void
    detach(): void
    resetStats(): void
    onStats(cb: (stats: PlayerStats) => void): () => void
  }
  /**
   * Outside services on the user's own accounts. Keys are saved encrypted by the main
   * process; the page can see whether one is set, but never read it back.
   */
  services: {
    keys(): Promise<Record<KeyName, boolean>>
    setKey(name: KeyName, value: string): Promise<{ stored?: boolean; error?: string }>
    clearKey(name: KeyName): Promise<void>
    vmakeAccount(): Promise<VmakeAccount | ServiceError>
    /** What Vmake offers, its prices and the balance as last seen, without asking it (instant). */
    vmakeKnown(): Promise<VmakeAccount>
    /** A new text removal, waiting for its source: the page cuts the clip's part, then starts it. */
    vmakeCreate(o: { project: string; clipId?: string; mediaId: string; name: string; title: string; model: string; out: string; seconds?: number }): Promise<VmakeJob | ServiceError>
    /** Sends the source to Vmake; `removeSource` deletes it at the end (a part cut into the project's cleaned folder only). */
    vmakeStart(id: string, o: { source: string; removeSource?: boolean }): Promise<VmakeJob | ServiceError>
    /** Stops a job; with `reason` it ends as failed. Null when there's no such job. */
    vmakeCancel(id: string, reason?: string): Promise<VmakeJob | null>
    /** A project's jobs (running, or ended and not yet applied). */
    vmakeJobs(project: string): Promise<VmakeJob[]>
    /** The page applied an ended job (or freed its clip): it's forgotten. */
    vmakeSettled(id: string): Promise<void>
    /** Every change to any job, in any project. */
    onVmakeJob(cb: (job: VmakeJob) => void): () => void
    elevenAccount(): Promise<ElevenAccount | ServiceError>
    /** After saving a key: whether it works, and which of the free checks it isn't allowed ("Models (Read)"). */
    elevenCheckKey(): Promise<{ works: boolean; notAllowed: string[]; silent?: string[]; error?: string }>
    /** What ElevenLabs last sent (voices, models, credits), kept on this computer; shown at once. */
    elevenKept(): Promise<{ voices?: Voice[]; voicesAt?: number; models?: ElevenModel[]; account?: ElevenAccount }>
    /** The voices the account spoke with lately (its history), for when the voice list won't come. */
    elevenRecent(): Promise<Voice[] | ServiceError>
    elevenModels(): Promise<ElevenModel[] | ServiceError>
    elevenVoices(search?: string): Promise<Voice[] | ServiceError>
    elevenLibrary(search: string): Promise<Voice[] | ServiceError>
    elevenSpeak(o: { voice: Voice; text: string; modelId: string; stability: number; similarity: number; speed?: number; languageCode?: string; out: string }): Promise<{ out: string; voiceId: string } | ServiceError>
    elevenChangeVoice(o: { voiceId: string; input: string; out: string; removeNoise: boolean }): Promise<{ out: string } | ServiceError>
    elevenClone(o: { name: string; files: string[]; removeNoise: boolean }): Promise<{ voiceId: string } | ServiceError>
    /** Voice Design: three voices from a description (credits for the preview text), then the one picked kept in the account. */
    elevenDesign(o: { description: string; text?: string; model: string }): Promise<DesignRound | ServiceError>
    elevenSaveDesigned(o: { name: string; description: string; previewId: string; heard?: string[] }): Promise<{ voiceId: string } | ServiceError>
    /**
     * Captions: the transcript server on stretches of files (source time), sent as one recording,
     * proofread against `script` when there is one. Progress arrives as `taskId`'s task:progress.
     */
    transcribeParts(o: { taskId: string; parts: { path: string; startUs: number; durationUs: number }[]; language?: string; script?: string }): Promise<Transcript | ServiceError>
    /** Stops the captions being heard for that task (it ends with "Cancelled."). */
    cancelTranscribe(taskId: string): Promise<void>
    /** The scripts these sounds were read from (voiceovers keep theirs), joined in order; "" if none. */
    scriptsFor(paths: string[]): Promise<string>
    /**
     * Send to Director (src/main/director.ts). What Studio knows about these voiceovers: their
     * scripts (`<name>.script.txt`) joined in order, and their language (`<name>.voice.json`).
     */
    directorAbout(paths: string[]): Promise<{ script: string | null; language: string | null }>
    /** Makes the package's `.partial` folder in Director's inbox (the inbox too, if missing), for voice.wav. */
    directorBegin(name: string): Promise<{ dir: string } | ServiceError>
    /** Writes send.json beside voice.wav, hands the package over (drops `.partial`) and, with `open`, asks Director to open it. */
    directorFinish(o: { dir: string; name: string; clips: { startUs: number; durationUs: number }[]; labels: { startUs: number; endUs: number; text: string }[]; script: string | null; language: string | null; open: boolean }): Promise<{ folder: string; opened: boolean; phrases: number; duration: number } | ServiceError>
    /** Removes a package that didn't make it. */
    directorDiscard(dir: string): Promise<void>
    /**
     * Stems from the stems server (AudioShake): sends the stretch of `source` a clip plays and brings
     * the stems back into the project's stems folder (src/main/stems.ts). Runs on its own.
     */
    stemsStart(o: { project: string; clipId: string; mediaId: string; name: string; source: string; inUs: number; spanUs: number }): Promise<StemsJob | ServiceError>
    /** A project's separations (running, failed or done); ones left unfinished are picked up again. */
    stemsJobs(project: string): Promise<StemsJob[]>
    /** Stops a running separation (by its folder) and removes what it made. */
    stemsCancel(dir: string): Promise<void>
    /** Every change to any separation, in any project. */
    onStemsJob(cb: (job: StemsJob) => void): () => void
    /**
     * Visual dub (src/main/dub.ts): a clip's on-screen text found, read and translated by
     * Claude, removed by Vmake and measured, ready for the page to put back as text clips.
     */
    dubStart(o: { project: string; clipId: string; mediaId: string; name: string; source: string; inUs: number; spanUs: number; lang: string; model: string; text: boolean; voice: DubVoice; voiceId?: string; voiceName?: string; keepClone?: boolean; captions: boolean; review: boolean }): Promise<DubJob | ServiceError>
    /** A project's dubs; ones left running are picked up again. */
    dubJobs(project: string): Promise<DubJob[]>
    /** Home: each project's dubs that still need something (running, waiting, ready, stopped). */
    dubSummary(projects: string[]): Promise<Record<string, DubJob[]>>
    /** The Dub tab's picks after review (and translations changed there): the paid steps start. */
    dubGo(id: string, o: { texts: string[]; lines: string[]; edits?: Record<string, string> }): Promise<DubJob | null>
    /** Her clone kept in the ElevenLabs account, or deleted (now, and after each use). */
    dubKeepClone(id: string, keep: boolean): Promise<DubJob | ServiceError>
    /** Carries on a stopped dub; `change` is what the Dub tab shows that differs from its settings, used instead. */
    dubRetry(id: string, change?: DubChange): Promise<DubJob | null | ServiceError>
    /** Starts a dub's text removal again after it stopped (it's paid again). */
    dubRemoveAgain(id: string): Promise<DubJob | { error: string }>
    dubCancel(id: string): Promise<DubJob | null>
    /** A ready dub's scan, readings and looks. */
    dubResult(id: string): Promise<{ job: DubJob; scan: DubScan | null; texts: DubText[]; looks: DubLook[]; speech: { language: string; lines: DubSpoken[] } | null; said: { id: string; text: string; translation: string }[]; voice: { lines: DubVoiceLine[] } | null; draft: { texts: string[]; lines: string[]; edits: Record<string, string> } | null; says: Record<string, string> | null } | ServiceError>
    /** Saves (null: deletes) a dub's draft as it's typed: the review's picks and words, or What she says' changed sentences. */
    dubDraft(id: string, which: 'review' | 'says', value: unknown): Promise<void | ServiceError>
    dubApplied(id: string): Promise<void>
    /** Reroll: dubbed sentences spoken again by the same voice as a new take (with `edits`' words where given); the lines as they'll play. */
    dubReroll(id: string, lineIds: string[], edits?: Record<string, string>): Promise<DubVoiceLine[] | ServiceError>
    /** An earlier take of a dubbed sentence played again (kept, so free); the line as it'll play. */
    dubPickTake(id: string, lineId: string, take: number): Promise<DubVoiceLine | ServiceError>
    /** A ready dub couldn't go on the timeline: it ends failed with this reason. */
    dubFailed(id: string, reason: string): Promise<void>
    onDubJob(cb: (job: DubJob) => void): () => void
    /**
     * Translations (src/main/translate.ts): a project made again in other languages, one copy per
     * language. `translateContext`: what Studio knows about the project's sounds (the voice that
     * spoke each, what it says, the words a dub translated from) and its dubs' text translations.
     */
    translateContext(project: string, paths: string[]): Promise<{ sounds: Record<string, TrSound>; texts: { translation: string; original: string }[]; lang: string; was?: string; choices: Record<string, TrVoiceChoice>; filmed: TrFilmed[]; heard: TrHeard[] } | ServiceError>
    translateStart(o: { source: string; name: string; from: string; langs: string[]; voice: TrVoice; items: TrItem[]; durationUs: number }): Promise<TrJob[] | ServiceError>
    /** A voiceover Studio didn't make, heard once (what it says, which ElevenLabs voice speaks it); then `translateContext` knows it. */
    translateReadVoice(project: string, file: string): Promise<{ ok: true; sentences: number } | ServiceError>
    /** Media › Download: what a link is (title, length, qualities, picture), nothing fetched. */
    downloadProbe(url: string): Promise<DownloadProbe | ServiceError>
    /** Starts a download per pick into the project's downloads folder. */
    downloadStart(project: string, picks: { probe: string; url: string; title: string; platform: string; kind: 'mp4' | 'mp3'; quality: string; vmake: string }[]): Promise<DownloadJob[] | ServiceError>
    downloadList(project: string): Promise<DownloadJob[]>
    downloadCancel(id: string): Promise<DownloadJob | null>
    /** The page put a saved download in its project's library. */
    downloadImported(id: string): Promise<void>
    onDownloadJob(cb: (job: DownloadJob) => void): () => void
    /** What speaks a voice (by its key in the tab): an ElevenLabs voice, a clone from a sound, or its old sound; null: the one found. */
    translateChooseVoice(project: string, key: string, choice: TrVoiceChoice | null): Promise<void>
    /** The ElevenLabs account's own voices, to pick from. */
    translateVoices(): Promise<{ id: string; name: string }[] | ServiceError>
    /** The jobs translating a project, or the project's own (it's a copy). */
    translateJobs(project: string): Promise<TrJob[]>
    translateSummary(projects: string[]): Promise<Record<string, TrJob[]>>
    translateGo(id: string, o: { picks: string[]; edits?: Record<string, string> }): Promise<TrJob | null>
    translateRetry(id: string): Promise<TrJob | null>
    translateCancel(id: string): Promise<TrJob | null>
    translateResult(id: string): Promise<{ job: TrJob; items: TrItem[]; texts: TrText[]; voice: TrLine[] | null; stems: Record<string, TrStems>; draft: { off: string[]; edits: Record<string, string> } | null } | ServiceError>
    /** Saves (null: deletes) a language's review draft as it's typed: its unticked lines and changed words. */
    translateDraft(id: string, value: { off: string[]; edits: Record<string, string> } | null): Promise<void | ServiceError>
    translateApplied(id: string): Promise<void>
    translateFailed(id: string, reason: string): Promise<void>
    onTranslateJob(cb: (job: TrJob) => void): () => void
    /** Import from CapCut (src/main/capcut.ts): CapCut's projects, and one read with its fonts, stickers and filters copied into `into`. */
    capcutList(): Promise<CcDraft[] | ServiceError>
    capcutRead(dir: string, into: string): Promise<CcProject | ServiceError>
    /** The folder CapCut's projects are looked for in, and pointing Studio at another (the projects folder, or a copy of CapCut's data). */
    capcutRoot(): Promise<string>
    capcutSetRoot(dir: string): Promise<string | ServiceError>
    /** A project's own fonts (<project>.studio/fonts). */
    projectFonts(project: string): Promise<{ family: string; path: string }[]>
    /** Saves a microphone recording into the project's `recordings` folder. */
    saveRecording(file: string, data: ArrayBuffer): Promise<{ out: string } | ServiceError>
    onTaskProgress(cb: (p: { taskId: string; stage: string; fraction: number }) => void): () => void
  }
  /** Files the page draws or needs (main process, narrow rules: see src/main/files.ts). */
  files: {
    /** A PNG into a project's text/, masks/ or stickers/ folder. */
    writeAsset(path: string, data: Uint8Array): Promise<{ out: string } | ServiceError>
    exists(path: string): Promise<boolean>
    /** A draft kept in a project (`<project>/drafts/<name>.json`): what the user typed or picked that isn't in the project yet. Null when there's none. */
    readDraft<T = unknown>(project: string, name: string): Promise<T | null>
    /** Saves a draft (null deletes it). */
    writeDraft(project: string, name: string, value: unknown): Promise<{ ok: true } | ServiceError>
    /** Copies a PNG, GIF, WebP or WebM into the project's stickers folder. */
    importSticker(src: string, projectDir: string): Promise<{ out: string } | ServiceError>
    writeSrt(path: string, text: string): Promise<{ out: string } | ServiceError>
    /** A .txt or .srt (the Export window's text). */
    writeText(path: string, text: string): Promise<{ out: string } | ServiceError>
    /** Built-in LUTs (assets/luts). */
    luts(): Promise<{ name: string; path: string }[]>
    /** Copies a .cube into the project's luts folder; returns the copy. */
    useLut(src: string, projectDir: string): Promise<{ out: string } | ServiceError>
    /** Frames of a file, decoded small as RGBA, for analysis. */
    openFrames(o: { path: string; startUs: number; durationUs: number; fps: number; width: number }): Promise<FrameSource | ServiceError>
    nextFrame(id: string): Promise<{ frame: Uint8Array | null } | ServiceError>
    closeFrames(id: string): void
    /** A background matte: grey frames (1 byte a pixel) in, the raw matte video out. */
    openMatte(o: { raw: string; width: number; height: number; fps: number }): Promise<{ id: string } | ServiceError>
    writeMatte(id: string, data: Uint8Array): Promise<{ ok: true } | ServiceError>
    closeMatte(id: string, cancel?: boolean): Promise<{ ok: true } | ServiceError>
    /** The matte the engine uses, from the raw one: source size, softened edge, source-aligned. */
    finishMatte(o: { raw: string; out: string; width: number; height: number; startUs: number; edge: number; holdUs?: number }): Promise<{ out: string } | ServiceError>
    /** Mono float samples of a stretch of a file (the Audio page's pencil). */
    samples(o: { path: string; startUs: number; durationUs: number; rate: number }): Promise<{ samples: Float32Array } | ServiceError>
  }
  /** The app's own settings (saved looks, the music folder). */
  settings: {
    get<T = unknown>(key: 'looks' | 'musicFolder' | 'textPresets'): Promise<T | null>
    set(key: 'looks' | 'musicFolder' | 'textPresets', value: unknown): Promise<{ ok: true } | ServiceError>
  }
  /** The Audio tab's sound effects and music folder. */
  sounds: {
    effects(): Promise<SoundFile[] | ServiceError>
    musicFolder(): Promise<string>
    setMusicFolder(dir: string): Promise<{ ok: true } | ServiceError>
    scanMusic(): Promise<SoundFile[] | ServiceError>
    /** A sound effect's or music file's bytes, for a preview. */
    read(path: string): Promise<{ data: Uint8Array } | ServiceError>
    /** Copies a sound effect into the project's sounds folder. */
    intoProject(path: string, projectDir: string, name: string): Promise<{ out: string } | ServiceError>
  }
  /** The app's own window buttons (Windows and Linux; macOS keeps its traffic lights). */
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximized(cb: (maximized: boolean) => void): () => void
  }
  app: {
    paths(): Promise<AppPaths>
    /** The app zoom (Ctrl/Cmd+Shift + and −): the window's size factor now. */
    getZoom(): Promise<number>
    /** Sets the app zoom (kept for next time); `limited` when the screen couldn't hold that much. */
    setZoom(factor: number): Promise<{ factor: number; limited: boolean }>
    openMedia(): Promise<string[]>
    chooseFolder(defaultPath?: string, title?: string): Promise<string | null>
    chooseFile(o: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>
    saveFile(o: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>
    openProject(defaultPath?: string): Promise<string | null>
    showItem(path: string): void
    /** Opens a folder in the system file manager. */
    openFolder(path: string): void
    /** Plays a video file in the computer's own player. */
    openVideo(path: string): void
    /** The file-system path of a file dropped from the desktop. */
    pathForFile(file: File): string
    /** Which of these paths already exist (used to number export versions). */
    existing(paths: string[]): Promise<boolean[]>
    /** Projects on disk (the projects folder plus `extra` folders), newest first. */
    projects(extra?: string[]): Promise<ProjectInfo[]>
    /** A sharper still of a project's poster frame (up to 960 px tall), made once; null when there's none. */
    projectStill(dir: string): Promise<string | null>
    /** Copies a project under a new name (optionally into a folder you pick); its new folder. */
    saveProjectAs(dir: string, name: string, pick: boolean): Promise<string | null>
    /** Share project: asks where, then writes the project, every file it uses and the logs to read as one zip. Null when cancelled. */
    shareProject(dir: string, report: string, to?: string): Promise<{ out: string; bytes: number; files: number; outside: number } | ServiceError | null>
    /** Open shared project: a zip from Share project (asks for one when not given), unzipped into the projects folder. */
    openSharedProject(zip?: string): Promise<{ dir: string } | ServiceError | null>
    /** How far a share or an open is (bytes). */
    onShareProgress(cb: (p: { done: number; total: number }) => void): () => void
    renameProject(dir: string, name: string): Promise<boolean>
    /** Size on disk, and how many files Studio made in each subfolder (voiceovers, recordings…). */
    projectSize(dir: string): Promise<{ bytes: number; made: Record<string, number> } | null>
    /** A project's edit as saved (its project.json), null if it isn't a project. */
    readProject(dir: string): Promise<Record<string, unknown> | null>
    /** Deletes the project folder for good (not media linked from elsewhere). */
    deleteProject(dir: string): Promise<boolean>
    versions(dir: string): Promise<{ file: string; name: string; saved: number }[]>
    saveVersion(dir: string, name: string): Promise<string>
    restoreVersion(dir: string, file: string): Promise<boolean>
    deleteVersion(dir: string, file: string): Promise<boolean>
    /** The `claude mcp add …` command for this computer's studio-mcp, if it's built. */
    mcpCommand(): Promise<string | null>
    /** Opens a service's web page (key settings and docs only) in the normal browser. */
    openExternal(url: string): void
  }
}

export interface ProjectInfo {
  dir: string
  name: string
  width: number
  height: number
  durationUs: number
  modified: number
  byAgent: boolean
  byYou: boolean
  poster: string | null
  clips: number
}
