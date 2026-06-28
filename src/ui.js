/**
 * UI Module — handles DOM interactions, drag-drop, state transitions, and progress
 */

import { loadFFmpeg } from './ffmpeg-worker.js';
import { processVideo } from './processor.js';
import JSZip from 'jszip';

// ============================================
// State
// ============================================

const state = {
  file: null,
  mode: 'perspective-4',
  fps: 2,
  resolution: 1920,
  quality: 2,
  result: null,
  zipBlob: null,
};

// ============================================
// DOM References
// ============================================

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {};

function cacheDom() {
  els.dropZone = $('drop-zone');
  els.fileInput = $('file-input');
  els.fileInfo = $('file-info');
  els.fileName = $('file-name');
  els.fileBadge = $('file-badge');
  els.fileMeta = $('file-meta');
  els.btnChangeFile = $('btn-change-file');

  els.stepUpload = $('step-upload');
  els.stepConfigure = $('step-configure');
  els.stepProcessing = $('step-processing');
  els.stepDownload = $('step-download');

  els.modeSelector = $('mode-selector');
  els.fpsSelector = $('fps-selector');
  els.resSelector = $('res-selector');
  els.qualitySlider = $('quality-slider');
  els.qualityValue = $('quality-value');
  els.fpsHint = $('fps-hint');
  els.btnProcess = $('btn-process');

  els.processingStage = $('processing-stage');
  els.progressFill = $('progress-fill');
  els.progressText = $('progress-text');
  els.processingDetail = $('processing-detail');
  els.processingLog = $('processing-log');

  els.downloadStats = $('download-stats');
  els.btnDownload = $('btn-download');
  els.btnRestart = $('btn-restart');
}

// ============================================
// Initialization
// ============================================

export function initUI() {
  cacheDom();
  bindEvents();
}

function bindEvents() {
  // Drop zone
  els.dropZone.addEventListener('click', () => els.fileInput.click());
  els.dropZone.addEventListener('dragover', handleDragOver);
  els.dropZone.addEventListener('dragleave', handleDragLeave);
  els.dropZone.addEventListener('drop', handleDrop);
  els.fileInput.addEventListener('change', handleFileSelect);
  els.btnChangeFile.addEventListener('click', resetToUpload);

  // Mode selector
  els.modeSelector.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      els.modeSelector.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
    });
  });

  // FPS selector
  els.fpsSelector.querySelectorAll('.radio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      els.fpsSelector.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.fps = parseFloat(btn.dataset.value);
      updateFpsHint();
    });
  });

  // Resolution selector
  els.resSelector.querySelectorAll('.radio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      els.resSelector.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.resolution = parseInt(btn.dataset.value);
    });
  });

  // Quality slider
  els.qualitySlider.addEventListener('input', () => {
    const val = parseInt(els.qualitySlider.value);
    state.quality = val;
    const labels = { 1: 'Maximum', 2: 'High', 3: 'High', 4: 'Good', 5: 'Good', 6: 'Medium', 7: 'Medium', 8: 'Low', 9: 'Low', 10: 'Lowest' };
    els.qualityValue.textContent = `${labels[val] || 'Good'} (${val})`;
  });

  // Process button
  els.btnProcess.addEventListener('click', startProcessing);

  // Download button
  els.btnDownload.addEventListener('click', downloadZip);

  // Restart button
  els.btnRestart.addEventListener('click', resetToUpload);
}

// ============================================
// Drag & Drop
// ============================================

function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  els.dropZone.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  els.dropZone.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  els.dropZone.classList.remove('drag-over');

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFile(files[0]);
  }
}

function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    handleFile(e.target.files[0]);
  }
}

// ============================================
// File Handling
// ============================================

