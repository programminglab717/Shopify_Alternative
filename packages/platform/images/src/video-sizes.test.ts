import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VideoSizeError, VideoSizer, sizedFrame, videoSizesFor } from './video-sizes.js';
import { cleanVideo } from './videos.js';

/** Whether this machine has ffmpeg with H.264's encoder, as CI and the worker's image do. */
const FFMPEG = /\blibx264\b/.test(
  spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '',
);

/** Whether ffmpeg can also record HEVC, as an iPhone does, for the tests that convert it. */
const HEVC_ENCODER = /\blibx265\b/.test(
  spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '',
);

/** A second of video as a phone would record one, `width` by `height`, with sound. */
async function recorded(width: number, height: number, codec = 'libx264'): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'hatti-video-test-'));
  try {
    const file = join(directory, 'phone.mp4');
    const made = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${width}x${height}:rate=24:duration=1`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:v',
      codec,
      ...(codec === 'libx265' ? ['-tag:v', 'hvc1'] : []),
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ]);
    if (made.status !== 0) throw new Error(made.stderr.toString());
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Smaller sizes of a video (ADR-791)', () => {
  it('are those below its short side, its long side kept even', () => {
    expect(videoSizesFor(1920, 1080)).toEqual([720, 480]);
    expect(videoSizesFor(1080, 1920)).toEqual([720, 480]);
    expect(videoSizesFor(1280, 720)).toEqual([480]);
    expect(videoSizesFor(640, 480)).toEqual([]);
    expect(sizedFrame(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(sizedFrame(1080, 1920, 480)).toEqual({ width: 480, height: 854 });
    expect(sizedFrame(1000, 1000, 480)).toEqual({ width: 480, height: 480 });
  });

  it.skipIf(!FFMPEG)(
    'are made by ffmpeg as H.264 and AAC that Hatti keeps, an upright video kept upright',
    async () => {
      const sizer = new VideoSizer();
      expect(await sizer.available()).toBe(true);
      const upright = cleanVideo(await recorded(720, 1280));
      if (!upright.ok) throw new Error(upright.problem.message);
      const copies = await sizer.copies(upright.video);
      expect(copies.map(({ short, width, height }) => ({ short, width, height }))).toEqual([
        { short: 480, width: 480, height: 854 },
      ]);
      // Read back as an upload is: it plays, and lasts as long.
      const back = cleanVideo(Buffer.from(copies[0]!.body));
      expect(back.ok && Math.abs(back.video.durationMs - upright.video.durationMs)).toBeLessThan(
        100,
      );
      // Its index at the front, so a browser plays it as it arrives.
      const boxes = copies[0]!.body.toString('latin1', 0, 64);
      expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
      expect(boxes.indexOf('moov')).toBeLessThan(
        boxes.indexOf('mdat') === -1 ? 64 : boxes.indexOf('mdat'),
      );
    },
    60_000,
  );

  it.skipIf(!FFMPEG)('says why when ffmpeg cannot read the video', async () => {
    await expect(
      new VideoSizer().copies({ body: Buffer.from('not a video'), width: 1280, height: 720 }),
    ).rejects.toBeInstanceOf(VideoSizeError);
  });

  it.skipIf(!HEVC_ENCODER)(
    'makes an HEVC video, as an iPhone records one, H.264 at no more than 1080 pixels (ADR-792)',
    async () => {
      const hevc = await recorded(2160, 3840, 'libx265');
      const refused = cleanVideo(Buffer.from(hevc));
      expect(refused.ok || refused.problem).toMatchObject({ convertible: true });
      const made = await new VideoSizer().toH264(hevc);
      expect([made.width, made.height]).toEqual([1080, 1920]);
      expect(Math.abs(made.durationMs - 1_000)).toBeLessThan(100);
      // What Hatti keeps as an upload: H.264, which every browser plays.
      expect(cleanVideo(Buffer.from(made.body)).ok).toBe(true);
    },
    120_000,
  );

  it.skipIf(!FFMPEG)(
    'takes a frame of a video, as the image shown before it plays (ADR-793)',
    async () => {
      const video = cleanVideo(await recorded(640, 360));
      if (!video.ok) throw new Error(video.problem.message);
      const frame = await new VideoSizer().frameOf(video.video);
      // A JPEG's signature.
      expect([...frame.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      await expect(
        new VideoSizer().frameOf({ body: Buffer.from('not a video'), durationMs: 1_000 }),
      ).rejects.toBeInstanceOf(VideoSizeError);
    },
  );

  it('says so where there is no ffmpeg', async () => {
    const missing = new VideoSizer({ ffmpeg: '/nowhere/ffmpeg' });
    expect(await missing.available()).toBe(false);
    await expect(
      missing.copies({ body: Buffer.from('x'), width: 1280, height: 720 }),
    ).rejects.toThrow('ffmpeg could not start');
  });
});
