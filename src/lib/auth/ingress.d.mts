export interface Ingress {
  peer: string; source: string; origin: string; host: string;
  scheme: "http" | "https"; port: string; secure: boolean;
}
export interface IngressRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string; encrypted?: boolean };
}
export function normalizeAddress(value: string): string;
export function trustedPeers(setting?: string): (address: string) => boolean;
export function canonicalIngress(request: IngressRequest, trusted?: (address: string) => boolean): Ingress;
export function requireIngress(headers?: Headers): Ingress;
export function installIngress(): void;
