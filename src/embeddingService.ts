import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pipeline, env } from '@xenova/transformers';
import * as ort from 'onnxruntime-web';
import { EmbeddingMode, EchoBrainPluginSettings } from './types.js';

// Configure WebAssembly ONNX engine
env.backends.onnx = ort;
env.remoteHost = 'https://hf-mirror.com/';

export interface CachedVector {
  mtime: number;
  vector: number[];
}

const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx'
];

export class PluginEmbeddingService {
  private vaultBasePath: string;
  private settings: EchoBrainPluginSettings;
  private extractor: any = null;
  private vectorCache: Map<string, CachedVector> = new Map();
  private cacheFilePath: string;
  private modelsDirPath: string;
  private isCacheDirty: boolean = false;
  private isDownloading: boolean = false;

  constructor(vaultBasePath: string, settings: EchoBrainPluginSettings) {
    this.vaultBasePath = vaultBasePath;
    this.settings = settings;
    const cacheDir = path.join(vaultBasePath, '.echobrain');
    this.cacheFilePath = path.join(cacheDir, 'embeddings-cache.json');
    this.modelsDirPath = path.join(cacheDir, 'models');
    this.loadCache();
  }

  public updateSettings(settings: EchoBrainPluginSettings) {
    this.settings = settings;
    if (settings.embeddingMode !== 'local') {
      this.extractor = null;
    }
  }

  public isAvailable(): boolean {
    if (this.settings.embeddingMode === 'none') return false;
    if (this.settings.embeddingMode === 'api') {
      return Boolean(this.settings.apiBaseUrl);
    }
    if (this.settings.embeddingMode === 'local') {
      return this.extractor !== null || this.isLocalModelComplete();
    }
    return false;
  }

  public isLocalModelComplete(): boolean {
    const targetDir = path.join(this.modelsDirPath, 'Xenova', 'bge-small-zh-v1.5');
    for (const f of MODEL_FILES) {
      const full = path.join(targetDir, f);
      if (!fsSync.existsSync(full)) return false;
      const stat = fsSync.statSync(full);
      if (stat.size === 0) return false;
    }
    // Also check wasm runtime
    const wasmFile = path.join(this.modelsDirPath, 'wasm', 'ort-wasm-simd.wasm');
    if (!fsSync.existsSync(wasmFile)) return false;

    return true;
  }

  /**
   * Load cache from disk
   */
  private async loadCache(): Promise<void> {
    try {
      if (fsSync.existsSync(this.cacheFilePath)) {
        const data = await fs.readFile(this.cacheFilePath, 'utf-8');
        const json = JSON.parse(data);
        for (const [k, v] of Object.entries(json)) {
          this.vectorCache.set(k, v as CachedVector);
        }
      }
    } catch (e) {
      console.warn('[EchoBrain Embedding] Cache load error:', e);
    }
  }

  public async saveCache(): Promise<void> {
    if (!this.isCacheDirty) return;
    try {
      const cacheDir = path.dirname(this.cacheFilePath);
      if (!fsSync.existsSync(cacheDir)) {
        await fs.mkdir(cacheDir, { recursive: true });
      }
      const obj: Record<string, CachedVector> = {};
      for (const [k, v] of this.vectorCache.entries()) {
        obj[k] = v;
      }
      await fs.writeFile(this.cacheFilePath, JSON.stringify(obj), 'utf-8');
      this.isCacheDirty = false;
    } catch (e) {
      console.error('[EchoBrain Embedding] Cache save error:', e);
    }
  }

