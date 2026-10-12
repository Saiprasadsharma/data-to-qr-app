import { Component, OnDestroy, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as QRCode from 'qrcode';

interface QrChunk {
  index: number;
  text: string;
  dataUrl: string;
}

interface ScannedCode {
  id: number;
  batchId: string;
  chunkIndex: number;
  chunkTotal: number;
  payload: string;
  scannedAt: Date;
}

type Tab = 'generate' | 'scan';
type DisplayMode = 'all' | 'loop';

// Kept small enough that each QR code's modules stay large enough to scan
// reliably with a webcam (dense high-version codes from larger chunks were
// flaky to decode, especially off a phone screen).
const CHUNK_SIZE = 300;

// Each QR encodes a fixed-width header (magic + batch id + index + total) ahead of
// the raw chunk text, so the scanner can reconstruct the original order and batch
// membership regardless of the order codes are physically scanned in.
const QR_MAGIC = 'QRB1';
const QR_HEADER_LENGTH = 16; // 4 magic + 6 batchId + 3 index + 3 total

function makeBatchId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

function encodeChunkHeader(batchId: string, index: number, total: number): string {
  return `${QR_MAGIC}${batchId}${String(index).padStart(3, '0')}${String(total).padStart(3, '0')}`;
}

interface ParsedChunk {
  batchId: string;
  index: number;
  total: number;
  payload: string;
}

function parseChunkHeader(decodedText: string): ParsedChunk | null {
  if (decodedText.length < QR_HEADER_LENGTH || decodedText.slice(0, 4) !== QR_MAGIC) {
    return null;
  }
  const batchId = decodedText.slice(4, 10);
  const index = Number(decodedText.slice(10, 13));
  const total = Number(decodedText.slice(13, 16));
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    return null;
  }
  return { batchId, index, total, payload: decodedText.slice(16) };
}