function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const validExts = ['mp4', 'mov'];

  if (!validExts.includes(ext)) {
    alert(`Unsupported file type: .${ext}\n\nPlease use .mp4 or .mov files.`);
    return;
  }

  // 500MB limit (524,288,000 bytes)
  if (file.size > 524288000) {
    alert(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB).\n\nThe Web version has a strict 500MB limit due to browser memory constraints. Please trim your video shorter or lower the bitrate in Insta360 Studio.`);
    return;
  }

  state.file = file;
  state.result = null;
  state.zipBlob = null;

  // Reset all steps to clean state
  els.stepProcessing.classList.add('hidden');
  els.stepDownload.classList.add('hidden');
  els.btnProcess.disabled = false;
  els.progressFill.style.width = '0%';
  els.progressFill.style.background = '';
  els.processingLog.innerHTML = '';

  // Update file info display
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB`;

  els.fileBadge.textContent = 'Ready';
  els.fileBadge.className = 'file-badge recommended';

  // Show file info, hide drop zone
  els.dropZone.classList.add('hidden');
  els.fileInfo.classList.remove('hidden');

  // Show configure step
  els.stepConfigure.classList.remove('hidden');

  updateFpsHint();

  // Scroll to configure
  els.stepConfigure.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateFpsHint() {
  // Rough estimate: assume 1-2 min video
  // We don't know the duration without probing, so give a range
  const sizeMB = state.file ? state.file.size / 1024 / 1024 : 100;
  // Very rough: ~200MB/min for 8K HEVC. Adjust estimate.
  const estMinutes = Math.max(0.5, sizeMB / 200);
  const estFrames = Math.round(estMinutes * 60 * state.fps);

  let multiplier = 1;
  if (state.mode === 'perspective-4') multiplier = 4;
  if (state.mode === 'perspective-6') multiplier = 6;

  const totalOutput = estFrames * multiplier;
  els.fpsHint.textContent = `~${estFrames} frames → ~${totalOutput} output files (estimated)`;
}

// ============================================
// Processing
// ============================================

async function startProcessing() {
  // Transition to processing step
  els.stepConfigure.classList.add('hidden');
  els.stepProcessing.classList.remove('hidden');
  els.btnProcess.disabled = true;

  els.processingLog.innerHTML = '';

  const logLine = (msg) => {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = msg;
    els.processingLog.appendChild(line);
    els.processingLog.scrollTop = els.processingLog.scrollHeight;
  };

  try {
    // Load FFmpeg
    updateProgress('Loading FFmpeg engine...', 0, 'Downloading ~30MB WebAssembly core (cached after first load)');
    await loadFFmpeg(logLine);
    updateProgress('FFmpeg ready', 5, '');

    // Process
    const config = {
      mode: state.mode,
      fps: state.fps,
      resolution: state.resolution,
      quality: state.quality,
    };

    const result = await processVideo(state.file, config, (stage, pct, detail) => {
      updateProgress(stage, pct, detail);
    });

    state.result = result;

    // Build ZIP
    updateProgress('Building ZIP file...', 95, `Packaging ${result.tileCount} files`);
    const zip = new JSZip();
    const folderName = state.file.name.replace(/\.[^.]+$/, '') + '_frames';
    const folder = zip.folder(folderName);

    for (const file of result.files) {
      folder.file(file.name, file.data);
    }

    state.zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 }, // Fast compression, JPEGs don't compress much anyway
    }, (metadata) => {
      updateProgress('Building ZIP...', 95 + (metadata.percent * 0.05), `${metadata.percent.toFixed(0)}%`);
    });

    updateProgress('Complete!', 100, '');

    // Show download step
    showDownloadStep(result);

  } catch (err) {
    console.error('Processing error:', err);
    els.processingStage.textContent = 'Error!';
    els.processingDetail.textContent = err.message || 'An unknown error occurred.';
    els.progressFill.style.width = '100%';
    els.progressFill.style.background = 'var(--danger)';
    els.progressText.textContent = '✗';
    logLine(`ERROR: ${err.message}`);

    // Add a retry button so user can go back
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn-ghost retry-btn';
    retryBtn.style.marginTop = '16px';
    retryBtn.textContent = '← Go back and try again';
    retryBtn.addEventListener('click', () => {
      retryBtn.remove();
      els.stepProcessing.classList.add('hidden');
      els.stepConfigure.classList.remove('hidden');
      els.btnProcess.disabled = false;
      els.progressFill.style.width = '0%';
      els.progressFill.style.background = '';
      els.progressText.textContent = '0%';
      els.processingLog.innerHTML = '';
    });
    els.processingLog.parentElement.appendChild(retryBtn);
  }
}

function updateProgress(stage, percent, detail) {
  els.processingStage.textContent = stage;
  els.progressFill.style.width = `${Math.min(100, percent)}%`;
  els.progressText.textContent = `${Math.round(percent)}%`;
  if (detail) els.processingDetail.textContent = detail;
}

// ============================================
// Download
// ============================================

function showDownloadStep(result) {
  els.stepProcessing.classList.add('hidden');
  els.stepDownload.classList.remove('hidden');

  const zipSizeMB = (state.zipBlob.size / 1024 / 1024).toFixed(1);
  const modeLabels = {
    'equirect': 'Equirectangular',
    'perspective-4': '4 Perspective Tiles',
    'perspective-6': '6 Cubemap Tiles',
  };

  els.downloadStats.innerHTML = `
    <div><strong>${result.frameCount}</strong> source frames extracted</div>
    <div><strong>${result.tileCount}</strong> output files (${modeLabels[state.mode]})</div>
    <div><strong>${zipSizeMB} MB</strong> ZIP file</div>
  `;

  els.stepDownload.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadZip() {
  if (!state.zipBlob) return;

  const fileName = state.file.name.replace(/\.[^.]+$/, '') + '_splat_frames.zip';
  const url = URL.createObjectURL(state.zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================
// Reset
// ============================================

function resetToUpload() {
  state.file = null;
  state.result = null;
  state.zipBlob = null;

  // Reset UI
  els.dropZone.classList.remove('hidden');
  els.fileInfo.classList.add('hidden');
  els.stepConfigure.classList.add('hidden');
  els.stepProcessing.classList.add('hidden');
  els.stepDownload.classList.add('hidden');
  els.stepUpload.classList.remove('hidden');
  els.btnProcess.disabled = false;

  // Reset progress
  els.progressFill.style.width = '0%';
  els.progressFill.style.background = '';
  els.progressText.textContent = '0%';
  els.processingLog.innerHTML = '';

  // Remove any retry buttons
  document.querySelectorAll('.retry-btn').forEach(b => b.remove());

  // Reset file input
  els.fileInput.value = '';

  window.scrollTo({ top: 0, behavior: 'smooth' });
}
