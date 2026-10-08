import type { Header, ReplayExecution, ReplayRequest, WebhookEvent } from './contracts.js';
import type { TransformOperation } from './json.js';
export const DEFAULT_WORKSPACE = '00000000-0000-4000-8000-000000000001';
export interface Workspace { id: string; name: string; createdAt: string }
export interface SavedRequest { id: string; name: string; request: ReplayRequest }
export interface MockResponse { status: number; headers: Header[]; body: string; delayMs: number; maxDelayMs: number }
export interface MockProfile { id: string; name: string; response: MockResponse }
export interface MockBinding { id: string; path: string; profileId: string }
export interface TransformProfile { id: string; name: string; operations: TransformOperation[] }
export interface WorkspaceConfiguration { requests: SavedRequest[]; mocks: MockProfile[]; bindings: MockBinding[]; transformations: TransformProfile[] }
export interface WorkspaceExport extends WorkspaceConfiguration {
  format: 'weebhooklab-workspace'; version: 1; workspace: Workspace; exportedAt: string; redacted: boolean;
  events: WebhookEvent[]; replays: ReplayExecution[];
}
export type DocumentKind = 'requests' | 'mocks' | 'bindings' | 'transformations';
export type WorkspaceDocument = SavedRequest | MockProfile | MockBinding | TransformProfile;
export interface EndpointOverview { path: string; count: number; method: string; recent: import('./contracts.js').EventSummary; profile: MockProfile | null }
