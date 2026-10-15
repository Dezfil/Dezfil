import type { IncomingMessage, Server, ServerResponse } from "node:http";
export const ORDINARY_RECEIVE_MS: number;
export const UPLOAD_STALL_MS: number;
export const REFUSAL_DELIVERY_MS: number;
export const SERVER_RECEIVE_MS: number;
export interface ReceptionRefusal extends Error { code: string | null; status: number }
export interface UploadReception {
  refuse(error: ReceptionRefusal): void;
  progress(): void;
  endBody(): void;
  complete(): void;
  readonly failure?: ReceptionRefusal;
}
export interface NativeReception {
  admit(budgetMs: number, remedy: string, onRefusal: (error: ReceptionRefusal) => void): UploadReception | undefined;
}
export function createUploadClock(budgetMs: number, remedy: string, onRefusal: (error: ReceptionRefusal) => void): UploadReception;
export function nativeUploadReception(budgetMs: number, remedy: string, onRefusal: (error: ReceptionRefusal) => void): UploadReception | undefined;
export function receptionIterator(request: IncomingMessage, stops: Set<() => void>): AsyncIterableIterator<Buffer>;
export function installReception(server: Server, request: IncomingMessage, response: ServerResponse, upload: boolean): NativeReception | undefined;
export function withNativeReception<T>(owner: NativeReception, work: () => T): T;
