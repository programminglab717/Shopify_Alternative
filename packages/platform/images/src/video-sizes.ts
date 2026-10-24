import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanVideo, type CleanVideo } from './videos.js';

// Smaller sizes of products' videos (CAT-02, ADR-791), made by ffmpeg, the open-source encoder,
// as a process of its own: each H.264 and AAC in an MP4 whose index comes first, so a browser
// starts playing before the rest arrives, at a short side of 720 or 480 pixels, nothing of what
// the original said about itself kept.

/** The short sides smaller copies are made at, the largest first. */
export const VIDEO_SIZES = [720, 480] as const;
export type VideoSizeValue = (typeof VIDEO_SIZES)[number];

/** A smaller copy of a video, as kept. */
export interface VideoCopy {
  /** Its short side, as its address names it: 720 or 480. */
  short: VideoSizeValue;
  body: Buffer;
  width: number;
  height: number;
}

export interface VideoSizerOptions {
  /** The ffmpeg program: `ffmpeg`, found on the PATH, unless given. */
  ffmpeg?: string;
  /** How long one copy may take: five minutes unless given. */
  timeoutMs?: number;
  /** The threads ffmpeg may use: two unless given, as the worker does other work. */
  threads?: number;
}

/** Why a copy was not made. */
export class VideoSizeError extends Error {
  override readonly name = 'VideoSizeError';
}

/** The sizes worth making of a video `width` by `height` as shown: those below its short side. */
export function videoSizesFor(width: number, height: number): VideoSizeValue[] {
  const short = Math.min(width, height);
  return VIDEO_SIZES.filter((size) => size < short);
}

/** The frame a copy at short side `short` has, the long side kept even, as H.264 asks. */
export function sizedFrame(
  width: number,
  height: number,
  short: number,
): { width: number; height: number } {
  const long = Math.max(
    2,
    Math.round((Math.max(width, height) * short) / Math.min(width, height) / 2) * 2,
  );
  return width >= height ? { width: long, height: short } : { width: short, height: long };
}

/**
 * Makes smaller copies of videos with ffmpeg (ADR-791): the original, as kept (ADR-258), turned
 * as shown, scaled to each short side, H.264 at a quality phones' screens cannot tell from it and
 * AAC sound, its index at the front. Each copy is read back as an upload is, so only what Hatti
 * would keep is kept.
 */
export class VideoSizer {
  readonly #ffmpeg: string;
  readonly #timeoutMs: number;
  readonly #threads: number;

  constructor(options: VideoSizerOptions = {}) {
    this.#ffmpeg = options.ffmpeg ?? 'ffmpeg';
    this.#timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.#threads = options.threads ?? 2;
  }

  /** Whether ffmpeg is there, with H.264's encoder. */
  async available(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.#ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10_000 }, (error, out) =>
        resolve(!error && /\blibx264\b/.test(out)),
      );
    });
  }

  /**
   * `video`, HEVC as an iPhone records it, made H.264 and AAC (ADR-792): at most 1080 pixels on
   * its short side, turned as shown, its index at the front, read back as an upload is. Throws
   * {@link VideoSizeError} where ffmpeg fails or makes what Hatti would not keep.
   */
  async toH264(video: Buffer): Promise<CleanVideo> {
    const directory = await mkdtemp(join(tmpdir(), 'hatti-video-'));
    try {
      const input = join(directory, 'in.mov');
      const output = join(directory, 'h264.mp4');
      await writeFile(input, video);
      await this.#run(
        this.#encode(
          input,
          // Its short side as it is, or 1080 where it has more, as a phone's 4K has.
          "scale='if(gte(iw,ih),-2,min(1080,iw))':'if(gte(iw,ih),min(1080,ih),-2)',setsar=1",
          output,
          // What is kept as the original: closer to it than its smaller copies are.
          23,
        ),
      );
      const cleaned = cleanVideo(await readFile(output));
      if (!cleaned.ok) {
        throw new VideoSizeError(`Made H.264, it will not play: ${cleaned.problem.message}`);
      }
      return cleaned.video;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * The smaller copies of `video` worth making, the largest first; none for one whose short side
   * is 480 pixels or fewer. Throws {@link VideoSizeError} where ffmpeg fails or makes what Hatti
   * would not keep.
   */
  async copies(video: Pick<CleanVideo, 'body' | 'width' | 'height'>): Promise<VideoCopy[]> {
    const sizes = videoSizesFor(video.width, video.height);
    if (sizes.length === 0) return [];
    const directory = await mkdtemp(join(tmpdir(), 'hatti-video-'));
    try {
      const input = join(directory, 'in.mp4');
      await writeFile(input, video.body);
      const copies: VideoCopy[] = [];
      for (const short of sizes) {
        const frame = sizedFrame(video.width, video.height, short);
        const output = join(directory, `${short}.mp4`);
        await this.#run(
          this.#encode(input, `scale=${frame.width}:${frame.height},setsar=1`, output),
        );
        const cleaned = cleanVideo(await readFile(output));
        if (!cleaned.ok) {
          throw new VideoSizeError(`The ${short}p copy will not play: ${cleaned.problem.message}`);
        }
        const { body, width, height } = cleaned.video;
        copies.push({ short, body, width, height });
      }
      return copies;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * ffmpeg's arguments to make `input` H.264 and AAC through the filter `scale`, at quality
   * `crf`, the original's metadata dropped, its index at the front.
   */
  #encode(input: string, scale: string, output: string, crf = 26): string[] {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-map_metadata',
      '-1',
      '-vf',
      scale,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '2',
      '-threads',
      String(this.#threads),
      '-movflags',
      '+faststart',
      output,
    ];
  }

  /** Runs ffmpeg, its errors the last of what it said. */
  #run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let said = '';
      child.stderr.on('data', (chunk: Buffer) => {
        said = (said + chunk.toString('utf8')).slice(-2_000);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.#timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new VideoSizeError(`ffmpeg could not start: ${error.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else if (signal) reject(new VideoSizeError(`ffmpeg took too long, and was stopped`));
        else reject(new VideoSizeError(`ffmpeg failed: ${said.trim() || `exit ${code}`}`));
      });
    });
  }
}
