import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yauzl from "yauzl";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { newId, resolveWithin } from "../lib/security.js";
import { requireScopedAuth, requireScopedMutation } from "./auth.js";

const CHUNK_SIZE = 10 * 1024 * 1024;
const UPLOAD_LOCK_STALE_MS = 30 * 60 * 1000;
const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

interface UploadRow {
  id: string;
  filename: string;
  expected_size: number;
  chunk_size: number;
  total_chunks: number;
  status: "pending" | "complete";
  archive_path: string | null;
  created_at: string;
}

const CreateUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive()
});

export class UploadService {
  private readonly completions = new Map<string, Promise<UploadRow>>();
  private readonly activeChunkWrites = new Set<string>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database
  ) {
    this.cleanupAbandonedUploads();
    this.cleanupTimer = setInterval(() => this.cleanupAbandonedUploads(), UPLOAD_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }

  create(filename: string, size: number): UploadRow {
    if (size > this.config.MAX_UPLOAD_MB * 1024 * 1024) {
      throw new HttpUploadTooLargeError(this.config.MAX_UPLOAD_MB);
    }
    if (!filename.toLowerCase().endsWith(".zip")) throw badRequest("Nur ZIP-Archive werden akzeptiert", "ZIP_REQUIRED");
    const id = newId("upl");
    const row: UploadRow = {
      id,
      filename: path.basename(filename),
      expected_size: size,
      chunk_size: CHUNK_SIZE,
      total_chunks: Math.ceil(size / CHUNK_SIZE),
      status: "pending",
      archive_path: null,
      created_at: new Date().toISOString()
    };
    this.database.sqlite.prepare(`
      INSERT INTO uploads (id, filename, expected_size, chunk_size, total_chunks, status, archive_path, created_at)
      VALUES (@id, @filename, @expected_size, @chunk_size, @total_chunks, @status, @archive_path, @created_at)
    `).run(row);
    fs.mkdirSync(this.managedPaths(row).chunkDirectory, { recursive: true, mode: 0o700 });
    return row;
  }

  get(id: string): UploadRow | undefined {
    return this.database.sqlite.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as UploadRow | undefined;
  }

  remove(id: string): boolean {
    const removeUpload = this.database.sqlite.transaction(() => {
      const upload = this.get(id);
      if (!upload) return false;
      if (this.completions.has(id)) throw conflict("Upload wird gerade abgeschlossen", "UPLOAD_COMPLETION_ACTIVE");
      if (this.activeChunkWrites.has(id)) throw conflict("Upload wird gerade verändert", "UPLOAD_MUTATION_ACTIVE");
      const locked = this.database.sqlite.prepare("SELECT 1 FROM upload_locks WHERE upload_id = ?").get(id);
      if (locked) throw conflict("Upload wird gerade verändert", "UPLOAD_MUTATION_ACTIVE");
      const referenced = this.database.sqlite.prepare(`
        SELECT 1 FROM projects WHERE source_archive = ?
        UNION ALL
        SELECT 1 FROM deployments
        JOIN projects ON projects.id = deployments.project_id
        WHERE projects.source_type = 'upload' AND deployments.source_ref = ?
        LIMIT 1
      `).get(upload.archive_path, upload.id);
      if (referenced) throw conflict("Der Upload wird bereits von einem Projekt verwendet", "UPLOAD_IN_USE");

      const paths = this.managedPaths(upload);
      const removed = this.database.sqlite.prepare("DELETE FROM uploads WHERE id = ?").run(id);
      if (removed.changes !== 1) return false;
      // Keep filesystem cleanup inside the immediate transaction. If it fails,
      // SQLite restores the row and a later retry can safely finish cleanup.
      if (upload.status === "pending") {
        // Remove auxiliary completion output first and the resumable chunks last.
        fs.rmSync(paths.sourceDirectory, { recursive: true, force: true });
        fs.rmSync(paths.chunkDirectory, { recursive: true, force: true });
      } else {
        // Completed uploads no longer need chunks; preserve the archive until
        // the final filesystem operation in case cleanup must be retried.
        fs.rmSync(paths.chunkDirectory, { recursive: true, force: true });
        fs.rmSync(paths.sourceDirectory, { recursive: true, force: true });
      }
      return true;
    });
    // Project creation/source replacement also uses an immediate transaction.
    // Serializing writers makes the reference check and deletion one atomic gate.
    return removeUpload.immediate();
  }

  async putChunk(id: string, index: number, body: Buffer): Promise<void> {
    const upload = this.get(id);
    if (!upload || upload.status !== "pending") throw notFound("Upload nicht gefunden oder bereits abgeschlossen", "UPLOAD_NOT_FOUND");
    if (!Number.isInteger(index) || index < 0 || index >= upload.total_chunks) throw badRequest("Ungültiger Chunk-Index", "INVALID_CHUNK");
    const expectedLength = index === upload.total_chunks - 1
      ? upload.expected_size - index * upload.chunk_size
      : upload.chunk_size;
    if (body.length !== expectedLength) {
      throw badRequest(`Chunk hat ${body.length} Bytes, erwartet wurden ${expectedLength}`, "INVALID_CHUNK_SIZE");
    }
    const lockTimestamp = new Date().toISOString();
    const claimed = this.database.sqlite.prepare("INSERT OR IGNORE INTO upload_locks (upload_id, started_at) VALUES (?, ?)")
      .run(id, lockTimestamp);
    if (claimed.changes === 0) throw conflict("Upload wird gerade verändert oder abgeschlossen", "UPLOAD_MUTATION_ACTIVE");
    const temporaryPath = path.join(this.chunkDirectory(id), `${index}.${randomUUID()}.tmp`);
    this.activeChunkWrites.add(id);
    try {
      const current = this.get(id);
      if (!current || current.status !== "pending") throw notFound("Upload nicht gefunden oder bereits abgeschlossen", "UPLOAD_NOT_FOUND");
      await fs.promises.writeFile(temporaryPath, body, { mode: 0o600, flag: "wx" });
      await fs.promises.rename(temporaryPath, path.join(this.chunkDirectory(id), `${index}.part`));
    } finally {
      this.activeChunkWrites.delete(id);
      await fs.promises.rm(temporaryPath, { force: true });
      this.database.sqlite.prepare("DELETE FROM upload_locks WHERE upload_id = ? AND started_at = ?").run(id, lockTimestamp);
    }
  }

  async complete(id: string): Promise<UploadRow> {
    const inProgress = this.completions.get(id);
    if (inProgress) return inProgress;
    const completion = this.completeWithLock(id);
    this.completions.set(id, completion);
    try {
      return await completion;
    } finally {
      this.completions.delete(id);
    }
  }

  private async completeWithLock(id: string): Promise<UploadRow> {
    const claimed = this.database.sqlite.prepare("INSERT OR IGNORE INTO upload_locks (upload_id, started_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
    if (claimed.changes === 0) {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const upload = this.get(id);
        if (!upload) throw notFound("Upload nicht gefunden", "UPLOAD_NOT_FOUND");
        if (upload.status === "complete") return upload;
        const lock = this.database.sqlite.prepare("SELECT started_at FROM upload_locks WHERE upload_id = ?").get(id) as { started_at: string } | undefined;
        if (!lock) return this.completeWithLock(id);
        if (
          Date.now() - new Date(lock.started_at).getTime() > UPLOAD_LOCK_STALE_MS
          && !this.activeChunkWrites.has(id)
        ) {
          const released = this.database.sqlite.prepare("DELETE FROM upload_locks WHERE upload_id = ? AND started_at = ?").run(id, lock.started_at);
          if (released.changes === 1) return this.completeWithLock(id);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw conflict("Upload wird bereits abgeschlossen", "UPLOAD_COMPLETION_ACTIVE");
    }

    try {
      return await this.completeOnce(id);
    } finally {
      this.database.sqlite.prepare("DELETE FROM upload_locks WHERE upload_id = ?").run(id);
    }
  }

  private async completeOnce(id: string): Promise<UploadRow> {
    const upload = this.get(id);
    if (!upload) throw notFound("Upload nicht gefunden", "UPLOAD_NOT_FOUND");
    if (upload.status === "complete") return upload;

    const finalDirectory = this.uploadDirectory(id);
    const temporaryArchive = path.join(this.chunkDirectory(id), `source.${randomUUID()}.zip.tmp`);
    fs.mkdirSync(finalDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(temporaryArchive, Buffer.alloc(0), { mode: 0o600 });
    let total = 0;
    for (let index = 0; index < upload.total_chunks; index += 1) {
      const chunkPath = path.join(this.chunkDirectory(id), `${index}.part`);
      const stat = await fs.promises.stat(chunkPath).catch(() => null);
      if (!stat) throw conflict(`Chunk ${index + 1}/${upload.total_chunks} fehlt`, "CHUNK_MISSING");
      total += stat.size;
      await fs.promises.appendFile(temporaryArchive, await fs.promises.readFile(chunkPath));
    }
    if (total !== upload.expected_size) {
      await fs.promises.rm(temporaryArchive, { force: true });
      throw badRequest(`Uploadgröße stimmt nicht: ${total} statt ${upload.expected_size} Bytes`, "UPLOAD_SIZE_MISMATCH");
    }

    await validateZipArchive(temporaryArchive, Math.min(this.config.MAX_UPLOAD_MB * 5 * 1024 * 1024, 2 * 1024 * 1024 * 1024));
    const archivePath = path.join(finalDirectory, "source.zip");
    await fs.promises.rename(temporaryArchive, archivePath);
    this.database.sqlite.prepare("UPDATE uploads SET status = 'complete', archive_path = ? WHERE id = ?").run(archivePath, id);
    await fs.promises.rm(this.chunkDirectory(id), { recursive: true, force: true }).catch(() => undefined);
    return this.get(id) as UploadRow;
  }

  consume(id: string): UploadRow {
    const upload = this.get(id);
    if (!upload || upload.status !== "complete" || !upload.archive_path) throw conflict("Upload ist nicht vollständig", "UPLOAD_INCOMPLETE");
    const expectedArchive = this.managedPaths(upload).archivePath;
    const archive = path.resolve(upload.archive_path);
    const stat = archive === expectedArchive ? fs.lstatSync(archive, { throwIfNoEntry: false }) : undefined;
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw conflict("Das Upload-Archiv ist nicht mehr verfügbar", "UPLOAD_ARCHIVE_MISSING");
    }
    return upload;
  }

  private chunkDirectory(id: string): string {
    return resolveWithin(this.config.sourcesDir, path.join(".chunks", this.managedUploadId(id)));
  }

  private uploadDirectory(id: string): string {
    return resolveWithin(this.config.sourcesDir, this.managedUploadId(id));
  }

  private managedUploadId(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      throw conflict("Upload-ID verweist nicht auf einen verwalteten Pfad", "UPLOAD_PATH_INVALID");
    }
    return id;
  }

  private managedPaths(upload: Pick<UploadRow, "id" | "archive_path">): {
    sourceDirectory: string;
    chunkDirectory: string;
    archivePath: string;
  } {
    const sourceDirectory = this.uploadDirectory(upload.id);
    const chunkDirectory = this.chunkDirectory(upload.id);
    const archivePath = resolveWithin(sourceDirectory, "source.zip");
    if (upload.archive_path && path.resolve(upload.archive_path) !== archivePath) {
      throw conflict("Upload-Archiv liegt nicht in einem verwalteten Quellverzeichnis", "UPLOAD_PATH_INVALID");
    }
    return { sourceDirectory, chunkDirectory, archivePath };
  }

  private cleanupAbandonedUploads(): void {
    const lockCutoff = new Date(Date.now() - UPLOAD_LOCK_STALE_MS).toISOString();
    const uploadCutoff = new Date(Date.now() - UPLOAD_RETENTION_MS).toISOString();
    const staleLocks = this.database.sqlite.prepare(
      "SELECT upload_id, started_at FROM upload_locks WHERE started_at < ?"
    ).all(lockCutoff) as Array<{ upload_id: string; started_at: string }>;
    for (const lock of staleLocks) {
      if (this.completions.has(lock.upload_id) || this.activeChunkWrites.has(lock.upload_id)) continue;
      this.database.sqlite.prepare(
        "DELETE FROM upload_locks WHERE upload_id = ? AND started_at = ?"
      ).run(lock.upload_id, lock.started_at);
    }
    const abandoned = this.database.sqlite.prepare(`
      SELECT uploads.id FROM uploads
      WHERE uploads.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM upload_locks WHERE upload_id = uploads.id)
        AND NOT EXISTS (
          SELECT 1 FROM projects
          WHERE uploads.archive_path IS NOT NULL AND source_archive = uploads.archive_path
        )
        AND NOT EXISTS (
          SELECT 1 FROM deployments
          JOIN projects ON projects.id = deployments.project_id
          WHERE projects.source_type = 'upload' AND deployments.source_ref = uploads.id
        )
    `).all(uploadCutoff) as Array<{ id: string }>;
    for (const upload of abandoned) {
      try {
        // Re-check references and locks transactionally. Cleanup candidates may
        // have changed between the list query and this removal attempt.
        this.remove(upload.id);
      } catch {
        // A concurrent mutation/reference or a corrupt unmanaged path must fail
        // closed for this row without preventing cleanup of other uploads.
      }
    }
  }
}

export function registerUploadRoutes(app: FastifyInstance, service: UploadService): void {
  app.post<{ Body: unknown }>("/api/uploads", { preHandler: requireScopedMutation("uploads:write") }, async (request, reply) => {
    const input = CreateUploadSchema.parse(request.body);
    const upload = service.create(input.filename, input.size);
    await reply.code(201).send({ id: upload.id, uploadId: upload.id, chunkSize: upload.chunk_size, totalChunks: upload.total_chunks });
  });

  app.put<{ Params: { id: string; index: string }; Body: Buffer }>(
    "/api/uploads/:id/chunks/:index",
    { preHandler: requireScopedMutation("uploads:write") },
    async (request) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest("Chunk muss Binärdaten enthalten", "BINARY_CHUNK_REQUIRED");
      await service.putChunk(request.params.id, Number(request.params.index), request.body);
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string } }>("/api/uploads/:id/complete", { preHandler: requireScopedMutation("uploads:write") }, async (request) => {
    const upload = await service.complete(request.params.id);
    return { uploadId: upload.id, filename: upload.filename, size: upload.expected_size };
  });

  app.get<{ Params: { id: string } }>("/api/uploads/:id", { preHandler: requireScopedAuth("uploads:write") }, async (request, reply) => {
    const upload = service.get(request.params.id);
    if (!upload) return reply.code(404).send({ error: "Upload nicht gefunden", code: "NOT_FOUND" });
    return { id: upload.id, status: upload.status, filename: upload.filename, size: upload.expected_size };
  });

  app.delete<{ Params: { id: string } }>("/api/uploads/:id", { preHandler: requireScopedMutation("uploads:write") }, async (request, reply) => {
    if (!service.remove(request.params.id)) {
      return reply.code(404).send({ error: "Upload nicht gefunden", code: "NOT_FOUND" });
    }
    return reply.code(204).send();
  });
}

