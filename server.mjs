#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ProxyAgent } from 'undici';

const ZERO_WIDTH = /\u200b|\u200c|\u200d|\ufeff/g;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const args = { config: 'config.json', envFile: '.env', checkConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') args.config = argv[++i];
    else if (arg === '--env-file') args.envFile = argv[++i];
    else if (arg === '--check-config') args.checkConfig = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node server.mjs --config config.json --env-file .env');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

let ENV_FILE = {};
let OUTBOUND_PROXY_DISPATCHER = null;
let OUTBOUND_PROXY_URL = '';

async function loadEnvFile(filePath) {
  const env = {};
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return env;
    throw error;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n');
    env[key] = value;
  }
  return env;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function randomId(prefix, bytes = 18) {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function randomSuffix(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

function generatedPassword() {
  return `A1m!${randomBytes(12).toString('base64url')}`;
}

function randomEmailLocalPart(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}

const FIRST_NAMES = [
  'Alex',
  'Blake',
  'Casey',
  'Drew',
  'Elliot',
  'Hayden',
  'Jordan',
  'Morgan',
  'Quinn',
  'Riley',
  'Rowan',
  'Taylor',
];

const LAST_NAMES = [
  'Anderson',
  'Brooks',
  'Carter',
  'Foster',
  'Gray',
  'Hayes',
  'Morgan',
  'Parker',
  'Reed',
  'Sullivan',
  'Turner',
  'Walker',
];

function randomChoice(values) {
  return values[randomBytes(4).readUInt32BE(0) % values.length];
}

function generatedAccountName() {
  return `${randomChoice(FIRST_NAMES)} ${randomChoice(LAST_NAMES)}`;
}

function envOrValue(value, envName) {
  return envName && ENV_FILE[envName] ? ENV_FILE[envName] : value;
}

function envOrProcessOrValue(value, envName) {
  if (envName && ENV_FILE[envName]) return ENV_FILE[envName];
  if (envName && process.env[envName]) return process.env[envName];
  return value;
}

function safeProxyLabel(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    if (url.username) url.username = '***';
    return url.toString();
  } catch {
    return '<invalid proxy url>';
  }
}

function configureOutboundProxy(config) {
  const proxyConfig = config.proxy || {};
  const proxyUrl = String(
    envOrProcessOrValue(proxyConfig.outboundProxyUrl || '', proxyConfig.outboundProxyUrlEnv || 'ALMMA_OUTBOUND_PROXY')
    || ENV_FILE.ALMMA_OUTBOUND_PROXY
    || process.env.ALMMA_OUTBOUND_PROXY
    || ''
  ).trim();
  OUTBOUND_PROXY_URL = proxyUrl;
  OUTBOUND_PROXY_DISPATCHER = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  if (OUTBOUND_PROXY_DISPATCHER) console.log(`Outbound proxy enabled: ${safeProxyLabel(proxyUrl)}`);
}

function shouldUseOutboundProxy(resource) {
  if (!OUTBOUND_PROXY_DISPATCHER) return false;
  let url;
  try {
    url = new URL(String(resource));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
  if (hostname === 'turnstile-solver' || hostname === 'almma-turnstile-solver') return false;
  return true;
}

function fetchWithProxy(resource, options = {}) {
  if (!shouldUseOutboundProxy(resource) || options.dispatcher) return fetch(resource, options);
  return fetch(resource, { ...options, dispatcher: OUTBOUND_PROXY_DISPATCHER });
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required value: ${label}`);
  }
  return value.trim();
}

function providerSlug(provider) {
  return requiredString(provider, 'provider').replace(/\s+/g, '-');
}

function exposedModelNameFor(provider, model, explicit = '') {
  const value = String(explicit || '').trim();
  if (value) return value;
  return `${providerSlug(provider)}/${requiredString(model, 'model')}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days) * 86400000);
}

function minDateIso(values) {
  const dates = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => Number.isFinite(date.getTime()));
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((date) => date.getTime()))).toISOString();
}

function decodeJwtPayload(token) {
  if (!token || !token.includes('.')) return null;
  const payload = token.split('.')[1];
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function tokenExpiresAt(token) {
  const payload = decodeJwtPayload(token);
  return payload?.exp ? new Date(payload.exp * 1000).toISOString() : null;
}

function isFuture(iso, skewMs = 0) {
  return iso && new Date(iso).getTime() > Date.now() + skewMs;
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function beijingDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function nextUtcMidnightIso(date = new Date()) {
  const next = new Date(date);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function requestJson(url, options = {}) {
  const result = await requestJsonWithMeta(url, options);
  return result.body;
}

async function requestJsonWithMeta(url, options = {}) {
  const res = await fetchWithProxy(url, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 1000) : JSON.stringify(body);
    throw new Error(`${options.method || 'GET'} ${url} -> ${res.status} ${res.statusText}: ${detail}`);
  }
  if (typeof body === 'string' && /^event:\s*error\b/i.test(body.trim())) {
    throw new Error(`${options.method || 'GET'} ${url} -> ${res.status} ${res.statusText}: ${body.trim().slice(0, 1000)}`);
  }
  return { body, headers: res.headers, status: res.status };
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return String(value).split(/,(?=\s*[^;,=\s]+=[^;])/g).map((item) => item.trim()).filter(Boolean);
}

function setCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  return splitSetCookieHeader(headers.get?.('set-cookie'));
}

function setCookieName(setCookie) {
  const first = String(setCookie || '').split(';', 1)[0];
  const eq = first.indexOf('=');
  return eq > 0 ? first.slice(0, eq).trim() : '';
}

function setCookieValue(setCookie) {
  const first = String(setCookie || '').split(';', 1)[0];
  const eq = first.indexOf('=');
  return eq >= 0 ? first.slice(eq + 1) : '';
}

function mergeCookieJar(jar = {}, setCookies = []) {
  const next = { ...jar };
  for (const setCookie of setCookies) {
    const name = setCookieName(setCookie);
    if (!name) continue;
    const value = setCookieValue(setCookie);
    if (!value || /;\s*max-age=0\b/i.test(setCookie)) {
      delete next[name];
      continue;
    }
    next[name] = value;
  }
  return next;
}

function cookieHeader(cookies = {}) {
  return Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function createAlmmaClient(baseUrl) {
  const root = normalizeBaseUrl(baseUrl);
  function requestOptions({ token, cookies, method = 'GET', body } = {}) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      origin: root,
      referer: `${root}/`,
      'user-agent': BROWSER_USER_AGENT,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const cookie = cookieHeader(cookies);
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }
  async function almma(pathname, options = {}) {
    return (await almma.withMeta(pathname, options)).body;
  };
  almma.withMeta = (pathname, options = {}) => requestJsonWithMeta(`${root}${pathname}`, requestOptions(options));
  return almma;
}

function createMailClient(mailConfig) {
  const root = normalizeBaseUrl(requiredString(envOrValue(mailConfig.baseUrl, mailConfig.baseUrlEnv), `mail.baseUrl or ${mailConfig.baseUrlEnv || 'MOEMAIL_BASE_URL'}`));
  const apiKey = requiredString(envOrValue(mailConfig.apiKey, mailConfig.apiKeyEnv), `mail.apiKey or ${mailConfig.apiKeyEnv}`);
  return async function mail(pathname, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json', 'x-api-key': apiKey };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return requestJson(`${root}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
}

function pickFirstString(value, keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return '';
}

function collectObjects(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return out;
  }
  out.push(value);
  for (const item of Object.values(value)) collectObjects(item, out);
  return out;
}

function collectPathValues(value, pathParts = [], out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPathValues(item, [...pathParts, String(index)], out));
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    const pathName = [...pathParts, key].join('.');
    out.push({ path: pathName, key, value: item });
    if (item && typeof item === 'object') collectPathValues(item, [...pathParts, key], out);
  }
  return out;
}

function valueToIsoDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 946684800000) return new Date(value).toISOString();
    if (value > 946684800) return new Date(value * 1000).toISOString();
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^\d{10,13}$/.test(raw)) return valueToIsoDate(Number(raw));
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function dateFieldScore(pathName) {
  const name = pathName.toLowerCase();
  if (!/(trial|subscription|plan|period|expire|expiry|expires|end|ends|until|valid)/i.test(name)) return 0;
  let score = 1;
  if (/trial/.test(name)) score += 5;
  if (/subscription|plan|period/.test(name)) score += 3;
  if (/expire|expiry|expires|end|ends|until|valid/.test(name)) score += 3;
  if (/token|jwt|refresh/.test(name)) score -= 6;
  return score;
}

function extractAccountExpiresAtFromResponses(responses) {
  const now = Date.now();
  const candidates = [];
  for (const response of responses) {
    for (const item of collectPathValues(response.body)) {
      const score = dateFieldScore(item.path);
      if (score <= 0) continue;
      const iso = valueToIsoDate(item.value);
      if (!iso) continue;
      const time = new Date(iso).getTime();
      if (!Number.isFinite(time) || time <= now) continue;
      candidates.push({ iso, time, score, endpoint: response.endpoint, path: item.path });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.time - b.time);
  return candidates[0] || null;
}

function extractGeneratedEmail(response) {
  const candidates = collectObjects(response)
    .map((object) => ({
      id: pickFirstString(object, ['id', '_id', 'emailId']),
      email: pickFirstString(object, ['email', 'address', 'mail', 'emailAddress']),
    }))
    .filter((item) => item.email.includes('@'));
  const best = candidates.find((item) => item.id) || candidates[0];
  if (!best?.id || !best?.email) {
    throw new Error(`Could not parse generated email response: ${JSON.stringify(response)}`);
  }
  return best;
}

function extractList(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  for (const key of ['data', 'messages', 'items', 'results', 'mail', 'mails']) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

function extractMessageId(message) {
  return pickFirstString(message, ['id', '_id', 'messageId', 'mailId']);
}

function stringify(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      return JSON.stringify(part);
    }).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function normalizeMessagesForAgent(messages, proxyConfig = {}) {
  if (!Array.isArray(messages)) return messages;
  const mode = proxyConfig.systemMessageMode || 'leading_system_convert_rest';
  const systemMarker = proxyConfig.systemMarker || '### SYSTEM';
  const developerMarker = proxyConfig.developerMarker || '### DEVELOPER';
  const markerFor = (role) => (role === 'developer' ? developerMarker : systemMarker);
  const asUserMarker = (message) => ({
    ...message,
    role: 'user',
    content: `${markerFor(message.role)}\n${messageContentToText(message.content)}`,
  });
  if (mode === 'merge_system_to_first') {
    const systemParts = [];
    const regularMessages = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        regularMessages.push(message);
        continue;
      }
      if (message.role !== 'system' && message.role !== 'developer') {
        regularMessages.push(message);
        continue;
      }
      systemParts.push(`${markerFor(message.role)}\n${messageContentToText(message.content)}`);
    }
    if (systemParts.length === 0) return regularMessages;
    return [
      {
        role: 'system',
        content: systemParts.join('\n\n'),
      },
      ...regularMessages,
    ];
  }
  if (mode === 'leading_system_convert_rest') {
    const leadingSystemParts = [];
    const output = [];
    let seenConversationMessage = false;
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        seenConversationMessage = true;
        output.push(message);
        continue;
      }
      const isSystemLike = message.role === 'system' || message.role === 'developer';
      if (!seenConversationMessage && isSystemLike) {
        leadingSystemParts.push(`${markerFor(message.role)}\n${messageContentToText(message.content)}`);
        continue;
      }
      if (!isSystemLike) {
        seenConversationMessage = true;
        output.push(message);
        continue;
      }
      output.push(asUserMarker(message));
    }
    if (leadingSystemParts.length === 0) return output;
    return [
      {
        role: 'system',
        content: leadingSystemParts.join('\n\n'),
      },
      ...output,
    ];
  }
  if (mode === 'keep_first_system_convert_rest') {
    return messages.map((message, index) => {
      if (!message || typeof message !== 'object') return message;
      if (message.role !== 'system' && message.role !== 'developer') return message;
      if (index === 0 && message.role === 'system') return message;
      return asUserMarker(message);
    });
  }
  if (mode !== 'convert_to_user_marker') return messages;
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (message.role !== 'system' && message.role !== 'developer') return message;
    return asUserMarker(message);
  });
}

