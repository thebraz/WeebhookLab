const url = new URL(process.argv[2] || 'http://127.0.0.1:5050/hooks/demo');
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.startsWith('/hooks/')) throw new Error('Use um endpoint HTTP local /hooks/… .');
for (const [index, event] of ['payment.created', 'payment.failed', 'user.created'].entries()) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `demo_${index + 1}`, event, data: { example: true, amount: 4200, currency: 'BRL' } }), signal: AbortSignal.timeout(15_000) });
  console.log(`${event}: HTTP ${response.status}`);
  if (!response.ok) process.exitCode = 1;
}
