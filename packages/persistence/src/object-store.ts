import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { NonEmptyStringSchema } from "@openstrat/domain";

export const ObjectRefSchema = NonEmptyStringSchema;

export interface PutObjectOptions {
  overwrite?: boolean;
}

export interface ObjectStore {
  putBytes(ref: string, bytes: Uint8Array, options?: PutObjectOptions): void;
  getBytes(ref: string): Buffer;
  putJson(ref: string, value: unknown, options?: PutObjectOptions): void;
  getJson<T = unknown>(ref: string): T;
  exists(ref: string): boolean;
}

export class FileObjectStore implements ObjectStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    mkdirSync(this.rootDir, { recursive: true });
  }

  putBytes(ref: string, bytes: Uint8Array, options: PutObjectOptions = {}): void {
    const path = this.resolveRef(ref);
    if (existsSync(path) && options.overwrite !== true) {
      throw new Error(`Object already exists: ${ref}`);
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  getBytes(ref: string): Buffer {
    return readFileSync(this.resolveRef(ref));
  }

  putJson(ref: string, value: unknown, options: PutObjectOptions = {}): void {
    this.putBytes(ref, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), options);
  }

  getJson<T = unknown>(ref: string): T {
    return JSON.parse(this.getBytes(ref).toString("utf8")) as T;
  }

  exists(ref: string): boolean {
    return existsSync(this.resolveRef(ref));
  }

  private resolveRef(ref: string): string {
    const parsedRef = ObjectRefSchema.parse(ref);
    if (parsedRef.includes("\0") || isAbsolute(parsedRef)) {
      throw new Error(`Invalid object ref: ${ref}`);
    }

    const path = resolve(this.rootDir, parsedRef);
    const pathFromRoot = relative(this.rootDir, path);
    if (
      pathFromRoot === "" ||
      pathFromRoot.startsWith("..") ||
      isAbsolute(pathFromRoot)
    ) {
      throw new Error(`Object ref escapes store root: ${ref}`);
    }

    z.string().min(1).parse(pathFromRoot);
    return path;
  }
}
