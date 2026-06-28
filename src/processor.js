/**
 * Processor — handles the actual video → frames conversion logic
 *
 * Supports three modes:
 *   1. equirect    — extract equirectangular frames as-is
 *   2. perspective-4 — extract frames then split into 4 perspective tiles (front/right/back/left)
 *   3. perspective-6 — extract frames then split into 6 cubemap tiles (+up/down)
 *
 * Also handles .insv approximate stitching as a preprocessing step.
 */

import * as ff from './ffmpeg-worker.js';

/**
 * @typedef {Object} ProcessorConfig
 * @property {'equirect'|'perspective-4'|'perspective-6'} mode
 * @property {number} fps - frames per second to extract
 * @property {number} resolution - tile width/height in pixels
 * @property {number} quality - JPEG quality (1=best, 10=worst)
 * @property {boolean} isInsv - whether the input is a raw .insv file
 * @property {number} insvFov - field of view for .insv stitching (degrees)
 */

/**
 * @typedef {Object} ProcessResult
 * @property {Array<{name: string, data: Uint8Array}>} files
 * @property {number} frameCount
 * @property {number} tileCount
 */

/**
 * Process a video file into frames/tiles
 * @param {File} file - the input video file
 * @param {ProcessorConfig} config
 * @param {Function} onProgress - callback(stage, percent, detail)
 * @returns {Promise<ProcessResult>}
 */
export async function processVideo(file, config, onProgress) {
  const inputName = 'input' + getExtension(file.name);
  const results = [];

  try {
    // Stage 1: Write input file to virtual FS
    onProgress('Loading file into memory...', 5, `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    await ff.writeFile(inputName, file);

    const equirectInput = inputName;

    // Stage 2: Extract equirectangular frames
    onProgress('Extracting frames...', config.isInsv ? 25 : 15, `at ${config.fps} fps`);

    // Create output directory marker — ffmpeg.wasm uses flat file names
    const framePrefix = 'frame_';
    const scaleFilter = config.mode === 'equirect'
      ? `scale=${config.resolution * 2}:${config.resolution}`
      : `scale=3840:1920`; // keep full res for tile extraction

    try {
      await ff.exec([
        '-avoid_negative_ts', 'make_zero',
        '-i', equirectInput,
        '-vf', scaleFilter,
        '-r', String(config.fps),
        '-q:v', String(Math.max(3, config.quality)), // Prevent q=1/2 memory spikes in mjpeg encoder
        '-y', `${framePrefix}%04d.jpg`,
      ]);
    } catch (err) {
      throw new Error(`Frame extraction failed. This is usually a WebAssembly memory limit. Try lowering the JPEG Quality or Tile Resolution. Details: ${err.message}`);
    }

    onProgress('Frames extracted', 40, 'Reading frame list...');

    // Get list of extracted frames
    const allFiles = await ff.listDir('/');
    const frameFiles = allFiles
      .filter(f => f.startsWith(framePrefix) && f.endsWith('.jpg'))
      .sort();

    const totalFrames = frameFiles.length;

    if (totalFrames === 0) {
      throw new Error('No frames were extracted. The video may be corrupted or in an unsupported format.');
    }

    onProgress('Frames extracted', 45, `${totalFrames} frames found`);

    // Stage 4: If equirect mode, just collect the frames
    if (config.mode === 'equirect') {
      for (let i = 0; i < frameFiles.length; i++) {
        const pct = 45 + (i / frameFiles.length) * 50;
        onProgress('Collecting frames...', pct, `${i + 1} / ${totalFrames}`);
        const data = await ff.readFile(frameFiles[i]);
        results.push({ name: frameFiles[i], data });
        await ff.deleteFile(frameFiles[i]);
      }
    }

    // Stage 5: If perspective mode, convert each frame to tiles
    if (config.mode === 'perspective-4' || config.mode === 'perspective-6') {
      const directions = config.mode === 'perspective-4'
        ? [
            { name: 'front', yaw: 0, pitch: 0 },
            { name: 'right', yaw: 90, pitch: 0 },
            { name: 'back', yaw: 180, pitch: 0 },
            { name: 'left', yaw: -90, pitch: 0 },
          ]
        : [
            { name: 'front', yaw: 0, pitch: 0 },
            { name: 'right', yaw: 90, pitch: 0 },
            { name: 'back', yaw: 180, pitch: 0 },
            { name: 'left', yaw: -90, pitch: 0 },
            { name: 'up', yaw: 0, pitch: 90 },
            { name: 'down', yaw: 0, pitch: -90 },
          ];

      const res = config.resolution;

      for (let i = 0; i < frameFiles.length; i++) {
        const frameFile = frameFiles[i];
        const baseName = frameFile.replace('.jpg', '');
        const pct = 45 + (i / frameFiles.length) * 50;
        onProgress('Converting to perspective tiles...', pct, `Frame ${i + 1} / ${totalFrames}`);

        for (const dir of directions) {
          const outName = `${baseName}_${dir.name}.jpg`;
        try {
          await ff.exec([
            '-i', frameFile,
            '-vf', `v360=e:flat:yaw=${dir.yaw}:pitch=${dir.pitch}:h_fov=90:v_fov=90:w=${res}:h=${res}`,
            '-q:v', String(Math.max(3, config.quality)),
            '-y', outName,
          ]);
        } catch (err) {
           throw new Error(`Tile generation failed (out of memory). Try lowering resolution. Details: ${err.message}`);
        }

          const data = await ff.readFile(outName);
          results.push({ name: outName, data });
          await ff.deleteFile(outName);
        }

        // Clean up the source equirect frame
        await ff.deleteFile(frameFile);
      }
    }

    // Cleanup input files
    try { await ff.deleteFile(inputName); } catch (_) {}

    onProgress('Complete!', 100, `${results.length} files ready`);

    return {
      files: results,
      frameCount: totalFrames,
      tileCount: results.length,
    };

  } catch (err) {
    // Attempt cleanup on error
    try { await ff.deleteFile(inputName); } catch (_) {}
    try { await ff.deleteFile('stitched.mp4'); } catch (_) {}
    throw err;
  }
}

function getExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.substring(dot).toLowerCase() : '';
}