@Component({
  selector: 'app-data-to-qr',
  imports: [CommonModule, FormsModule],
  templateUrl: './data-to-qr.html',
  styleUrl: './data-to-qr.scss',
})
export class DataToQr implements OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // ---- Generator state (unchanged) ----
  protected readonly inputText = signal('');
  protected readonly qrChunks = signal<QrChunk[]>([]);
  protected readonly isGenerating = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly charCount = computed(() => this.inputText().length);
  protected readonly chunkCount = computed(() => Math.ceil(this.charCount() / CHUNK_SIZE));

  // ---- Auto-rotate display state ----
  protected readonly displayMode = signal<DisplayMode>('all');
  protected readonly rotationIntervalSeconds = signal(5);
  protected readonly rotationIndex = signal(0);
  protected readonly rotationSecondsLeft = signal(5);
  protected readonly rotationCycle = signal(1);
  private rotationTimerId: ReturnType<typeof setInterval> | null = null;

  protected readonly activeRotationChunk = computed(() => this.qrChunks()[this.rotationIndex()] ?? null);

  // ---- Tab state ----
  protected readonly activeTab = signal<Tab>('generate');

  // ---- Scanner state ----
  private html5QrCode: import('html5-qrcode').Html5Qrcode | null = null;
  private nextScanId = 1;

  protected readonly scannedCodes = signal<ScannedCode[]>([]);
  protected readonly isScanning = signal(false);
  protected readonly isStartingScan = signal(false);
  protected readonly scanError = signal('');
  protected readonly justScannedId = signal<number | null>(null);
  protected readonly duplicateFlash = signal(false);
  protected readonly newBatchFlash = signal(false);

  protected readonly scanProgress = computed(() => {
    const codes = this.scannedCodes();
    if (codes.length === 0) {
      return { scannedCount: 0, total: 0, missingIndices: [] as number[], complete: false };
    }
    const total = codes[0].chunkTotal;
    const present = new Set(codes.map((c) => c.chunkIndex));
    const missingIndices: number[] = [];
    for (let i = 1; i <= total; i++) {
      if (!present.has(i)) {
        missingIndices.push(i);
      }
    }
    return {
      scannedCount: codes.length,
      total,
      missingIndices,
      complete: missingIndices.length === 0,
    };
  });

  protected readonly combinedText = computed(() => {
    const progress = this.scanProgress();
    if (!progress.complete) {
      return '';
    }
    return [...this.scannedCodes()]
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => c.payload)
      .join('');
  });
  protected readonly combinedCharCount = computed(() => this.combinedText().length);

  ngOnDestroy(): void {
    void this.stopScan();
    this.clearRotationTimer();
  }

  // ---- Tab switching ----
  protected setTab(tab: Tab): void {
    if (this.activeTab() === tab) {
      return;
    }
    if (this.activeTab() === 'scan' && tab !== 'scan') {
      void this.stopScan();
    }
    if (this.activeTab() === 'generate' && tab !== 'generate' && this.displayMode() === 'loop') {
      this.clearRotationTimer();
      this.displayMode.set('all');
    }
    this.activeTab.set(tab);
  }

  // ---- Auto-rotate display methods ----
  protected setDisplayMode(mode: DisplayMode): void {
    if (this.displayMode() === mode) {
      return;
    }
    if (mode === 'loop') {
      this.rotationIndex.set(0);
      this.rotationCycle.set(1);
      this.rotationSecondsLeft.set(this.rotationIntervalSeconds());
      this.clearRotationTimer();
      this.rotationTimerId = setInterval(() => this.tickRotation(), 1000);
    } else {
      this.clearRotationTimer();
    }
    this.displayMode.set(mode);
  }

  private tickRotation(): void {
    const secondsLeft = this.rotationSecondsLeft() - 1;
    if (secondsLeft > 0) {
      this.rotationSecondsLeft.set(secondsLeft);
      return;
    }
    const total = this.qrChunks().length;
    const next = (this.rotationIndex() + 1) % total;
    if (next === 0) {
      this.rotationCycle.set(this.rotationCycle() + 1);
    }
    this.rotationIndex.set(next);
    this.rotationSecondsLeft.set(this.rotationIntervalSeconds());
  }

  private clearRotationTimer(): void {
    if (this.rotationTimerId !== null) {
      clearInterval(this.rotationTimerId);
      this.rotationTimerId = null;
    }
  }

  protected onIntervalInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = Math.min(15, Math.max(2, Number(target.value) || 5));
    this.rotationIntervalSeconds.set(value);
    if (this.displayMode() === 'loop') {
      this.rotationSecondsLeft.set(value);
    }
  }

  // ---- Generator methods (unchanged) ----
  protected onInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.inputText.set(target.value);
  }

  protected async generate(): Promise<void> {
    const text = this.inputText();
    this.errorMessage.set('');
    this.clearRotationTimer();
    this.displayMode.set('all');

    if (!text.trim()) {
      this.errorMessage.set('Please enter some text to generate QR codes.');
      this.qrChunks.set([]);
      return;
    }

    this.isGenerating.set(true);

    try {
      const chunks = text.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'gs')) ?? [];
      const batchId = makeBatchId();
      const total = chunks.length;
      this.qrChunks.set(
        await Promise.all(
          chunks.map(async (chunk, i): Promise<QrChunk> => {
            const index = i + 1;
            const encoded = encodeChunkHeader(batchId, index, total) + chunk;
            return {
              index,
              text: chunk,
              dataUrl: await QRCode.toDataURL(encoded, { errorCorrectionLevel: 'M', margin: 1, width: 256 }),
            };
          }),
        ),
      );
    } catch {
      this.errorMessage.set('Failed to generate QR codes. Please try again.');
      this.qrChunks.set([]);
    } finally {
      this.isGenerating.set(false);
    }
  }

  protected reset(): void {
    this.inputText.set('');
    this.qrChunks.set([]);
    this.errorMessage.set('');
    this.clearRotationTimer();
    this.displayMode.set('all');
  }

  // ---- Scanner methods ----
  protected async startScan(): Promise<void> {
    if (!this.isBrowser || this.isScanning() || this.isStartingScan()) {
      return;
    }

    this.scanError.set('');
    this.isStartingScan.set(true);

    if (!document.getElementById('qr-scanner-viewport')) {
      // Wait a tick for the container to render after a tab switch.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    try {
      const { Html5Qrcode } = await import('html5-qrcode');

      if (!navigator.mediaDevices?.getUserMedia) {
        this.scanError.set('Camera access is not supported in this browser.');
        this.isStartingScan.set(false);
        return;
      }

      this.html5QrCode = new Html5Qrcode('qr-scanner-viewport', {
        verbose: false,
        useBarCodeDetectorIfSupported: true,
      });

      await this.html5QrCode.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // A larger box gives the decoder more pixels per module, which matters
          // for dense 500-char QR codes — a small box crops away detail.
          qrbox: { width: 320, height: 320 },
          videoConstraints: {
            facingMode: 'environment',
            // Request the highest resolution the camera offers; low-res streams
            // (e.g. the 640x480 default) don't have enough detail to resolve
            // the small modules in a dense QR code, causing flaky decodes.
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        (decodedText) => this.onScanSuccess(decodedText),
        () => {
          // Ignore per-frame "no QR found" callbacks; this fires continuously while scanning.
        },
      );

      this.isScanning.set(true);
    } catch (err) {
      this.scanError.set(this.describeCameraError(err));
      this.html5QrCode = null;
    } finally {
      this.isStartingScan.set(false);
    }
  }

  protected async stopScan(): Promise<void> {
    const scanner = this.html5QrCode;
    this.html5QrCode = null;

    if (scanner) {
      try {
        await scanner.stop();
        scanner.clear();
      } catch {
        // Scanner was already stopped/torn down; nothing further to clean up.
      }
    }

    this.isScanning.set(false);
  }

  private onScanSuccess(decodedText: string): void {
    const parsed = parseChunkHeader(decodedText);

    if (!parsed) {
      this.scanError.set('Scanned code is not a recognized QR-batch part. Ignored.');
      return;
    }

    let codes = this.scannedCodes();
    const currentBatchId = codes[0]?.batchId;

    if (currentBatchId && currentBatchId !== parsed.batchId) {
      codes = [];
      this.scannedCodes.set(codes);
      this.flashNewBatch();
    }

    const isDuplicate = codes.some((c) => c.batchId === parsed.batchId && c.chunkIndex === parsed.index);
    if (isDuplicate) {
      this.flashDuplicate();
      return;
    }

    const entry: ScannedCode = {
      id: this.nextScanId++,
      batchId: parsed.batchId,
      chunkIndex: parsed.index,
      chunkTotal: parsed.total,
      payload: parsed.payload,
      scannedAt: new Date(),
    };
    this.scannedCodes.set([...codes, entry]);
    this.scanError.set('');
    this.flashSuccess(entry.id);
  }

  private flashSuccess(id: number): void {
    this.justScannedId.set(id);
    this.beep();
    if (this.isBrowser && navigator.vibrate) {
      navigator.vibrate(80);
    }
    setTimeout(() => {
      if (this.justScannedId() === id) {
        this.justScannedId.set(null);
      }
    }, 900);
  }

  private flashDuplicate(): void {
    this.duplicateFlash.set(true);
    setTimeout(() => this.duplicateFlash.set(false), 900);
  }

  private flashNewBatch(): void {
    this.newBatchFlash.set(true);
    setTimeout(() => this.newBatchFlash.set(false), 1500);
  }

  private beep(): void {
    if (!this.isBrowser) {
      return;
    }
    try {
      const AudioContextCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextCtor();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.12);
      oscillator.onended = () => void ctx.close();
    } catch {
      // Audio feedback is a nice-to-have; ignore failures (e.g. autoplay restrictions).
    }
  }

  private describeCameraError(err: unknown): string {
    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);

    if (name === 'NotAllowedError' || /permission/i.test(message)) {
      return 'Camera access was denied. Please allow camera permissions and try again.';
    }
    if (name === 'NotFoundError' || /no camera/i.test(message)) {
      return 'No camera was found on this device.';
    }
    if (name === 'NotReadableError') {
      return 'The camera is already in use by another application.';
    }
    return 'Unable to access the camera. Please check permissions and try again.';
  }

  protected removeScan(id: number): void {
    this.scannedCodes.set(this.scannedCodes().filter((c) => c.id !== id));
  }

  protected clearAll(): void {
    this.scannedCodes.set([]);
    this.scanError.set('');
  }

  protected async copyText(): Promise<void> {
    if (!this.isBrowser || !this.combinedText()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(this.combinedText());
    } catch {
      this.scanError.set('Failed to copy text to clipboard.');
    }
  }

  protected downloadText(): void {
    if (!this.isBrowser || !this.combinedText()) {
      return;
    }
    const blob = new Blob([this.combinedText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'combined-text.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