  /**
   * Initialize local WebAssembly ONNX pipeline if local model is downloaded
   */
  public async initLocalPipeline(): Promise<boolean> {
    if (this.extractor) return true;
    if (!this.isLocalModelComplete()) return false;

    try {
      const ortActual = (ort as any).default || ort;
      const wasmDir = path.join(this.modelsDirPath, 'wasm') + path.sep;
      if (ortActual?.env?.wasm) {
        ortActual.env.wasm.wasmPaths = wasmDir;
        ortActual.env.wasm.numThreads = 1;
      }
      env.backends.onnx = ortActual;
      env.localModelPath = this.modelsDirPath;
      env.allowRemoteModels = false;
      this.extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', {
        quantized: true
      });
      console.log('[EchoBrain Embedding] Local WASM ONNX model initialized successfully.');
      return true;
    } catch (err: any) {
      console.error('[EchoBrain Embedding] Failed to init local ONNX pipeline:', err);
      this.extractor = null;
      return false;
    }
  }

  /**
   * Download the 40MB bge-small-zh model on-demand with progress callback using streaming fetch
   */
  public async downloadLocalModel(
    onProgress: (percent: number, statusText: string) => void
  ): Promise<boolean> {
    if (this.isDownloading) return false;
    this.isDownloading = true;

    try {
      const targetDir = path.join(this.modelsDirPath, 'Xenova', 'bge-small-zh-v1.5');
      await fs.mkdir(path.join(targetDir, 'onnx'), { recursive: true });
      const wasmDir = path.join(this.modelsDirPath, 'wasm');
      await fs.mkdir(wasmDir, { recursive: true });

      // 1. Download wasm runtime file first if not exists
      const wasmDest = path.join(wasmDir, 'ort-wasm-simd.wasm');
      if (!fsSync.existsSync(wasmDest) || fsSync.statSync(wasmDest).size === 0) {
        onProgress(5, '正在下载 WebAssembly 运行环境 (ort-wasm)...');
        const wasmUrl = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm-simd.wasm';
        await this.downloadSingleFile(wasmUrl, wasmDest);
      }

      // 2. Download model files
      const baseUrl = 'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/';
      let totalFiles = MODEL_FILES.length;

      for (let i = 0; i < totalFiles; i++) {
        const fileRel = MODEL_FILES[i];
        const destFile = path.join(targetDir, fileRel);
        const fileUrl = `${baseUrl}${fileRel}`;

        const basePercent = 10 + Math.floor((i / totalFiles) * 85);
        onProgress(basePercent, `正在下载 [${i + 1}/${totalFiles}] ${path.basename(fileRel)}...`);

        await this.downloadSingleFile(fileUrl, destFile, (received, total) => {
          if (total > 0) {
            const fileFraction = received / total;
            const currentPercent = Math.min(98, Math.floor(basePercent + fileFraction * (85 / totalFiles)));
            const mbReceived = (received / (1024 * 1024)).toFixed(1);
            const mbTotal = (total / (1024 * 1024)).toFixed(1);
            onProgress(
              currentPercent,
              `下载中 [${i + 1}/${totalFiles}] ${path.basename(fileRel)} (${mbReceived}MB / ${mbTotal}MB)`
            );
          }
        });
      }

      onProgress(100, '模型下载完成！正在初始化向量引擎...');
      const ok = await this.initLocalPipeline();
      this.isDownloading = false;
      return ok;
    } catch (err: any) {
      this.isDownloading = false;
      console.error('[EchoBrain Embedding] Download failed:', err);
      throw err;
    }
  }

  /**
   * Stream download single file with modern fetch (automatically follows 301/302/307 redirects)
   */
  private async downloadSingleFile(
    urlStr: string,
    destPath: string,
    onByteProgress?: (receivedBytes: number, totalBytes: number) => void
  ): Promise<void> {
    const res = await fetch(urlStr, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EchoBrain-Downloader'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} when downloading ${path.basename(destPath)}`);
    }

    const totalBytes = Number(res.headers.get('content-length')) || 0;
    let receivedBytes = 0;

    const dir = path.dirname(destPath);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    const fileStream = fsSync.createWriteStream(destPath);

    if (res.body && typeof (res.body as any).getReader === 'function') {
      const reader = (res.body as any).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          fileStream.write(Buffer.from(value));
          if (onByteProgress && totalBytes > 0) {
            onByteProgress(receivedBytes, totalBytes);
          }
        }
      }
      fileStream.end();
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', () => resolve());
        fileStream.on('error', reject);
      });
    } else {
      const arrayBuffer = await res.arrayBuffer();
      await fs.writeFile(destPath, Buffer.from(arrayBuffer));
      if (onByteProgress && totalBytes > 0) {
        onByteProgress(totalBytes, totalBytes);
      }
    }
  }

  /**
   * Compute normalized vector for text
   */
  public async getEmbedding(text: string): Promise<number[] | null> {
    if (!text || !text.trim() || !this.isAvailable()) return null;

    if (this.settings.embeddingMode === 'api') {
      return this.fetchApiEmbedding(text);
    }

    if (this.settings.embeddingMode === 'local') {
      if (!this.extractor) {
        await this.initLocalPipeline();
      }
      if (!this.extractor) return null;

      try {
        const clean = text.slice(0, 1000);
        const output = await this.extractor(clean, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
      } catch (err) {
        console.error('[EchoBrain Embedding] Local inference error:', err);
        return null;
      }
    }

    return null;
  }

  /**
   * Fetch embedding from standard OpenAI-compatible /v1/embeddings endpoint
   */
  private async fetchApiEmbedding(text: string): Promise<number[] | null> {
    try {
      const cleanUrl = this.settings.apiBaseUrl.replace(/\/+$/, '');
      const endpoint = cleanUrl.endsWith('/embeddings') ? cleanUrl : `${cleanUrl}/embeddings`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (this.settings.apiKey) {
        headers['Authorization'] = `Bearer ${this.settings.apiKey}`;
      }

      const body = JSON.stringify({
        model: this.settings.apiModel || 'text-embedding-3-small',
        input: text.slice(0, 2000)
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      if (data?.data?.[0]?.embedding) {
        return data.data[0].embedding;
      }
      return null;
    } catch (err: any) {
      console.error('[EchoBrain Embedding] API request error:', err.message);
      return null;
    }
  }

  public async getDocumentVector(
    relativePath: string,
    content: string,
    mtime: number
  ): Promise<number[] | null> {
    const cached = this.vectorCache.get(relativePath);
    if (cached && cached.mtime === mtime && cached.vector?.length > 0) {
      return cached.vector;
    }

    const vector = await this.getEmbedding(content);
    if (vector) {
      this.vectorCache.set(relativePath, { mtime, vector });
      this.isCacheDirty = true;
    }
    return vector;
  }

  public cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
