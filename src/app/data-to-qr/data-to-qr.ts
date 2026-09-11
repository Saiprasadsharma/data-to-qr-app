import { Component, computed, signal } from '@angular/core';
import * as QRCode from 'qrcode';

interface QrChunk {
  index: number;
  text: string;
  dataUrl: string;
}

const CHUNK_SIZE = 500;

@Component({
  selector: 'app-data-to-qr',
  imports: [],
  templateUrl: './data-to-qr.html',
  styleUrl: './data-to-qr.scss',
})
export class DataToQr {
  protected readonly inputText = signal('');
  protected readonly qrChunks = signal<QrChunk[]>([]);
  protected readonly isGenerating = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly charCount = computed(() => this.inputText().length);
  protected readonly chunkCount = computed(() => Math.ceil(this.charCount() / CHUNK_SIZE));

  protected onInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.inputText.set(target.value);
  }

  protected async generate(): Promise<void> {
    const text = this.inputText();
    this.errorMessage.set('');

    if (!text.trim()) {
      this.errorMessage.set('Please enter some text to generate QR codes.');
      this.qrChunks.set([]);
      return;
    }

    this.isGenerating.set(true);

    try {
      const chunks = text.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'gs')) ?? [];
      this.qrChunks.set(
        await Promise.all(
          chunks.map(async (chunk, i): Promise<QrChunk> => ({
            index: i + 1,
            text: chunk,
            dataUrl: await QRCode.toDataURL(chunk, { errorCorrectionLevel: 'M', margin: 1, width: 256 }),
          })),
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
  }
}
