#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const help = `WeebhookLab ${version}
Usage: weebhooklab [options]

  --port <port>       HTTP port (default: 5050)
  --host <address>    Network interface (default: 127.0.0.1)
  --workspace <name>  Select or create a local workspace
  --no-open          Do not open the browser
  --help             Show help
  --version          Show version

WEEBHOOKLAB_DATA_DIR sets the local database directory.`;

export function parseArguments(args: string[]) {
  const options = { port: 5050, host: '127.0.0.1', open: true, workspace: undefined as string | undefined, help: false, version: false };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (argument === '--help') options.help = true;
    else if (argument === '--version') options.version = true;
    else if (argument === '--no-open') options.open = false;
    else if (['--port', '--host', '--workspace'].includes(argument)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${argument}.`);
      if (argument === '--port') {
        if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid port. Use an integer between 1 and 65535.');
        options.port = Number(value);
      } else if (argument === '--host') {
        if (value !== 'localhost' && !isIP(value)) throw new Error('Invalid host. Use localhost or an IPv4/IPv6 address.');
        options.host = value;
      } else {
        if (!value.trim() || value.length > 100 || Array.from(value).some((c) => c.charCodeAt(0) < 32)) throw new Error('Workspace name must contain 1 to 100 characters.');
        options.workspace = value.trim();
      }
    } else throw new Error('Unknown option. Use --help.');
  }
  return options;
}

export function dataDirectory(platform = process.platform, env = process.env, home = homedir()): string {
  if (env.WEEBHOOKLAB_DATA_DIR) return resolve(env.WEEBHOOKLAB_DATA_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'WeebhookLab');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'WeebhookLab');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'weebhooklab');
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  const notice = () => console.error(`Open the dashboard manually: ${url}`);
  child.once('error', notice);
  child.once('exit', (code) => { if (code) notice(); });
  child.unref();
}

export async function runCli(databasePath?: string): Promise<void> {
  let options: ReturnType<typeof parseArguments>;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Invalid arguments.'); process.exitCode = 1; return; }
  if (options.help) { console.log(help); return; }
  if (options.version) { console.log(version); return; }
  let app: Awaited<ReturnType<typeof import('./app.js')['createApp']>> | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => app?.server.closeAllConnections(), 5000);
    deadline.unref();
    try { await app?.close(); } catch { console.error('Unable to shut down the server.'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  };
  const onSignal = () => { void shutdown(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    accessSync(fileURLToPath(new URL('../web/index.html', import.meta.url)));
    const { createApp } = await import('./app.js');
    app = createApp({ serveWeb: true, databasePath: databasePath ?? join(dataDirectory(), 'events.sqlite'), allowedHost: options.host });
    if (stopping) { await app.close(); return; }
    await app.listen({ host: options.host, port: options.port });
    if (stopping) return;
    if (options.workspace) {
      const headers = { host: `localhost:${options.port}` };
      const state = (await app.inject({ url: '/api/workspaces', headers })).json<{ workspaces: { id: string; name: string }[] }>();
      const matches = state.workspaces.filter((w) => w.name === options.workspace);
      if (matches.length > 1) throw new Error('WORKSPACE_AMBIGUOUS');
      const workspace = matches[0] ?? (await app.inject({ method: 'POST', url: '/api/workspaces', headers, payload: { name: options.workspace } }));
      const workspaceId = 'id' in workspace ? workspace.id : workspace.statusCode === 201 ? workspace.json<{ id: string }>().id : undefined;
      if (!workspaceId || (await app.inject({ method: 'PUT', url: `/api/workspaces/${workspaceId}/active`, headers })).statusCode !== 200) throw new Error('WORKSPACE_FAILED');
    }
    const displayHost = ['0.0.0.0', '::'].includes(options.host) ? '127.0.0.1' : options.host;
    const url = `http://${isIP(displayHost) === 6 ? `[${displayHost}]` : displayHost}:${options.port}`;
    if (!['localhost', '::1'].includes(options.host) && !/^127\./.test(options.host)) console.error('WARNING: The service may be accessible over the network. The dashboard and captured data have no authentication.');
    console.log(`WeebhookLab ${version}\n\n✓ HTTP server started\n✓ Inspector ready\n✓ Local storage initialized\n\nWebhook endpoint:\n${url}/hooks/*\n\nDashboard:\n${url}`);
    if (options.open) openBrowser(url);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    console.error(code === 'EADDRINUSE' ? `Unable to start WeebhookLab.\nPort ${options.port} is already in use.\nTry: weebhooklab --port ${options.port === 65535 ? 5050 : options.port + 1}`
      : error instanceof Error && error.message === 'WORKSPACE_AMBIGUOUS' ? 'Multiple workspaces have this name. Select one in the dashboard.'
      : 'Unable to start WeebhookLab. Check the network interface, database permissions, and installation files.');
    process.exitCode = 1;
    await shutdown();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
