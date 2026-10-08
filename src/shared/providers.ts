import type { Header } from './contracts.js';
export type Provider = 'github' | 'stripe' | 'shopify' | 'discord' | 'generic' | 'unknown';
export interface Detection { provider: Provider; confidence: 'high' | 'medium' | 'low'; evidence: string[]; eventType?: string; signatureVerified: false }
export interface ProviderInput { headers: Header[]; payload?: unknown }
export type ProviderDetector = (input: ProviderInput) => Detection | null;
// Historical detection metadata stays intact in SQLite.
export function providerEvidenceText(evidence: string): string {
  const historical: Record<string, string> = {
    'Stripe-Signature presente (não verificada)': 'Stripe-Signature present (not verified)',
    'X-Shopify-Hmac-Sha256 presente (não verificada)': 'X-Shopify-Hmac-Sha256 present (not verified)',
    'X-Signature-Ed25519 presente (não verificada)': 'X-Signature-Ed25519 present (not verified)',
    'Estrutura de evento Stripe': 'Stripe event structure',
    'Estrutura de interação Discord': 'Discord interaction structure',
    'Cliente HTTP genérico': 'Generic HTTP client',
    'Sem indicadores suficientes': 'Insufficient indicators',
  };
  return Object.hasOwn(historical, evidence) ? historical[evidence]! : evidence.replace(/^Indicadores conflitantes: /, 'Conflicting indicators: ');
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const detect = (provider: Provider, evidence: string[], high: boolean, eventType?: string): Detection => ({ provider, evidence, confidence: high ? 'high' : 'medium', ...(eventType ? { eventType: eventType.slice(0, 200) } : {}), signatureVerified: false });
const header = (headers: Header[], name: string) => headers.find(([key]) => key.toLowerCase() === name)?.[1];

export const providerDetectors: ProviderDetector[] = [
  ({ headers }) => {
    const event = header(headers, 'x-github-event'); const agent = header(headers, 'user-agent')?.startsWith('GitHub-Hookshot/');
    const evidence = [event ? 'X-GitHub-Event' : '', agent ? 'GitHub-Hookshot User-Agent' : '', header(headers, 'x-github-delivery') ? 'X-GitHub-Delivery' : ''].filter(Boolean);
    return evidence.length ? detect('github', evidence, evidence.length >= 2, event) : null;
  },
  ({ headers, payload }) => {
    const p = record(payload); const signature = header(headers, 'stripe-signature');
    const shape = p.object === 'event' && typeof p.id === 'string' && p.id.startsWith('evt_') && typeof p.type === 'string' && !!record(p.data).object;
    return signature || shape ? detect('stripe', [signature ? 'Stripe-Signature present (not verified)' : '', shape ? 'Stripe event structure' : ''].filter(Boolean), !!signature && !!shape, shape ? p.type as string : undefined) : null;
  },
  ({ headers }) => {
    const topic = header(headers, 'x-shopify-topic'); const signature = header(headers, 'x-shopify-hmac-sha256'); const shop = header(headers, 'x-shopify-shop-domain');
    const evidence = [topic ? 'X-Shopify-Topic' : '', signature ? 'X-Shopify-Hmac-Sha256 present (not verified)' : '', shop ? 'X-Shopify-Shop-Domain' : ''].filter(Boolean);
    return evidence.length ? detect('shopify', evidence, evidence.length >= 2, topic) : null;
  },
  ({ headers, payload }) => {
    const signature = header(headers, 'x-signature-ed25519'); const timestamp = header(headers, 'x-signature-timestamp'); const p = record(payload);
    return signature && timestamp && Number.isInteger(p.type) && typeof p.application_id === 'string'
      ? detect('discord', ['X-Signature-Ed25519 present (not verified)', 'X-Signature-Timestamp', 'Discord interaction structure'], true, `interaction.${String(p.type)}`) : null;
  },
];

export function detectProvider(input: ProviderInput, detectors = providerDetectors): Detection {
  const candidates = detectors.map((detector) => detector(input)).filter((value): value is Detection => !!value);
  if (candidates.length > 1) return { provider: 'unknown', confidence: 'low', evidence: ['Conflicting indicators: ' + candidates.map((c) => c.provider).join(', ')], signatureVerified: false };
  if (candidates[0]) return candidates[0];
  const generic = header(input.headers, 'user-agent')?.match(/^(curl\/|PostmanRuntime\/|HTTPie\/|python-requests\/)/i);
  return { provider: generic ? 'generic' : 'unknown', confidence: 'low', evidence: [generic ? 'Generic HTTP client' : 'Insufficient indicators'], signatureVerified: false };
}
