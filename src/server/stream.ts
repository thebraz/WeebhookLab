import type { ServerResponse } from 'node:http';
import type { EventSummary } from '../shared/contracts.js';

export class EventStream {
  private readonly clients = new Map<ServerResponse, string>();
  private readonly heartbeat = setInterval(() => {
    for (const client of this.clients.keys()) this.write(client, ': heartbeat\n\n');
  }, 15_000);

  constructor() { this.heartbeat.unref(); }

  connect(client: ServerResponse, workspaceId: string): void {
    this.clients.set(client, workspaceId);
    client.on('close', () => this.clients.delete(client));
    client.on('error', () => { this.clients.delete(client); client.destroy(); });
    this.write(client, 'retry: 1500\nevent: ready\ndata: {}\n\n');
  }

  publish(event: EventSummary): void {
    const message = `id: ${event.sequence}\nevent: webhook\ndata: ${JSON.stringify(event)}\n\n`;
    for (const [client, workspaceId] of this.clients) if (workspaceId === event.workspaceId) this.write(client, message);
  }

  private write(client: ServerResponse, message: string): void {
    try {
      if (client.destroyed || !client.write(message)) {
        this.clients.delete(client);
        client.destroy();
      }
    } catch { this.clients.delete(client); client.destroy(); }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
  }
}