export function validateZipArchive(archivePath: string, maximumUncompressedBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(badRequest("ZIP-Archiv kann nicht gelesen werden", "INVALID_ZIP"));
        return;
      }
      let entries = 0;
      let totalUncompressed = 0;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("entry", (entry) => {
        entries += 1;
        const normalized = entry.fileName.replaceAll("\\", "/");
        const segments = normalized.split("/");
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        totalUncompressed += entry.uncompressedSize;
        if (entries > 100_000) return fail(badRequest("ZIP enthält zu viele Dateien", "ZIP_TOO_MANY_FILES"));
        if (totalUncompressed > maximumUncompressedBytes) return fail(badRequest("ZIP ist entpackt zu groß", "ZIP_BOMB"));
        if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || segments.includes("..")) {
          return fail(badRequest("ZIP enthält einen unsicheren Dateipfad", "ZIP_UNSAFE_PATH"));
        }
        if (mode === 0o120000 || mode === 0o020000 || mode === 0o060000) {
          return fail(badRequest("ZIP enthält Links oder Gerätedateien", "ZIP_UNSAFE_ENTRY"));
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 1000) {
          return fail(badRequest("ZIP enthält eine verdächtig stark komprimierte Datei", "ZIP_BOMB"));
        }
        zip.readEntry();
      });
      zip.once("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zip.once("error", (error) => fail(error));
      zip.readEntry();
    });
  });
}

class HttpUploadTooLargeError extends HttpError {
  constructor(maximumMegabytes: number) {
    super(413, "UPLOAD_TOO_LARGE", `Upload ist größer als ${maximumMegabytes} MB`);
  }
}