function extractVerificationFromMessage(message, expectedBaseUrl) {
  const raw = decodeHtmlEntities(stringify(message).replace(ZERO_WIDTH, ''));
  const escapedRoot = normalizeBaseUrl(expectedBaseUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkPattern = new RegExp(`${escapedRoot}/verify\\?[^"'\\s<>\\\\]+`, 'i');
  const linkMatch = raw.match(linkPattern);
  if (linkMatch) {
    const link = linkMatch[0].replace(/\\u0026/g, '&');
    const url = new URL(link);
    return { link, email: url.searchParams.get('email') || '', token: url.searchParams.get('token') || '' };
  }
  const token = raw.match(/token[=:]"?([a-f0-9]{32,128})/i)?.[1] || '';
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  return token && email ? { link: '', email, token } : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function solveTurnstile(config, pageUrl, log = () => {}) {
  const solverBaseUrl = normalizeBaseUrl(requiredString(config.solverBaseUrl, 'turnstile.solverBaseUrl'));
  const siteKey = requiredString(config.siteKey, 'turnstile.siteKey');
  const timeoutMs = Number(config.timeoutMs || 180000);
  const pollIntervalMs = Number(config.pollIntervalMs || 3000);
  const maxAttempts = Math.max(1, Number(config.maxAttempts || 1));
  const retryDelayMs = Number(config.retryDelayMs || 3000);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (maxAttempts > 1) log(`turnstile solve attempt ${attempt}/${maxAttempts}`);
    const start = Date.now();
    try {
      const taskUrl = new URL(`${solverBaseUrl}/turnstile`);
      taskUrl.searchParams.set('url', pageUrl);
      taskUrl.searchParams.set('sitekey', siteKey);
      const task = await requestJson(taskUrl, { headers: { accept: 'application/json' } });
      if (task.errorId) throw new Error(`Turnstile task failed: ${JSON.stringify(task)}`);
      const taskId = requiredString(task.taskId, 'turnstile taskId');
      while (Date.now() - start < timeoutMs) {
        await sleep(pollIntervalMs);
        const resultUrl = new URL(`${solverBaseUrl}/result`);
        resultUrl.searchParams.set('id', taskId);
        const result = await requestJson(resultUrl, { headers: { accept: 'application/json' } });
        if (result.status === 'processing') {
          log('turnstile still processing');
          continue;
        }
        if (result.errorId) throw new Error(`Turnstile solve failed: ${JSON.stringify(result)}`);
        if (result.solution?.token) return result.solution.token;
      }
      throw new Error(`Turnstile solve timed out after ${timeoutMs}ms`);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      log(`turnstile attempt ${attempt} failed: ${error.message}`);
      await sleep(retryDelayMs);
    }
  }
  throw lastError || new Error('Turnstile solve failed');
}

function deriveInstructions(config, override) {
  if (override !== undefined) return String(override || '');
  return String(envOrValue(config.agentDefaults?.instructions, config.agentDefaults?.instructionsEnv) || '');
}

function cloneJson(value, fallback) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function normalizeAgentSpecInput(config, agent = {}, instructionsOverride) {
  const defaults = config.agentDefaults || {};
  const instructions = deriveInstructions(config, instructionsOverride);
  const provider = requiredString(agent.provider || defaults.provider, 'agent.provider or agentDefaults.provider');
  const model = requiredString(agent.model, 'agent.model');
  const exposedModelName = exposedModelNameFor(provider, model, agent.exposedModelName);
  const modelParameters = {
    ...cloneJson(defaults.model_parameters, {}),
    ...cloneJson(agent.model_parameters, {}),
  };
  return {
    exposedModelName,
    name: requiredString(agent.name || exposedModelName, 'agent.name'),
    artifacts: agent.artifacts ?? defaults.artifacts ?? '',
    description: agent.description ?? defaults.description ?? '',
    instructions: agent.instructions ?? instructions,
    model,
    provider,
    ...(nonEmptyPlainObject(modelParameters) ? { model_parameters: modelParameters } : {}),
    edges: cloneJson(agent.edges ?? defaults.edges, []),
    category: agent.category ?? defaults.category ?? 'general',
    support_contact: cloneJson(agent.support_contact ?? defaults.support_contact, { name: '', email: '' }),
    tool_options: cloneJson(agent.tool_options ?? defaults.tool_options, {}),
    conversation_starters: cloneJson(agent.conversation_starters ?? defaults.conversation_starters, []),
    tools: cloneJson(agent.tools ?? defaults.tools, []),
  };
}

function defaultAgentSpecs(config, instructionsOverride, agentsOverride) {
  return (agentsOverride || config.agents || []).map((agent) => normalizeAgentSpecInput(config, agent, instructionsOverride));
}

function publicAgentSpec(spec) {
  const publicSpec = {
    exposedModelName: spec.exposedModelName,
    name: spec.name,
    provider: spec.provider,
    providerSlug: providerSlug(spec.provider),
    model: spec.model,
  };
  if (nonEmptyPlainObject(spec.model_parameters)) publicSpec.model_parameters = cloneJson(spec.model_parameters, {});
  return publicSpec;
}

function extractErrorMessage(body) {
  if (typeof body === 'string') {
    try {
      return extractErrorMessage(JSON.parse(body));
    } catch {
      return body.slice(0, 1000);
    }
  }
  return body?.error?.message || body?.message || JSON.stringify(body).slice(0, 1000);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(
    usage.prompt_tokens
    ?? usage.input_tokens
    ?? usage.inputTokens
    ?? usage.promptTokens
    ?? 0
  );
  const completionTokens = Number(
    usage.completion_tokens
    ?? usage.output_tokens
    ?? usage.outputTokens
    ?? usage.completionTokens
    ?? 0
  );
  const totalTokens = Number(
    usage.total_tokens
    ?? usage.totalTokens
    ?? (promptTokens + completionTokens)
  );
  const normalized = {
    prompt_tokens: Number.isFinite(promptTokens) ? Math.max(0, Math.round(promptTokens)) : 0,
    completion_tokens: Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : 0,
    total_tokens: Number.isFinite(totalTokens) ? Math.max(0, Math.round(totalTokens)) : 0,
  };
  if (usage.prompt_tokens_details) normalized.prompt_tokens_details = usage.prompt_tokens_details;
  if (usage.completion_tokens_details) normalized.completion_tokens_details = usage.completion_tokens_details;
  return normalized;
}

function normalizeChatCompletionBody(body, requestedModel) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const next = { ...body };
  if (requestedModel && typeof next.model === 'string') next.model = requestedModel;
  const usage = normalizeUsage(next.usage);
  if (usage) next.usage = usage;
  return next;
}

function sseDataLines(event) {
  return String(event || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
}

function writeSseData(res, data) {
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

async function streamChatWithUsageNormalization(res, upstream, requestedModel) {
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let usageEmitted = false;
  let lastChunk = null;

  function emitUsageChunk() {
    if (!usage || usageEmitted) return;
    writeSseData(res, {
      id: lastChunk?.id || `chatcmpl-${randomId('', 12)}`,
      object: 'chat.completion.chunk',
      created: lastChunk?.created || Math.floor(Date.now() / 1000),
      model: requestedModel || lastChunk?.model || '',
      choices: [],
      usage,
    });
    usageEmitted = true;
  }

  function processEvent(event) {
    const lines = sseDataLines(event);
    if (lines.length === 0) {
      res.write(`${event}\n\n`);
      return;
    }
    const data = lines.join('\n');
    if (data.trim() === '[DONE]') {
      emitUsageChunk();
      writeSseData(res, '[DONE]');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      res.write(`${event}\n\n`);
      return;
    }
    if (parsed && typeof parsed === 'object') {
      lastChunk = parsed;
      if (parsed.usage) {
        usage = normalizeUsage(parsed.usage) || usage;
        delete parsed.usage;
      }
      if (requestedModel && typeof parsed.model === 'string') parsed.model = requestedModel;
    }
    writeSseData(res, parsed);
  }

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, index);
      const match = buffer.slice(index).match(/^\r?\n\r?\n/);
      buffer = buffer.slice(index + (match ? match[0].length : 2));
      processEvent(event);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processEvent(buffer.trimEnd());
  emitUsageChunk();
  res.end();
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    userId: account.userId,
    status: account.status,
    disabledReason: account.disabledReason,
    createdAt: account.createdAt,
    expiresAt: account.expiresAt,
    expiresAtSource: account.expiresAtSource,
    entitlementsCheckedAt: account.entitlementsCheckedAt,
    backendKey: account.backendKey ? {
      id: account.backendKey.id,
      name: account.backendKey.name,
      keyPrefix: account.backendKey.keyPrefix,
      calls: account.backendKey.calls,
      limit: account.backendKey.limit,
      remaining: Math.max(0, (account.backendKey.limit || 0) - (account.backendKey.calls || 0)),
      usageDate: account.backendKey.usageDate,
      resetAt: account.backendKey.resetAt,
      status: account.backendKey.status,
      disabledReason: account.backendKey.disabledReason,
      createdAt: account.backendKey.createdAt,
      expiresAt: account.backendKey.expiresAt,
    } : null,
    agents: account.agents || {},
  };
}

class AlmmaService {
  constructor(config, configPath) {
    this.config = config;
    this.configPath = configPath;
    this.baseUrl = normalizeBaseUrl(requiredString(config.baseUrl, 'baseUrl'));
    this.stateFile = path.resolve(path.dirname(configPath), config.stateFile || 'almma-service.state.json');
    this.state = {};
    this.jobs = new Map();
    this.almma = createAlmmaClient(this.baseUrl);
    this.mail = null;
    this.autoProvisionBackoffUntil = 0;
  }

  async init() {
    this.state = await readJsonFile(this.stateFile, {});
    this.state.accounts ||= [];
    this.state.settings ||= {};
    this.state.createdAt ||= nowIso();
    this.state.serviceApiKey = envOrValue(this.state.serviceApiKey, this.config.auth?.serviceApiKeyEnv);
    this.state.adminApiKey = envOrValue(this.state.adminApiKey, this.config.auth?.adminApiKeyEnv);
    if (!this.state.serviceApiKey && this.config.auth?.autoGenerateServiceApiKey !== false) {
      this.state.serviceApiKey = randomId('svc-');
    }
    if (!this.state.adminApiKey && this.config.auth?.autoGenerateAdminApiKey !== false) {
      this.state.adminApiKey = randomId('adm-');
    }
    requiredString(this.state.serviceApiKey, `auth.serviceApiKeyEnv or generated service key`);
    requiredString(this.state.adminApiKey, `auth.adminApiKeyEnv or generated admin key`);
    this.migrateAgentNames();
    this.cleanupStaleProvisioningAccounts();
    this.refreshAccountStatuses();
    await this.saveState();
  }

  async saveState() {
    this.state.updatedAt = nowIso();
    await writeJsonFile(this.stateFile, this.state);
  }

  ensureMail() {
    this.mail ||= createMailClient(this.config.mail || {});
    return this.mail;
  }

  defaultAgentInstructions() {
    if (Object.prototype.hasOwnProperty.call(this.state.settings || {}, 'agentInstructions')) {
      return String(this.state.settings.agentInstructions || '');
    }
    return deriveInstructions(this.config);
  }

  proxyConfig() {
    const proxy = { ...(this.config.proxy || {}) };
    if (this.state.settings?.proxySystemMessageMode) {
      proxy.systemMessageMode = this.state.settings.proxySystemMessageMode;
    }
    return proxy;
  }

  autoProvisionEnabled() {
    return this.state.settings?.autoProvisionEnabled !== false;
  }

  defaultAgentSpecs(instructionsOverride) {
    const agents = Array.isArray(this.state.settings?.defaultAgents) ? this.state.settings.defaultAgents : undefined;
    return defaultAgentSpecs(this.config, instructionsOverride, agents);
  }

  publicDefaultAgents() {
    return this.defaultAgentSpecs(this.defaultAgentInstructions()).map(publicAgentSpec);
  }

  normalizeAgentSpec(spec) {
    return normalizeAgentSpecInput(this.config, spec, this.defaultAgentInstructions());
  }

  migrateAgentNames() {
    for (const account of this.state.accounts || []) {
      if (!account.agents || typeof account.agents !== 'object') continue;
      for (const [name, agent] of Object.entries({ ...account.agents })) {
        if (!agent || typeof agent !== 'object' || name.includes('/')) continue;
        const provider = agent.provider || this.config.agentDefaults?.provider;
        const model = agent.model || name;
        if (!provider || !model) continue;
        const nextName = exposedModelNameFor(provider, model);
        if (nextName === name || account.agents[nextName]) continue;
        account.agents[nextName] = agent;
        delete account.agents[name];
      }
    }
  }

  async updateSettings(settings = {}) {
    this.state.settings ||= {};
    if (Object.prototype.hasOwnProperty.call(settings, 'maxEffectiveAccounts')) {
      const max = Number(settings.maxEffectiveAccounts);
      if (!Number.isInteger(max) || max < 1 || max > 100) {
        const error = new Error('maxEffectiveAccounts must be an integer from 1 to 100');
        error.statusCode = 400;
        throw error;
      }
      this.state.settings.maxEffectiveAccounts = max;
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'agentInstructions')) {
      this.state.settings.agentInstructions = String(settings.agentInstructions || '');
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'proxySystemMessageMode')) {
      const mode = String(settings.proxySystemMessageMode || '');
      const allowed = new Set(['leading_system_convert_rest', 'merge_system_to_first', 'keep_first_system_convert_rest']);
      if (!allowed.has(mode)) {
        const error = new Error('Invalid proxySystemMessageMode');
        error.statusCode = 400;
        throw error;
      }
      this.state.settings.proxySystemMessageMode = mode;
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'autoProvisionEnabled')) {
      this.state.settings.autoProvisionEnabled = Boolean(settings.autoProvisionEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'defaultAgents')) {
      if (!Array.isArray(settings.defaultAgents)) {
        const error = new Error('defaultAgents must be an array');
        error.statusCode = 400;
        throw error;
      }
      this.state.settings.defaultAgents = settings.defaultAgents.map((agent) => {
        const spec = this.normalizeAgentSpec(agent);
        return publicAgentSpec(spec);
      });
    }
    await this.saveState();
    this.ensureAccountPool('settings');
    return this.publicState();
  }

  cleanupStaleProvisioningAccounts() {
    const staleMs = Number(this.config.limits?.provisioningStaleMs || 20 * 60 * 1000);
    const now = Date.now();
    for (const account of this.state.accounts || []) {
      if (account.status !== 'provisioning') continue;
      if (account.backendKey?.key) continue;
      const createdAt = new Date(account.createdAt || 0).getTime();
      if (!Number.isFinite(createdAt) || now - createdAt < staleMs) continue;
      account.status = 'failed';
      account.disabledReason = 'provisioning_interrupted';
      account.backendKey ||= {};
      account.backendKey.status = 'failed';
      account.backendKey.disabledReason = 'provisioning_interrupted';
    }
  }

  refreshAccountStatuses() {
    this.cleanupStaleProvisioningAccounts();
    const now = Date.now();
    const limit = Number(this.config.limits?.callsPerAccountKey || 500);
    const today = utcDayKey();
    const resetAt = nextUtcMidnightIso();
    for (const account of this.state.accounts || []) {
      account.backendKey ||= {};
      account.backendKey.limit = limit;
      if (account.backendKey.key) {
        if (account.backendKey.usageDate !== today) {
          account.backendKey.calls = 0;
          account.backendKey.usageDate = today;
          if (account.backendKey.disabledReason === 'daily_quota_exhausted' || account.backendKey.disabledReason === 'quota_exhausted') {
            delete account.backendKey.disabledReason;
          }
        }
        account.backendKey.calls ||= 0;
        account.backendKey.resetAt = resetAt;
      }
      if (account.expiresAt && new Date(account.expiresAt).getTime() <= now) {
        account.status = 'disabled';
        account.disabledReason ||= 'expired';
        account.backendKey.status = 'disabled';
        account.backendKey.disabledReason ||= 'expired';
        continue;
      }
      if (account.disabledReason === 'quota_exhausted') {
        delete account.disabledReason;
      }
      if (account.backendKey.key) {
        if (account.status === 'disabled' && account.backendKey.disabledReason === 'quota_exhausted') {
          account.status = 'active';
          delete account.disabledReason;
        }
        if ((account.backendKey.calls || 0) >= account.backendKey.limit) {
          account.backendKey.status = 'daily_exhausted';
          account.backendKey.disabledReason = 'daily_quota_exhausted';
        } else {
          account.backendKey.status = 'active';
          if (account.backendKey.disabledReason === 'daily_quota_exhausted') delete account.backendKey.disabledReason;
        }
      }
    }
  }

  assertAdmin(req) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${this.state.adminApiKey}`) {
      const error = new Error('Unauthorized admin request');
      error.statusCode = 401;
      throw error;
    }
  }

  assertService(req) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${this.state.serviceApiKey}`) {
      const error = new Error('Unauthorized');
      error.statusCode = 401;
      throw error;
    }
  }

  publicState() {
    this.refreshAccountStatuses();
    const validAccounts = this.validAccounts();
    const availableAccounts = this.activeAccounts();
    const callsToday = validAccounts.reduce((sum, account) => sum + (account.backendKey?.calls || 0), 0);
    const dailyLimitTotal = validAccounts.reduce((sum, account) => sum + (account.backendKey?.limit || 0), 0);
    return {
      serviceApiKey: this.state.serviceApiKey,
      adminApiKey: this.state.adminApiKey,
      stateFile: this.stateFile,
      limits: {
        callsPerAccountKey: Number(this.config.limits?.callsPerAccountKey || 500),
        accountKeyTtlDays: Number(this.config.limits?.accountKeyTtlDays || 14),
        maxEffectiveAccounts: this.maxEffectiveAccounts(),
        dailyResetAt: nextUtcMidnightIso(),
        dailyResetTimezone: 'Asia/Shanghai',
        dailyResetLabel: '08:00 北京时间',
      },
      settings: {
        maxEffectiveAccounts: this.maxEffectiveAccounts(),
        agentInstructions: this.defaultAgentInstructions(),
        proxySystemMessageMode: this.proxyConfig().systemMessageMode || 'leading_system_convert_rest',
        autoProvisionEnabled: this.autoProvisionEnabled(),
        defaultAgents: this.publicDefaultAgents(),
      },
      effectiveAccounts: validAccounts.length,
      availableAccounts: availableAccounts.length,
      callsToday,
      remainingToday: Math.max(0, dailyLimitTotal - callsToday),
      dailyLimitTotal,
      supportedModels: this.supportedModels(),
      accounts: (this.state.accounts || []).map(publicAccount),
      jobs: [...this.jobs.values()],
    };
  }

  maxEffectiveAccounts() {
    const value = Number(this.state.settings?.maxEffectiveAccounts || this.config.limits?.maxEffectiveAccounts || 0);
    return Number.isFinite(value) && value > 0 ? value : Infinity;
  }

  effectiveAccounts() {
    return this.validAccounts();
  }

  runningProvisionJob() {
    return [...this.jobs.values()].find((job) => job.status === 'running' && (job.type === 'provision' || job.type === 'auto-provision'));
  }

  dailyExhaustedSupplement(max) {
    this.state.autoProvision ||= {};
    const day = beijingDayKey();
    const current = this.state.autoProvision.dailyExhaustedSupplement || {};
    if (current.day !== day) {
      this.state.autoProvision.dailyExhaustedSupplement = { day, count: 0 };
      return this.state.autoProvision.dailyExhaustedSupplement;
    }
    current.count = Math.max(0, Number(current.count || 0));
    this.state.autoProvision.dailyExhaustedSupplement = current;
    return current;
  }

  dailyQuotaStats(accounts = this.effectiveAccounts()) {
    return accounts.reduce((stats, account) => {
      const limit = account.backendKey?.limit || Number(this.config.limits?.callsPerAccountKey || 500);
      const calls = account.backendKey?.calls || 0;
      stats.total += limit;
      stats.remaining += Math.max(0, limit - calls);
      return stats;
    }, { total: 0, remaining: 0 });
  }

  dailyQuotaPressureReached(accounts = this.effectiveAccounts()) {
    if (accounts.length === 0) return false;
    const allExhausted = accounts.every((account) => {
      const limit = account.backendKey?.limit || Number(this.config.limits?.callsPerAccountKey || 500);
      return account.backendKey?.status === 'daily_exhausted' || (account.backendKey?.calls || 0) >= limit;
    });
    if (allExhausted) return true;
    const stats = this.dailyQuotaStats(accounts);
    return stats.total > 0 && stats.remaining < stats.total / 10;
  }

  ensureAccountPool(reason = 'timer') {
    if (!this.autoProvisionEnabled()) return null;
    if (this.runningProvisionJob()) return null;
    const max = this.maxEffectiveAccounts();
    if (!Number.isFinite(max)) return null;
    const now = Date.now();
    if (now < this.autoProvisionBackoffUntil) return null;
    const effectiveAccounts = this.effectiveAccounts();
    const current = effectiveAccounts.length;
    let count = Math.max(0, max - current);
    let mode = 'capacity';
    let allowOverLimit = false;
    if (count <= 0 && this.dailyQuotaPressureReached(effectiveAccounts)) {
      const supplement = this.dailyExhaustedSupplement(max);
      const remainingDailySupplement = Math.max(0, max - Number(supplement.count || 0));
      count = Math.min(1, remainingDailySupplement);
      mode = 'daily_quota_pressure';
      allowOverLimit = count > 0;
    }
    if (count <= 0) return null;
    const job = this.startJob('auto-provision', async (log) => {
      const accounts = [];
      log(`auto provisioning ${count} account(s), reason: ${reason}, mode: ${mode}`);
      try {
        for (let i = 0; i < count; i += 1) {
          if (!allowOverLimit && this.effectiveAccounts().length >= this.maxEffectiveAccounts()) break;
          log(`provisioning account ${i + 1}/${count}`);
          const account = await this.provisionAccount({ instructionsOverride: undefined, log, skipCapacityCheck: allowOverLimit });
          accounts.push(publicAccount(account));
          if (mode === 'daily_quota_pressure') {
            const supplement = this.dailyExhaustedSupplement(max);
            supplement.count = Math.min(max, Number(supplement.count || 0) + 1);
            await this.saveState();
          }
        }
        return { accounts };
      } catch (error) {
        const retryMs = Number(this.config.limits?.autoProvisionRetryDelayMs || 10 * 60 * 1000);
        this.autoProvisionBackoffUntil = Date.now() + retryMs;
        throw error;
      }
    });
    return job;
  }

  assertProvisionCapacity(count = 1) {
    const max = this.maxEffectiveAccounts();
    if (!Number.isFinite(max)) return;
    const current = this.effectiveAccounts().length;
    if (current + count > max) {
      const error = new Error(`Effective account limit reached: ${current}/${max}`);
      error.statusCode = 409;
      throw error;
    }
  }

  supportedModels() {
    const allowedModels = this.configuredModelNames();
    const models = new Map();
    for (const account of this.activeAccounts()) {
      for (const [name, agent] of Object.entries(account.agents || {})) {
        if (!allowedModels.has(name)) continue;
        if (!agent?.id) continue;
        if (!models.has(name)) {
          models.set(name, {
            id: name,
            object: 'model',
            created: Math.floor(new Date(agent.createdAt || account.createdAt || nowIso()).getTime() / 1000),
            owned_by: 'almma-proxy',
            root: name,
            parent: null,
            provider: agent.provider,
            backendModel: agent.model,
            model_parameters: agent.model_parameters || {},
          });
        }
      }
    }
    return [...models.values()];
  }

  configuredModelNames() {
    return new Set(this.defaultAgentSpecs(this.defaultAgentInstructions()).map((agent) => agent.exposedModelName));
  }

  activeAccounts() {
    return this.validAccounts().filter((account) => (account.backendKey.calls || 0) < (account.backendKey.limit || 500));
  }

  validAccounts() {
    this.refreshAccountStatuses();
    return (this.state.accounts || []).filter((account) => {
      if (account.status === 'disabled') return false;
      if (!account.backendKey?.key) return false;
      return isFuture(account.expiresAt);
    });
  }

  selectAccountForModel(model) {
    if (!this.configuredModelNames().has(model)) return null;
    const accounts = this.activeAccounts()
      .filter((account) => account.agents?.[model]?.id)
      .sort((a, b) => {
        const byCalls = (b.backendKey.calls || 0) - (a.backendKey.calls || 0);
        if (byCalls) return byCalls;
        const byCreatedAt = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
        if (byCreatedAt) return byCreatedAt;
        return String(a.id).localeCompare(String(b.id));
      });
    return accounts[0] || null;
  }

  accountById(accountId) {
    return (this.state.accounts || []).find((account) => account.id === accountId);
  }

  async cleanupAccounts({ includeProvisioning = true, includeFailed = true } = {}) {
    const before = this.state.accounts.length;
    this.state.accounts = (this.state.accounts || []).filter((account) => {
      if (includeProvisioning && account.status === 'provisioning' && !account.backendKey?.key) return false;
      if (includeFailed && account.status === 'failed' && !account.backendKey?.key) return false;
      return true;
    });
    const removed = before - this.state.accounts.length;
    if (removed > 0) await this.saveState();
    return { removed };
  }

  async upstreamModels({ force = false, accountId = '' } = {}) {
    this.state.cache ||= {};
    const cached = this.state.cache.upstreamModels;
    const ttlMs = Number(this.config.limits?.upstreamModelsCacheMs || 24 * 60 * 60 * 1000);
    if (!force && cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < ttlMs) return cached;
    const account = accountId ? this.accountById(accountId) : this.activeAccounts()[0];
    if (!account) {
      const error = new Error('No active account available to fetch upstream models');
      error.statusCode = 409;
      throw error;
    }
    const token = await this.loginAccount(account, () => {});
    const models = await this.almma('/api/models', { token });
    const payload = { fetchedAt: nowIso(), ttlMs, models };
    this.state.cache.upstreamModels = payload;
    await this.saveState();
    return payload;
  }

  async testAgent(account, agent, log = () => {}) {
    if (!account.backendKey?.key) throw new Error('account has no backend Agents API key');
    log(`testing agent ${agent.id}`);
    const body = {
      model: requiredString(agent.id, 'agent.id'),
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      max_tokens: 16,
      stream: false,
    };
    const res = await fetchWithProxy(`${this.baseUrl}/api/agents/v1/chat/completions`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${account.backendKey.key}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let responseBody;
    try {
      responseBody = text ? JSON.parse(text) : null;
    } catch {
      responseBody = text;
    }
    const result = {
      ok: res.ok,
      status: res.status,
      message: res.ok ? 'OK' : extractErrorMessage(responseBody),
    };
    if (!res.ok) {
      const error = new Error(result.message);
      error.statusCode = res.status;
      error.testResult = result;
      throw error;
    }
    return result;
  }

  async deleteAgent(account, agentId, log = () => {}) {
    const id = requiredString(agentId, 'agent.id');
    const token = await this.loginAccount(account, log);
    const cookies = {
      ...(account.sessionCookies || {}),
      token,
      token_provider: account.sessionCookies?.token_provider || 'librechat',
    };
    log(`deleting agent ${id}`);
    const res = await fetchWithProxy(`${this.baseUrl}/api/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        authorization: `Bearer ${token}`,
        'cache-control': 'no-cache',
        cookie: cookieHeader(cookies),
        origin: this.baseUrl,
        pragma: 'no-cache',
        referer: `${this.baseUrl}/c/new`,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': BROWSER_USER_AGENT,
      },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok || (typeof body === 'string' && /^event:\s*error\b/i.test(body.trim()))) {
      const detail = extractErrorMessage(body);
      throw new Error(`DELETE /api/agents/${id} -> ${res.status}: ${detail}`);
    }
    return { ok: true, status: res.status, message: extractErrorMessage(body) || 'Agent deleted' };
  }

  defaultAgentsInclude(spec) {
    const normalized = publicAgentSpec(this.normalizeAgentSpec(spec));
    this.state.settings ||= {};
    const agents = this.publicDefaultAgents();
    if (!agents.some((agent) => agent.exposedModelName === normalized.exposedModelName)) agents.push(normalized);
    this.state.settings.defaultAgents = agents;
    return normalized;
  }

  async deleteAgentModelEverywhere(exposedModelName, log = () => {}) {
    const name = requiredString(exposedModelName, 'exposedModelName');
    this.state.settings ||= {};
    const beforeDefaultAgents = this.publicDefaultAgents();
    this.state.settings.defaultAgents = beforeDefaultAgents.filter((agent) => agent.exposedModelName !== name);
    const results = [];
    for (const account of this.state.accounts || []) {
      const agent = account.agents?.[name];
      if (!agent?.id) continue;
      try {
        const deletion = await this.deleteAgent(account, agent.id, log);
        delete account.agents[name];
        results.push({ account: publicAccount(account), agentId: agent.id, ok: true, deletion, localRemoved: true });
      } catch (error) {
        delete account.agents[name];
        results.push({ account: publicAccount(account), agentId: agent.id, ok: false, error: error.message, localRemoved: true });
        log(`delete failed for ${name} on ${account.id}: ${error.message}`);
      }
    }
    await this.saveState();
    return {
      exposedModelName: name,
      defaultRemoved: beforeDefaultAgents.length !== this.state.settings.defaultAgents.length,
      results,
    };
  }

  async createAndTestAgent(account, spec, log = () => {}) {
    const normalized = this.normalizeAgentSpec(spec);
    const agent = await this.createAgent(account, normalized, log);
    let test;
    try {
      test = await this.testAgent(account, agent, log);
    } catch (error) {
      try {
        error.cleanup = await this.deleteAgent(account, agent.id, log);
      } catch (cleanupError) {
        error.cleanup = { ok: false, error: cleanupError.message };
        log(`delete failed for agent ${agent.id}: ${cleanupError.message}`);
      }
      if (account.agents?.[normalized.exposedModelName]) {
        delete account.agents[normalized.exposedModelName];
        await this.saveState();
      }
      throw error;
    }
    return { account: publicAccount(account), agent, test, spec: publicAgentSpec(normalized) };
  }

  async createAgentAcrossActiveAccounts(spec, { persistDefault = false, skipAccountId = '' } = {}, log = () => {}) {
    const normalized = this.normalizeAgentSpec(spec);
    const results = [];
    for (const account of this.activeAccounts()) {
      if (skipAccountId && account.id === skipAccountId) continue;
      try {
        const agent = await this.createAgent(account, normalized, log);
        results.push({ account: publicAccount(account), agent, ok: true });
      } catch (error) {
        results.push({ account: publicAccount(account), ok: false, error: error.message });
      }
    }
    if (persistDefault) {
      this.defaultAgentsInclude(normalized);
      await this.saveState();
    }
    return { spec: publicAgentSpec(normalized), results };
  }

  async generateEmail() {
    const mail = this.ensureMail();
    const mailConfig = this.config.mail || {};
    const prefix = String(mailConfig.namePrefix || '').trim();
    const name = `${prefix}${randomEmailLocalPart()}`;
    const response = await mail('/api/emails/generate', {
      method: 'POST',
      body: {
        name,
        expiryTime: Number(mailConfig.expiryTime || 3600000),
        domain: mailConfig.domain,
      },
    });
    return extractGeneratedEmail(response);
  }

  async waitForVerificationEmail(emailId, log) {
    const mail = this.ensureMail();
    const mailConfig = this.config.mail || {};
    const timeoutMs = Number(mailConfig.timeoutMs || 180000);
    const pollIntervalMs = Number(mailConfig.pollIntervalMs || 5000);
    const start = Date.now();
    const seen = new Set();
    while (Date.now() - start < timeoutMs) {
      const list = await mail(`/api/emails/${encodeURIComponent(emailId)}`);
      for (const item of extractList(list)) {
        const messageId = extractMessageId(item);
        if (!messageId) {
          const found = extractVerificationFromMessage(item, this.baseUrl);
          if (found?.token) return found;
          continue;
        }
        if (seen.has(messageId)) continue;
        seen.add(messageId);
        const full = await mail(`/api/emails/${encodeURIComponent(emailId)}/${encodeURIComponent(messageId)}`);
        const found = extractVerificationFromMessage(full, this.baseUrl);
        if (found?.token) return found;
      }
      log('waiting for verification email');
      await sleep(pollIntervalMs);
    }
    throw new Error(`Timed out waiting for verification email after ${timeoutMs}ms`);
  }

  mergeSessionCookies(account, headers) {
    const cookies = setCookieHeaders(headers);
    if (cookies.length === 0) return;
    account.sessionCookies = mergeCookieJar(account.sessionCookies || {}, cookies);
  }

  async refreshLoginToken(account, log) {
    if (!account.sessionCookies?.refreshToken) return null;
    log('refreshing login token');
    try {
      const refreshResult = await this.almma.withMeta('/api/auth/refresh', {
        method: 'POST',
        cookies: account.sessionCookies,
      });
      this.mergeSessionCookies(account, refreshResult.headers);
      account.loginToken = requiredString(refreshResult.body?.token, 'refreshed login token');
      account.loginTokenExpiresAt = tokenExpiresAt(account.loginToken);
      account.userId = refreshResult.body?.user?._id || refreshResult.body?.user?.id || account.userId || '';
      await this.saveState();
      return account.loginToken;
    } catch (error) {
      log(`refresh login token failed: ${error.message}`);
      return null;
    }
  }

  async loginAccount(account, log) {
    if (account.loginToken && isFuture(account.loginTokenExpiresAt, 60000)) return account.loginToken;
    const refreshedToken = await this.refreshLoginToken(account, log);
    if (refreshedToken && isFuture(account.loginTokenExpiresAt, 60000)) return refreshedToken;
    log('solving login turnstile');
    const turnstileToken = await solveTurnstile(this.config.turnstile || {}, this.config.turnstile?.loginPageUrl || `${this.baseUrl}/login`, log);
    log('logging in');
    const loginResponse = await this.almma.withMeta('/api/auth/login', {
      method: 'POST',
      body: { email: account.email, password: account.password, turnstileToken },
    });
    const loginResult = loginResponse.body;
    this.mergeSessionCookies(account, loginResponse.headers);
    account.loginToken = requiredString(loginResult?.token, 'login token');
    account.loginTokenExpiresAt = tokenExpiresAt(account.loginToken);
    account.userId = loginResult.user?._id || loginResult.user?.id || account.userId || '';
    await this.refreshAccountEntitlements(account, { user: loginResult.user }, log);
    await this.saveState();
    return account.loginToken;
  }

  async refreshAccountEntitlements(account, initial = {}, log = () => {}) {
    const token = requiredString(account.loginToken, 'account.loginToken');
    const responses = [];
    if (initial.user) responses.push({ endpoint: 'login.user', body: initial.user });

    for (const endpoint of ['/api/subscription/usage', '/api/subscription', '/api/user']) {
      try {
        const body = await this.almma(endpoint, { token });
        responses.push({ endpoint, body });
      } catch (error) {
        log(`failed to fetch ${endpoint}: ${error.message}`);
      }
    }

    const found = extractAccountExpiresAtFromResponses(responses);
    const fallback = this.deriveFallbackAccountExpiresAt(initial.user);
    account.expiresAt = found?.iso || account.expiresAt || fallback;
    account.expiresAtSource = found ? `${found.endpoint}:${found.path}` : 'configured_ttl';
    account.entitlementsCheckedAt = nowIso();
    if (account.backendKey) account.backendKey.expiresAt = account.expiresAt;
    log(`account expires at ${account.expiresAt} (${account.expiresAtSource})`);
    return account.expiresAt;
  }

  deriveFallbackAccountExpiresAt(user) {
    const ttlDays = Number(this.config.limits?.accountKeyTtlDays || 14);
    return minDateIso([
      user?.almmaTrialEndDate,
      addDays(new Date(), ttlDays).toISOString(),
    ]);
  }

  agentBody(spec) {
    const body = {
      name: spec.name,
      artifacts: spec.artifacts ?? '',
      description: spec.description ?? '',
      instructions: spec.instructions == null ? '' : String(spec.instructions),
      model: requiredString(spec.model, 'agent.model'),
      provider: requiredString(spec.provider, 'agent.provider'),
      edges: spec.edges ?? [],
      category: spec.category ?? 'general',
      support_contact: spec.support_contact ?? { name: '', email: '' },
      tool_options: spec.tool_options ?? {},
      conversation_starters: spec.conversation_starters ?? [],
      tools: spec.tools ?? [],
    };
    if (nonEmptyPlainObject(spec.model_parameters)) body.model_parameters = cloneJson(spec.model_parameters, {});
    return body;
  }

  async createAgent(account, spec, log) {
    const loginToken = await this.loginAccount(account, log);
    log(`creating agent ${spec.exposedModelName}`);
    const agent = await this.almma('/api/agents', {
      method: 'POST',
      token: loginToken,
      body: this.agentBody(spec),
    });
    account.agents ||= {};
    const agentId = requiredString(pickFirstString(agent, ['id', '_id', 'agent_id']), 'created agent id');
    const storedAgent = {
      id: agentId,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      instructions: spec.instructions,
      createdAt: agent.createdAt || nowIso(),
    };
    if (nonEmptyPlainObject(spec.model_parameters)) storedAgent.model_parameters = cloneJson(spec.model_parameters, {});
    account.agents[spec.exposedModelName] = storedAgent;
    await this.saveState();
    return account.agents[spec.exposedModelName];
  }

  async provisionAccount({ instructionsOverride = '', log = () => {}, skipCapacityCheck = false } = {}) {
    if (!skipCapacityCheck) this.assertProvisionCapacity(1);
    const accountConfig = this.config.account || {};
    const accountName = accountConfig.randomName ? generatedAccountName() : requiredString(accountConfig.name, 'account.name');
    const username = accountConfig.username || '';
    const password = envOrValue(accountConfig.password, accountConfig.passwordEnv) || generatedPassword();
    const email = await this.generateEmail();
    const account = {
      id: randomId('acct-', 10),
      emailId: email.id,
      email: email.email,
      password,
      name: accountName,
      username,
      status: 'provisioning',
      createdAt: nowIso(),
      agents: {},
      backendKey: {
        calls: 0,
        limit: Number(this.config.limits?.callsPerAccountKey || 500),
        status: 'pending',
      },
    };
    this.state.accounts.push(account);
    await this.saveState();

    log(`generated email ${email.email}`);
    log('solving registration turnstile');
    const registerToken = await solveTurnstile(this.config.turnstile || {}, this.config.turnstile?.registerPageUrl || `${this.baseUrl}/register`, log);
    log('registering account');
    await this.almma('/api/auth/register', {
      method: 'POST',
      body: {
        name: account.name,
        username: account.username,
        email: account.email,
        password: account.password,
        confirm_password: account.password,
        turnstileToken: registerToken,
      },
    });

    log('waiting for verification email');
    const verification = await this.waitForVerificationEmail(account.emailId, log);
    log('verifying email');
    await this.almma('/api/user/verify', {
      method: 'POST',
      body: { email: verification.email || account.email, token: verification.token },
    });

    await this.loginAccount(account, log);
    log('creating backend Agents API key');
    const keyName = `${this.config.backendApiKey?.namePrefix || 'agent-key'}-${randomSuffix(3)}`;
    const apiKey = await this.almma('/api/api-keys', {
      method: 'POST',
      token: account.loginToken,
      body: { name: keyName },
    });
    account.backendKey = {
      id: apiKey.id,
      name: apiKey.name,
      key: apiKey.key,
      keyPrefix: apiKey.keyPrefix,
      calls: 0,
      limit: Number(this.config.limits?.callsPerAccountKey || 500),
      usageDate: utcDayKey(),
      resetAt: nextUtcMidnightIso(),
      status: 'active',
      createdAt: apiKey.createdAt || nowIso(),
      expiresAt: account.expiresAt,
    };
    await this.saveState();

    const instructions = instructionsOverride === undefined ? this.defaultAgentInstructions() : instructionsOverride;
    for (const spec of this.defaultAgentSpecs(instructions)) {
      await this.createAgent(account, spec, log);
    }
    account.status = 'active';
    await this.saveState();
    return account;
  }

  startJob(type, fn) {
    const id = randomId('job-', 8);
    const job = { id, type, status: 'running', logs: [], createdAt: nowIso(), updatedAt: nowIso() };
    this.jobs.set(id, job);
    this.trimJobs();
    const log = (message) => {
      job.logs.push({ at: nowIso(), message });
      job.updatedAt = nowIso();
      if (job.logs.length > 80) job.logs.shift();
      console.log(`[${id}] ${message}`);
    };
    Promise.resolve()
      .then(() => fn(log))
      .then((result) => {
        job.status = 'completed';
        job.result = result;
        job.updatedAt = nowIso();
      })
      .catch((error) => {
        const errorText = error?.stack || error?.message || String(error);
        log(`job failed: ${error?.message || String(error)}`);
        job.status = 'failed';
        job.error = errorText;
        job.updatedAt = nowIso();
      });
    return job;
  }

  trimJobs() {
    const maxJobs = Number(this.config.limits?.maxAdminJobs || 20);
    const jobs = [...this.jobs.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    while (jobs.length > maxJobs) {
      const job = jobs.shift();
      if (!job || job.status === 'running') break;
      this.jobs.delete(job.id);
    }
  }

  async proxyChat(req, res, body) {
    const model = requiredString(body.model, 'body.model');
    const account = this.selectAccountForModel(model);
    if (!account) {
      return sendJson(res, 503, {
        error: {
          message: `No active backend account available for model ${model}`,
          type: 'insufficient_quota',
          code: 'no_active_backend_key',
        },
      });
    }
    const agent = account.agents[model];
    const upstreamBody = {
      ...body,
      model: agent.id,
      messages: normalizeMessagesForAgent(body.messages, this.proxyConfig()),
    };
    if (body.stream) {
      upstreamBody.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }
    const countBefore = account.backendKey.calls || 0;
    account.backendKey.calls = countBefore + 1;
    if (account.backendKey.calls >= account.backendKey.limit) {
      account.backendKey.status = 'daily_exhausted';
      account.backendKey.disabledReason = 'daily_quota_exhausted';
    }
    await this.saveState();

    let upstream;
    try {
      upstream = await fetchWithProxy(`${this.baseUrl}/api/agents/v1/chat/completions`, {
        method: 'POST',
        headers: {
          accept: body.stream ? 'text/event-stream' : 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${account.backendKey.key}`,
        },
        body: JSON.stringify(upstreamBody),
      });
    } catch (error) {
      return sendJson(res, 502, { error: { message: error.message, type: 'upstream_error' } });
    }

    if (body.stream) {
      const upstreamContentType = upstream.headers.get('content-type') || '';
      if (upstreamContentType.includes('text/event-stream')) {
        await streamChatWithUsageNormalization(res, upstream, model);
      } else {
        res.writeHead(upstream.status, {
          'content-type': upstreamContentType || 'application/json',
        });
        for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
        res.end();
      }
      return;
    }

    const text = await upstream.text();
    if ((upstream.headers.get('content-type') || '').includes('application/json') || /^[\s\r\n]*[{\[]/.test(text)) {
      try {
        const bodyJson = JSON.parse(text);
        sendJson(res, upstream.status, normalizeChatCompletionBody(bodyJson, model));
        return;
      } catch {
        // Fall through and return the upstream text unchanged.
      }
    }
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(text);
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function htmlPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Almma 代理管理</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f2;
      --surface: #ffffff;
      --surface-2: #f8faf7;
      --line: #dfe5dc;
      --line-strong: #c8d2c5;
      --text: #18211b;
      --muted: #607064;
      --accent: #176c5f;
      --accent-strong: #0f5449;
      --accent-soft: #e4f2ee;
      --blue: #245eaa;
      --blue-soft: #e8f0fb;
      --amber: #9b5c16;
      --amber-soft: #fff1d6;
      --red: #b42318;
      --red-soft: #fde8e5;
      --shadow: 0 14px 34px rgba(29, 45, 36, .10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 20px; font-weight: 740; }
    h2 { font-size: 16px; font-weight: 720; }
    h3 { font-size: 13px; font-weight: 700; }
    input, textarea, button, select { font: inherit; }
    input, textarea, select {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      padding: 9px 10px;
      color: var(--text);
      background: #fff;
      outline: 0;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(23, 108, 95, .14);
    }
    input[readonly] { background: #f5f7f4; color: #344038; }
    textarea { min-height: 96px; resize: vertical; line-height: 1.45; }
    button {
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 8px 13px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font-weight: 700;
      white-space: nowrap;
    }
    button:hover { background: var(--accent-strong); }
    button.secondary {
      background: #fff;
      border-color: var(--line-strong);
      color: var(--text);
    }
    button.secondary:hover { background: var(--surface-2); }
    button.danger {
      background: #fff;
      border-color: #efb2ac;
      color: var(--red);
    }
    button.danger:hover { background: var(--red-soft); }
    .hidden { display: none !important; }
    .muted { color: var(--muted); font-size: 12px; line-height: 1.45; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .login-page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: linear-gradient(135deg, #edf4ef 0%, #f7f7f2 55%, #eef2f7 100%);
    }
    .login-panel {
      width: min(430px, 100%);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      box-shadow: var(--shadow);
    }
    .brand-row { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 7px;
      background: var(--accent);
      color: #fff;
      font-weight: 800;
      letter-spacing: 0;
    }
    .login-panel form { display: grid; gap: 12px; margin-top: 22px; }
    .error { color: var(--red); font-size: 13px; min-height: 18px; }
    .app-shell { min-height: 100vh; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
      padding: 12px 22px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, .92);
      backdrop-filter: blur(12px);
    }
    .topbar-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .topbar-title .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .top-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .layout {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 20px;
      display: grid;
      grid-template-columns: 286px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .sidebar { display: grid; gap: 14px; position: sticky; top: 84px; }
    .content { display: grid; gap: 14px; min-width: 0; }
    .panel {
      min-width: 0;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 1px rgba(17, 24, 19, .03);
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 48px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }
    .panel-body { padding: 14px; min-width: 0; }
    .panel-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .work-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .field-grid { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
    .field { display: grid; gap: 6px; min-width: 0; color: #2b352e; font-size: 13px; font-weight: 650; }
    .field.full { grid-column: 1 / -1; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(150px, 1fr));
      gap: 10px;
    }
    .metric {
      min-width: 0;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .metric b {
      display: block;
      color: var(--text);
      font-size: 24px;
      line-height: 1.1;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .metric small { display: block; margin-top: 5px; color: var(--muted); font-size: 12px; }
    .info-list { display: grid; gap: 10px; }
    .info-row {
      display: grid;
      gap: 5px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--line);
    }
    .info-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-height: 24px;
      border-radius: 999px;
      padding: 3px 9px;
      background: var(--accent-soft);
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .chip button {
      min-height: 18px;
      padding: 0 5px;
      border: 0;
      background: rgba(15, 84, 73, .12);
      color: var(--accent-strong);
      font-size: 12px;
    }
    .inline-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .toggle-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 42px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-2);
      grid-column: 1 / -1;
    }
    .toggle-line input { width: 18px; height: 18px; accent-color: var(--accent); flex: 0 0 auto; }
    .table-wrap {
      width: 100%;
      max-height: min(58vh, 640px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    #accounts { min-height: 140px; }
    table { width: 100%; min-width: 1080px; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 11px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f7faf6;
      color: #415047;
      font-size: 12px;
      font-weight: 760;
    }
    tr:hover td { background: #fbfcfa; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 760;
      background: #eef1ee;
      color: #49564d;
      white-space: nowrap;
    }
    .status-active { background: #dcf5ea; color: #116145; }
    .status-provisioning, .status-pending { background: var(--blue-soft); color: var(--blue); }
    .status-daily_exhausted { background: var(--amber-soft); color: var(--amber); }
    .status-disabled, .status-failed { background: var(--red-soft); color: var(--red); }
    .empty-state {
      min-height: 120px;
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 13px;
      border: 1px dashed var(--line-strong);
      border-radius: 8px;
      background: var(--surface-2);
      padding: 18px;
      text-align: center;
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 50;
      max-width: min(420px, calc(100vw - 36px));
      border-radius: 8px;
      padding: 11px 13px;
      background: #17211b;
      color: #fff;
      box-shadow: var(--shadow);
      font-size: 13px;
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(24, 33, 27, .34);
    }
    .modal-panel {
      width: min(430px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
      padding: 18px;
    }
    .modal-panel h2 { margin-bottom: 8px; }
    .modal-panel p { color: var(--muted); font-size: 13px; line-height: 1.55; }
    button:disabled {
      cursor: wait;
      opacity: .68;
    }
    @media (max-width: 1120px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric-grid { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
    }
    @media (max-width: 760px) {
      .topbar { align-items: flex-start; flex-direction: column; padding: 12px 14px; }
      .top-actions { width: 100%; justify-content: stretch; }
      .top-actions button { flex: 1 1 0; }
      .layout { padding: 12px; }
      .sidebar, .work-grid, .field-grid, .metric-grid { grid-template-columns: 1fr; }
      .panel-header { align-items: flex-start; flex-direction: column; }
      .panel-actions { width: 100%; }
      .panel-actions button { flex: 1 1 auto; }
      .login-panel { padding: 20px; }
      .metric b { font-size: 21px; }
    }
  </style>
</head>
<body>
  <div id="loginView" class="login-page">
    <section class="login-panel" aria-label="登录">
      <div class="brand-row">
        <div class="brand-mark">A</div>
        <div>
          <h1>Almma 代理管理</h1>
          <div class="muted">almma.mui.moe</div>
        </div>
      </div>
      <form onsubmit="login(event)">
        <label class="field">管理员密钥 <input id="loginAdminKey" type="password" placeholder="adm-..." autocomplete="current-password" autofocus></label>
        <button type="submit">进入</button>
        <div id="loginError" class="error"></div>
      </form>
    </section>
  </div>
  <div id="appView" class="hidden">
    <header class="topbar">
      <div class="topbar-title">
        <div class="brand-mark">A</div>
        <div>
          <h1>Almma 代理管理</h1>
          <div class="muted">127.0.0.1 反代：almma.mui.moe</div>
        </div>
      </div>
      <div class="top-actions">
        <button class="secondary" onclick="loadState()">刷新</button>
        <button class="secondary" onclick="logout()">退出</button>
      </div>
    </header>
    <main class="layout">
      <aside class="sidebar">
        <section class="panel">
          <div class="panel-header">
            <h2>服务</h2>
          </div>
          <div class="panel-body info-list">
            <div class="info-row">
              <h3>服务密钥</h3>
              <input id="serviceKey" class="mono" readonly>
            </div>
            <div class="info-row">
              <h3>模型</h3>
              <div id="modelList" class="chip-row"></div>
            </div>
            <div class="info-row">
              <h3>额度刷新</h3>
              <div id="dailyReset" class="muted"></div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>维护</h2>
          </div>
          <div class="panel-body panel-actions">
            <button class="danger" onclick="cleanupAccounts()">清理失败/中断账号</button>
          </div>
        </section>
      </aside>
      <section class="content">
        <div id="summary" class="metric-grid"></div>
        <section class="panel">
          <div class="panel-header">
            <h2>后台设置</h2>
            <div class="panel-actions">
              <button onclick="saveSettings()">保存设置</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="field-grid">
              <label class="field">有效账号上限 <input id="maxEffectiveAccounts" type="number" min="1" max="100" value="5"></label>
              <label class="field">System 消息处理
                <select id="proxySystemMessageMode">
                  <option value="leading_system_convert_rest">头部 system，后续转 user</option>
                  <option value="merge_system_to_first">全部合并为首条 system</option>
                  <option value="keep_first_system_convert_rest">仅保留第 1 条 system</option>
                </select>
              </label>
              <label class="toggle-line">
                <span>
                  <strong>自动补齐账号池</strong>
                  <span class="muted">有效账号低于上限时自动注册</span>
                </span>
                <input id="autoProvisionEnabled" type="checkbox">
              </label>
              <label class="field full">默认 Agent 系统提示词
                <textarea id="defaultInstructions" placeholder="留空则创建无系统提示词 Agent"></textarea>
              </label>
              <div class="field full">
                <span>默认 Agent 列表</span>
                <div class="field-grid">
                  <label class="field">提供商列表
                    <select id="defaultProviderSelect" onchange="onDefaultProviderSelected()"></select>
                  </label>
                  <label class="field">模型列表
                    <select id="defaultModelSelect" onchange="onDefaultModelSelected()"></select>
                  </label>
                  <label class="field">自定义提供商 <input id="defaultProviderCustom" placeholder="Azure Anthropic"></label>
                  <label class="field">自定义模型 <input id="defaultModelCustom" placeholder="claude-opus-4-5"></label>
                </div>
                <div class="inline-actions">
                  <button type="button" onclick="addDefaultAgent()">加入默认列表</button>
                  <button type="button" class="secondary" onclick="loadUpstreamModels(true)">刷新模型列表</button>
                </div>
                <div id="defaultAgents" class="chip-row"></div>
              </div>
            </div>
          </div>
        </section>
        <div class="work-grid">
          <section class="panel">
            <div class="panel-header">
              <h2>创建账号</h2>
              <div class="panel-actions">
                <button onclick="provision()">启动创建</button>
              </div>
            </div>
            <div class="panel-body">
              <div class="field-grid">
                <label class="field">数量 <input id="provisionCount" type="number" min="1" max="100" value="1"></label>
                <label class="field full">本次 Agent 系统提示词覆盖
                  <textarea id="instructions" placeholder="留空使用后台设置；后台设置为空则无系统提示词"></textarea>
                </label>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-header">
              <h2>创建 Agent</h2>
              <div class="panel-actions">
                <button id="createAgentButton" onclick="createAgent()">测试并创建 Agent</button>
              </div>
            </div>
            <div class="panel-body">
              <div class="field-grid">
                <label class="field">测试账号 <select id="agentAccountId"></select></label>
                <label class="field">提供商列表
                  <select id="agentProviderSelect" onchange="onAgentProviderSelected()"></select>
                </label>
                <label class="field">模型列表
                  <select id="agentModelSelect" onchange="onAgentModelSelected()"></select>
                </label>
                <label class="field">自定义提供商 <input id="agentProvider" value="Azure Anthropic"></label>
                <label class="field">自定义模型 <input id="agentBackendModel" value="claude-opus-4-5"></label>
                <label class="field">对外模型名 <input id="agentExposedName" value="Azure-Anthropic/claude-opus-4-5"></label>
                <label class="field">Agent 名称 <input id="agentName" value="Azure-Anthropic/claude-opus-4-5"></label>
                <label class="field full">Agent 指令 <textarea id="agentInstructions"></textarea></label>
              </div>
            </div>
          </section>
        </div>
        <section class="panel">
          <div class="panel-header">
            <h2>账号池</h2>
            <div id="accountHint" class="muted"></div>
          </div>
          <div class="panel-body">
            <div id="accounts" class="table-wrap"></div>
          </div>
        </section>
      </section>
    </main>
  </div>
  <div id="toast" class="toast hidden"></div>
  <div id="modalOverlay" class="modal-overlay hidden">
    <section class="modal-panel" role="status" aria-live="polite">
      <h2 id="modalTitle">处理中</h2>
      <p id="modalMessage"></p>
    </section>
  </div>
  <script>
    const loginView = document.getElementById('loginView');
    const appView = document.getElementById('appView');
    const loginAdminKeyInput = document.getElementById('loginAdminKey');
    const loginError = document.getElementById('loginError');
    const toast = document.getElementById('toast');
    const modalOverlay = document.getElementById('modalOverlay');
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const createAgentButton = document.getElementById('createAgentButton');
    let adminKey = localStorage.getItem('almma-admin-key') || '';
    let refreshTimer = null;
    let toastTimer = null;
    let currentState = null;
    let upstreamModels = {};
    let defaultAgents = [];
    let settingsDirty = false;
    loginAdminKeyInput.value = adminKey;
    function authHeaders() {
      return { 'content-type': 'application/json', authorization: 'Bearer ' + adminKey };
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, function (char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }
    function setValue(id, value) {
      const el = document.getElementById(id);
      if (!el || document.activeElement === el) return;
      el.value = value == null ? '' : value;
    }
    function showToast(message) {
      toast.textContent = message;
      toast.classList.remove('hidden');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.classList.add('hidden'); }, 3000);
    }
    function showModal(title, message) {
      modalTitle.textContent = title;
      modalMessage.textContent = message;
      modalOverlay.classList.remove('hidden');
    }
    function hideModal() {
      modalOverlay.classList.add('hidden');
    }
    function setAgentBusy(busy, message) {
      createAgentButton.disabled = busy;
      createAgentButton.textContent = busy ? '处理中...' : '测试并创建 Agent';
      if (busy) showModal('创建 Agent', message || '正在处理，请稍候。');
      else hideModal();
    }
    function statusLabel(value) {
      const labels = {
        active: '可用',
        pending: '等待中',
        provisioning: '创建中',
        disabled: '已禁用',
        daily_exhausted: '今日额度已用尽',
        failed: '失败'
      };
      return labels[value] || value || '';
    }
    function statusClass(value) {
      return 'status-pill status-' + String(value || '').replace(/[^a-z0-9_-]/gi, '');
    }
    function reasonLabel(value) {
      const labels = {
        expired: '已过期',
        quota_exhausted: '调用次数已用尽',
        daily_quota_exhausted: '今日调用额度已用尽',
        provisioning_interrupted: '创建流程已中断'
      };
      return labels[value] || value || '';
    }
    function formatBeijingTime(value) {
      if (!value) return '';
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(value));
    }
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) {
        const error = new Error(typeof body === 'string' ? body : (body && body.error && body.error.message) || body.message || JSON.stringify(body));
        error.body = body;
        throw error;
      }
      return body;
    }
    function showLogin(message = '') {
      appView.classList.add('hidden');
      loginView.classList.remove('hidden');
      loginError.textContent = message;
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      loginAdminKeyInput.focus();
    }
    function showApp() {
      loginView.classList.add('hidden');
      appView.classList.remove('hidden');
      loginError.textContent = '';
      if (!refreshTimer) refreshTimer = setInterval(loadState, 5000);
    }
    function renderMetrics(state) {
      const max = state.limits.maxEffectiveAccounts;
      const autoText = state.settings.autoProvisionEnabled ? '自动补齐已开启' : '自动补齐已关闭';
      return [
        ['账号总数', state.accounts.length, autoText],
        ['有效账号', state.effectiveAccounts + '/' + max, '未过期且有可用 key'],
        ['可用账号', state.availableAccounts, '未触发今日额度上限'],
        ['今日调用', state.callsToday + '/' + state.dailyLimitTotal, '按北京时间统计刷新'],
        ['今日剩余', state.remainingToday, '剩余可路由调用数']
      ].map(function (item) {
        return '<div class="metric"><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b><small>' + escapeHtml(item[2]) + '</small></div>';
      }).join('');
    }
    function renderModels(models) {
      if (!models.length) return '<span class="muted">暂无可用模型</span>';
      return models.map(function (model) {
        return '<span class="chip">' + escapeHtml(model.id) + '</span>';
      }).join('');
    }
    function providerSlug(value) {
      return String(value || '').trim().replace(/\\s+/g, '-');
    }
    function exposedName(provider, model) {
      return providerSlug(provider) + '/' + String(model || '').trim();
    }
    function providerNames() {
      return Object.keys(upstreamModels || {}).sort(function (a, b) { return a.localeCompare(b); });
    }
    function fillSelect(select, values, emptyText) {
      select.innerHTML = '';
      if (!values.length) {
        select.innerHTML = '<option value="">' + escapeHtml(emptyText || '无') + '</option>';
        return;
      }
      select.innerHTML = values.map(function (value) {
        return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>';
      }).join('');
    }
    function refreshProviderSelects() {
      const providers = providerNames();
      fillSelect(document.getElementById('defaultProviderSelect'), providers, '暂无模型列表');
      fillSelect(document.getElementById('agentProviderSelect'), providers, '暂无模型列表');
      onDefaultProviderSelected();
      onAgentProviderSelected();
    }
    function onDefaultProviderSelected() {
      const provider = document.getElementById('defaultProviderSelect').value;
      fillSelect(document.getElementById('defaultModelSelect'), upstreamModels[provider] || [], '暂无模型');
      onDefaultModelSelected();
    }
    function onDefaultModelSelected() {
      const provider = document.getElementById('defaultProviderSelect').value;
      const model = document.getElementById('defaultModelSelect').value;
      if (provider) setValue('defaultProviderCustom', provider);
      if (model) setValue('defaultModelCustom', model);
    }
    function onAgentProviderSelected() {
      const provider = document.getElementById('agentProviderSelect').value;
      fillSelect(document.getElementById('agentModelSelect'), upstreamModels[provider] || [], '暂无模型');
      onAgentModelSelected();
    }
    function onAgentModelSelected() {
      const provider = document.getElementById('agentProviderSelect').value;
      const model = document.getElementById('agentModelSelect').value;
      if (provider) document.getElementById('agentProvider').value = provider;
      if (model) document.getElementById('agentBackendModel').value = model;
      syncAgentNames();
    }
    function syncAgentNames() {
      const provider = document.getElementById('agentProvider').value.trim();
      const model = document.getElementById('agentBackendModel').value.trim();
      if (!provider || !model) return;
      const name = exposedName(provider, model);
      document.getElementById('agentExposedName').value = name;
      document.getElementById('agentName').value = name;
    }
    function addDefaultAgent() {
      const provider = document.getElementById('defaultProviderCustom').value.trim() || document.getElementById('defaultProviderSelect').value.trim();
      const model = document.getElementById('defaultModelCustom').value.trim() || document.getElementById('defaultModelSelect').value.trim();
      if (!provider || !model) return alert('请填写提供商和模型名。');
      const spec = { provider, model, exposedModelName: exposedName(provider, model), name: exposedName(provider, model) };
      if (!defaultAgents.some(function (agent) { return agent.exposedModelName === spec.exposedModelName; })) defaultAgents.push(spec);
      settingsDirty = true;
      renderDefaultAgents();
    }
    async function removeDefaultAgent(index) {
      const agent = defaultAgents[index];
      if (!agent) return;
      const name = agent.exposedModelName || exposedName(agent.provider, agent.model);
      if (!confirm('确认删除 ' + name + '？\\n\\n这会从默认 Agent 列表移除，并删除所有现有账号上的对应 Agent。')) return;
      try {
        showModal('删除 Agent', '正在删除本地配置和所有现有账号上的对应 Agent。');
        const result = await api('/admin/api/delete-agent-model', {
          method: 'POST',
          body: JSON.stringify({ exposedModelName: name })
        });
        settingsDirty = false;
        await loadState();
        const ok = result.results.filter(function (item) { return item.ok; }).length;
        const failed = result.results.length - ok;
        hideModal();
        alert('删除完成：上游删除成功 ' + ok + ' 个，失败 ' + failed + ' 个；本地记录已移除。');
      } catch (error) {
        hideModal();
        alert('删除失败：\\n' + error.message);
        await loadState();
      }
    }
    function renderDefaultAgents() {
      const el = document.getElementById('defaultAgents');
      if (!defaultAgents.length) {
        el.innerHTML = '<span class="muted">暂无默认 Agent</span>';
        return;
      }
      el.innerHTML = defaultAgents.map(function (agent, index) {
        return '<span class="chip">' + escapeHtml(agent.exposedModelName || exposedName(agent.provider, agent.model)) + '<button type="button" onclick="removeDefaultAgent(' + index + ')">×</button></span>';
      }).join('');
    }
    function renderAccountOptions(accounts) {
      const available = accounts.filter(function (a) { return a.status === 'active' && a.backendKey && a.backendKey.status === 'active'; });
      document.getElementById('agentAccountId').innerHTML = available.map(function (a) {
        return '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.email + ' · ' + a.id) + '</option>';
      }).join('');
    }
    async function loadUpstreamModels(force) {
      try {
        const payload = await api('/admin/api/upstream-models' + (force ? '?force=1' : ''));
        upstreamModels = payload.models || {};
        refreshProviderSelects();
        showToast(force ? '模型列表已刷新' : '模型列表已加载');
      } catch (error) {
        showToast('模型列表加载失败：' + error.message);
      }
    }
    function renderState(state) {
      currentState = state;
      setValue('serviceKey', state.serviceApiKey || '');
      setValue('maxEffectiveAccounts', state.settings.maxEffectiveAccounts || state.limits.maxEffectiveAccounts || 5);
      setValue('proxySystemMessageMode', state.settings.proxySystemMessageMode || 'leading_system_convert_rest');
      setValue('defaultInstructions', state.settings.agentInstructions || '');
      if (!settingsDirty) {
        defaultAgents = (state.settings.defaultAgents || []).map(function (agent) {
          return { ...agent, exposedModelName: agent.exposedModelName || exposedName(agent.provider, agent.model), name: agent.name || agent.exposedModelName || exposedName(agent.provider, agent.model) };
        });
      }
      document.getElementById('autoProvisionEnabled').checked = state.settings.autoProvisionEnabled !== false;
      document.getElementById('provisionCount').max = state.settings.maxEffectiveAccounts || state.limits.maxEffectiveAccounts || 100;
      document.getElementById('summary').innerHTML = renderMetrics(state);
      document.getElementById('modelList').innerHTML = renderModels(state.supportedModels || []);
      document.getElementById('dailyReset').textContent = formatBeijingTime(state.limits.dailyResetAt) + ' · ' + state.limits.dailyResetLabel;
      document.getElementById('accountHint').textContent = state.effectiveAccounts + '/' + state.limits.maxEffectiveAccounts + ' 有效';
      document.getElementById('accounts').innerHTML = renderAccounts(state.accounts);
      renderAccountOptions(state.accounts || []);
      renderDefaultAgents();
    }
    async function login(event) {
      if (event) event.preventDefault();
      adminKey = loginAdminKeyInput.value.trim();
      if (!adminKey) {
        showLogin('请输入管理员密钥。');
        return;
      }
      try {
        const state = await api('/admin/api/state');
        localStorage.setItem('almma-admin-key', adminKey);
        showApp();
        renderState(state);
        loadUpstreamModels(false);
      } catch (error) {
        localStorage.removeItem('almma-admin-key');
        showLogin('管理员密钥无效或服务不可用。');
      }
    }
    function logout() {
      adminKey = '';
      localStorage.removeItem('almma-admin-key');
      loginAdminKeyInput.value = '';
      showLogin();
    }
    async function loadState() {
      try {
        const state = await api('/admin/api/state');
        showApp();
        renderState(state);
      } catch (error) {
        showLogin('登录已失效，请重新输入管理员密钥。');
      }
    }
    function renderAccounts(accounts) {
      if (!accounts.length) return '<div class="muted">暂无账号。</div>';
      return '<table><thead><tr><th>账号 ID</th><th>名称 / 邮箱</th><th>状态</th><th>今日调用</th><th>今日剩余</th><th>刷新时间</th><th>过期时间</th><th>Agent</th></tr></thead><tbody>' +
        accounts.map(function (a) {
          const reason = reasonLabel(a.disabledReason || (a.backendKey && a.backendKey.disabledReason));
          const agents = Object.keys(a.agents || {}).map(escapeHtml).join('<br>');
          return '<tr>' +
            '<td class="mono">' + escapeHtml(a.id) + '</td>' +
            '<td><strong>' + escapeHtml(a.name || '') + '</strong><br><span class="muted">' + escapeHtml(a.email) + '</span></td>' +
            '<td><span class="' + statusClass(a.status) + '">' + escapeHtml(statusLabel(a.status)) + '</span>' + (reason ? '<br><span class="muted">' + escapeHtml(reason) + '</span>' : '') + '</td>' +
            '<td>' + (a.backendKey ? escapeHtml((a.backendKey.calls || 0) + '/' + (a.backendKey.limit || 0)) : '') + '</td>' +
            '<td>' + (a.backendKey ? escapeHtml(a.backendKey.remaining) : '') + '</td>' +
            '<td>' + (a.backendKey ? escapeHtml(formatBeijingTime(a.backendKey.resetAt)) : '') + '</td>' +
            '<td>' + (a.expiresAt ? escapeHtml(formatBeijingTime(a.expiresAt)) : '') + '<br><span class="muted">' + escapeHtml(a.expiresAtSource || '') + '</span></td>' +
            '<td>' + (agents || '<span class="muted">无</span>') + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    }
    async function provision() {
      const count = Number(document.getElementById('provisionCount').value || 1);
      const instructions = document.getElementById('instructions').value;
      const body = { count };
      if (instructions.trim()) body.instructions = instructions;
      const job = await api('/admin/api/provision', { method: 'POST', body: JSON.stringify(body) });
      showToast('已启动任务 ' + job.id);
      loadState();
    }
    async function saveSettings() {
      const maxEffectiveAccounts = Number(document.getElementById('maxEffectiveAccounts').value || 5);
      const agentInstructions = document.getElementById('defaultInstructions').value;
      const proxySystemMessageMode = document.getElementById('proxySystemMessageMode').value;
      const autoProvisionEnabled = document.getElementById('autoProvisionEnabled').checked;
      const state = await api('/admin/api/settings', { method: 'POST', body: JSON.stringify({ maxEffectiveAccounts, agentInstructions, proxySystemMessageMode, autoProvisionEnabled, defaultAgents }) });
      settingsDirty = false;
      renderState(state);
      showToast('设置已保存');
    }
    async function cleanupAccounts() {
      const result = await api('/admin/api/cleanup-accounts', { method: 'POST', body: JSON.stringify({ includeProvisioning: true, includeFailed: true }) });
      showToast('已清理 ' + result.removed + ' 个账号记录');
      loadState();
    }
    function readAgentBody() {
      syncAgentNames();
      return {
        accountId: document.getElementById('agentAccountId').value,
        exposedModelName: document.getElementById('agentExposedName').value,
        provider: document.getElementById('agentProvider').value,
        model: document.getElementById('agentBackendModel').value,
        name: document.getElementById('agentName').value,
        instructions: document.getElementById('agentInstructions').value
      };
    }
    async function createAgent() {
      const body = readAgentBody();
      if (!body.accountId) return alert('没有可用测试账号。');
      try {
        setAgentBusy(true, '正在创建 Agent 并进行最小调用测试。这个步骤可能需要几十秒。');
        const result = await api('/admin/api/create-agent', { method: 'POST', body: JSON.stringify(body) });
        hideModal();
        alert('最小调用测试成功：' + result.spec.exposedModelName);
        const addAll = confirm('是否添加到当前所有可用账号，并写入默认 Agent 列表？');
        if (addAll) {
          showModal('批量添加 Agent', '正在添加到所有可用账号，并写入默认 Agent 列表。这个步骤会逐个账号创建，请等待完成提示。');
          const bulk = await api('/admin/api/create-agent-all', {
            method: 'POST',
            body: JSON.stringify({ ...body, skipAccountId: result.account.id, persistDefault: true })
          });
          const ok = bulk.results.filter(function (item) { return item.ok; }).length;
          const failed = bulk.results.length - ok;
          hideModal();
          alert('批量添加完成：成功 ' + ok + ' 个，失败 ' + failed + ' 个。已写入默认 Agent 列表。');
        }
        await loadState();
      } catch (error) {
        const cleanup = error.body && error.body.error && error.body.error.cleanup;
        const cleanupText = cleanup ? '\\n\\n清理结果：' + (cleanup.ok ? '已删除上游临时 Agent' : cleanup.error || '清理失败') : '';
        alert('Agent 测试失败：\\n' + error.message + cleanupText);
        await loadState();
      } finally {
        setAgentBusy(false);
      }
    }
    document.getElementById('agentProvider').addEventListener('input', syncAgentNames);
    document.getElementById('agentBackendModel').addEventListener('input', syncAgentNames);
    if (adminKey) {
      login();
    } else {
      showLogin();
    }
  </script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const envPath = path.resolve(path.dirname(configPath), args.envFile);
  ENV_FILE = await loadEnvFile(envPath);
  const config = await readJsonFile(configPath);
  if (!config) throw new Error(`Config file not found: ${configPath}`);
  configureOutboundProxy(config);
  defaultAgentSpecs(config, 'config-check-instructions');
  if (args.checkConfig) {
    console.log(`Config OK: ${configPath}`);
    return;
  }
  const service = new AlmmaService(config, configPath);
  await service.init();
  service.ensureAccountPool('startup');
  const autoProvisionIntervalMs = Math.max(15000, Number(config.limits?.autoProvisionIntervalMs || 60000));
  const autoProvisionTimer = setInterval(() => service.ensureAccountPool('timer'), autoProvisionIntervalMs);
  autoProvisionTimer.unref?.();
  const listen = config.listen || {};
  const host = listen.host || '127.0.0.1';
  const port = Number(listen.port || 8787);

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith('/admin/api/')) {
        service.assertAdmin(req);
        if (req.method === 'GET' && url.pathname === '/admin/api/state') {
          sendJson(res, 200, service.publicState());
          return;
        }
        if (req.method === 'GET' && url.pathname === '/admin/api/upstream-models') {
          const force = url.searchParams.get('force') === '1';
          const accountId = url.searchParams.get('accountId') || '';
          sendJson(res, 200, await service.upstreamModels({ force, accountId }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/provision') {
          const body = await readRequestJson(req);
          const count = Math.max(1, Math.min(Number(body.count || 1), 100));
          service.assertProvisionCapacity(count);
          const job = service.startJob('provision', async (log) => {
            const accounts = [];
            for (let i = 0; i < count; i += 1) {
              log(`provisioning account ${i + 1}/${count}`);
              const instructionsOverride = body.instructions === undefined || body.instructions === null ? undefined : String(body.instructions);
              const account = await service.provisionAccount({ instructionsOverride, log });
              accounts.push(publicAccount(account));
            }
            return { accounts };
          });
          sendJson(res, 202, job);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/settings') {
          const body = await readRequestJson(req);
          sendJson(res, 200, await service.updateSettings(body));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/create-agent') {
          const body = await readRequestJson(req);
          const account = service.accountById(requiredString(body.accountId, 'accountId'));
          if (!account) return sendJson(res, 404, { error: 'account not found' });
          const spec = {
            exposedModelName: body.exposedModelName || '',
            name: body.name || body.exposedModelName || '',
            provider: requiredString(body.provider, 'provider'),
            model: requiredString(body.model, 'model'),
            instructions: body.instructions == null ? '' : String(body.instructions),
            artifacts: body.artifacts || '',
            description: body.description || '',
            edges: Array.isArray(body.edges) ? body.edges : [],
            category: body.category || 'general',
            support_contact: body.support_contact || { name: '', email: '' },
            tool_options: body.tool_options || {},
            conversation_starters: Array.isArray(body.conversation_starters) ? body.conversation_starters : [],
            tools: Array.isArray(body.tools) ? body.tools : [],
          };
          if (nonEmptyPlainObject(body.model_parameters)) spec.model_parameters = body.model_parameters;
          console.log(`[admin] create-agent start account=${account.id} model=${spec.exposedModelName || `${spec.provider}/${spec.model}`}`);
          const result = await service.createAndTestAgent(account, spec, (message) => {
            console.log(`[admin] create-agent account=${account.id} ${message}`);
          });
          console.log(`[admin] create-agent ok account=${account.id} model=${result.spec.exposedModelName} agent=${result.agent.id}`);
          sendJson(res, 200, result);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/create-agent-all') {
          const body = await readRequestJson(req);
          const spec = {
            exposedModelName: body.exposedModelName || '',
            name: body.name || body.exposedModelName || '',
            provider: requiredString(body.provider, 'provider'),
            model: requiredString(body.model, 'model'),
            instructions: body.instructions == null ? '' : String(body.instructions),
            artifacts: body.artifacts || '',
            description: body.description || '',
            edges: Array.isArray(body.edges) ? body.edges : [],
            category: body.category || 'general',
            support_contact: body.support_contact || { name: '', email: '' },
            tool_options: body.tool_options || {},
            conversation_starters: Array.isArray(body.conversation_starters) ? body.conversation_starters : [],
            tools: Array.isArray(body.tools) ? body.tools : [],
          };
          if (nonEmptyPlainObject(body.model_parameters)) spec.model_parameters = body.model_parameters;
          console.log(`[admin] create-agent-all start model=${spec.exposedModelName || `${spec.provider}/${spec.model}`} skip=${body.skipAccountId || '-'} persistDefault=${body.persistDefault !== false}`);
          const result = await service.createAgentAcrossActiveAccounts(spec, {
            persistDefault: body.persistDefault !== false,
            skipAccountId: body.skipAccountId || '',
          }, (message) => {
            console.log(`[admin] create-agent-all ${message}`);
          });
          const ok = result.results.filter((item) => item.ok).length;
          const failed = result.results.length - ok;
          console.log(`[admin] create-agent-all done model=${result.spec.exposedModelName} ok=${ok} failed=${failed} persistDefault=${body.persistDefault !== false}`);
          sendJson(res, 200, result);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/delete-agent-model') {
          const body = await readRequestJson(req);
          const exposedModelName = requiredString(body.exposedModelName, 'exposedModelName');
          console.log(`[admin] delete-agent-model start model=${exposedModelName}`);
          const result = await service.deleteAgentModelEverywhere(exposedModelName, (message) => {
            console.log(`[admin] delete-agent-model ${message}`);
          });
          const ok = result.results.filter((item) => item.ok).length;
          const failed = result.results.length - ok;
          console.log(`[admin] delete-agent-model done model=${exposedModelName} ok=${ok} failed=${failed} defaultRemoved=${result.defaultRemoved}`);
          sendJson(res, 200, result);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/rotate-service-key') {
          service.state.serviceApiKey = randomId('svc-');
          await service.saveState();
          sendJson(res, 200, { serviceApiKey: service.state.serviceApiKey });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/cleanup-accounts') {
          const body = await readRequestJson(req);
          const result = await service.cleanupAccounts({
            includeProvisioning: body.includeProvisioning !== false,
            includeFailed: body.includeFailed !== false,
          });
          const autoProvisionJob = service.ensureAccountPool('cleanup');
          sendJson(res, 200, { ...result, autoProvisionJob });
          return;
        }
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        service.assertService(req);
        sendJson(res, 200, { object: 'list', data: service.supportedModels() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        service.assertService(req);
        const body = await readRequestJson(req);
        await service.proxyChat(req, res, body);
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const pathname = url?.pathname || req.url || '<unknown>';
      console.error(`[error] ${req.method} ${pathname}: ${error.stack || error.message}`);
      const payload = { message: error.message, type: 'server_error' };
      if (error.cleanup) payload.cleanup = error.cleanup;
      sendJson(res, error.statusCode || 500, { error: payload });
    }
  });

  server.listen(port, host, () => {
    console.log(`Almma OpenAI-compatible service: http://${host}:${port}`);
    console.log(`Admin UI: http://${host}:${port}/admin`);
    console.log(`Service key: ${service.state.serviceApiKey}`);
    console.log(`Admin key: ${service.state.adminApiKey}`);
    console.log(`State file: ${service.stateFile}`);
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
