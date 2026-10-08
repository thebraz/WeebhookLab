import { createServer } from 'vite';
import { createApp } from '../src/server/app.js';

let app: ReturnType<typeof createApp> | undefined;
let web: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  app = createApp({ development: true });
  web = await createServer();
  await app.listen({ host: '127.0.0.1', port: 5050 });
  await web.listen();
  console.log('WeebhookLab: http://localhost:5173 · captura: http://localhost:5050/hooks/test');
} catch (error) {
  console.error('Falha ao iniciar WeebhookLab:', error);
  await Promise.allSettled([app?.close(), web?.close()]);
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void Promise.allSettled([web?.close(), app?.close()]); });
}
