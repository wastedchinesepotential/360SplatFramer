/**
 * FFmpeg.wasm wrapper — handles loading, initialization, and command execution
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

let ffmpeg = null;
let loaded = false;

/**
 * Load and initialize FFmpeg.wasm
 * @param {Function} onLog - callback for log messages
 * @returns {Promise<FFmpeg>}
 */
export async function loadFFmpeg(onLog) {
  if (loaded && ffmpeg) return ffmpeg;

  ffmpeg = new FFmpeg();

  ffmpeg.on('log', ({ message }) => {
    if (onLog) onLog(message);
  });

  // Load from CDN (unpkg) — these are loaded once and cached by the browser
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
  await ffmpeg.load({
    coreURL: `${baseURL}/ffmpeg-core.js`,
    wasmURL: `${baseURL}/ffmpeg-core.wasm`,
  });

  loaded = true;
  return ffmpeg;
}

/**
 * Write a file into FFmpeg's virtual filesystem
 * @param {string} name - filename in virtual FS
 * @param {File|Blob|ArrayBuffer|Uint8Array} data - file data
 */
export async function writeFile(name, data) {
  if (!ffmpeg) throw new Error('FFmpeg not loaded');
  
  let fileData;
  if (data instanceof Uint8Array) {
    fileData = data;
  } else if (data instanceof File || data instanceof Blob) {
    const buffer = await data.arrayBuffer();
    fileData = new Uint8Array(buffer);
  } else {
    fileData = await fetchFile(data);
  }
  
  await ffmpeg.writeFile(name, fileData);
}

/**
 * Read a file from FFmpeg's virtual filesystem
 * @param {string} name - filename in virtual FS
 * @returns {Promise<Uint8Array>}
 */
export async function readFile(name) {
  if (!ffmpeg) throw new Error('FFmpeg not loaded');
  return await ffmpeg.readFile(name);
}

/**
 * Delete a file from FFmpeg's virtual filesystem
 * @param {string} name
 */
export async function deleteFile(name) {
  if (!ffmpeg) throw new Error('FFmpeg not loaded');
  try {
    await ffmpeg.deleteFile(name);
  } catch (e) {
    // File may not exist, ignore
  }
}

/**
 * Execute an FFmpeg command
 * @param {string[]} args - command arguments (without 'ffmpeg' prefix)
 * @returns {Promise<number>} exit code
 */
export async function exec(args) {
  if (!ffmpeg) throw new Error('FFmpeg not loaded');
  return await ffmpeg.exec(args);
}

/**
 * List files in a directory of FFmpeg's virtual FS
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listDir(dir) {
  if (!ffmpeg) throw new Error('FFmpeg not loaded');
  try {
    const entries = await ffmpeg.listDir(dir);
    return entries
      .filter(e => !e.isDir && e.name !== '.' && e.name !== '..')
      .map(e => e.name);
  } catch (e) {
    return [];
  }
}

export function isLoaded() {
  return loaded;
}
