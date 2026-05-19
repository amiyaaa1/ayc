#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const env = process.env;
const baseUrl = env.ALMMA_BASE_URL || 'https://chat.almma.ai';
const endpoint = env.ALMMA_ENDPOINT || 'Azure Anthropic';
const model = env.ALMMA_MODEL || 'claude-opus-4-5';
const message = env.ALMMA_MESSAGE || 'hi';
const useBearer = env.ALMMA_USE_BEARER !== '0';

function required(name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it in the environment.`);
  }
  return value;
}

function localTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function authHeaders(token) {
  return token && useBearer ? { Authorization: `Bearer ${token}` } : {};
}

async function readJsonResponse(res) {
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body);
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return body;
}

async function requestJson(path, { method = 'GET', token, body } = {}) {
  const url = new URL(path, baseUrl);
  const headers = {
    Accept: 'application/json',
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    ...authHeaders(token),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJsonResponse(res);
}

function decodeJwtPayload(token) {
  const [, payload] = token.split('.');
  if (!payload) return null;
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

async function verifyTurnstileIfRequested(turnstileToken) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return;

  const params = new URLSearchParams();
  params.set('secret', secret);
  params.set('response', turnstileToken);
  if (env.TURNSTILE_REMOTE_IP) {
    params.set('remoteip', env.TURNSTILE_REMOTE_IP);
  }

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const result = await readJsonResponse(res);
  if (!result.success) {
    throw new Error(`Turnstile siteverify failed: ${JSON.stringify(result)}`);
  }
  console.log(`Turnstile verified for hostname: ${result.hostname || '<unknown>'}`);
}

async function login() {
  const email = required('ALMMA_EMAIL');
  const password = required('ALMMA_PASSWORD');
  const turnstileToken = required('TURNSTILE_TOKEN');

  await verifyTurnstileIfRequested(turnstileToken);

  const result = await requestJson('/api/auth/login', {
    method: 'POST',
    body: { email, password, turnstileToken },
  });
  if (!result?.token) {
    throw new Error(`Login response did not include token: ${JSON.stringify(result)}`);
  }

  const payload = decodeJwtPayload(result.token);
  if (payload?.exp) {
    console.log(`Logged in. JWT expires at ${new Date(payload.exp * 1000).toISOString()}`);
  } else {
    console.log('Logged in.');
  }
  return result.token;
}

async function warmup(token) {
  const [config, models, keyState] = await Promise.all([
    requestJson('/api/config', { token }),
    requestJson('/api/models', { token }),
    requestJson(`/api/keys?name=${encodeURIComponent(endpoint)}`, { token }),
  ]);

  console.log(`Config appTitle: ${config?.appTitle || '<unknown>'}`);
  console.log(`Model provider "${endpoint}" available: ${Array.isArray(models?.[endpoint])}`);
  console.log(`Provider key expiresAt: ${keyState?.expiresAt ?? null}`);
}

async function sendChat(token) {
  const conversationId = env.ALMMA_CONVERSATION_ID || undefined;
  const body = {
    text: message,
    sender: 'User',
    clientTimestamp: localTimestamp(),
    isCreatedByUser: true,
    parentMessageId: env.ALMMA_PARENT_MESSAGE_ID || '00000000-0000-0000-0000-000000000000',
    ...(conversationId ? { conversationId } : {}),
    messageId: randomUUID(),
    error: false,
    endpoint,
    endpointType: env.ALMMA_ENDPOINT_TYPE || 'custom',
    model,
    ...(env.ALMMA_MODEL_LABEL ? { modelLabel: env.ALMMA_MODEL_LABEL } : {}),
    ...(env.ALMMA_PROMPT_PREFIX ? { promptPrefix: env.ALMMA_PROMPT_PREFIX } : {}),
    ...(env.ALMMA_RESEND_FILES ? { resendFiles: env.ALMMA_RESEND_FILES !== '0' } : {}),
    ...(env.ALMMA_MAX_CONTEXT_TOKENS ? { maxContextTokens: Number(env.ALMMA_MAX_CONTEXT_TOKENS) } : {}),
    ...(env.ALMMA_MAX_TOKENS ? { max_tokens: Number(env.ALMMA_MAX_TOKENS) } : {}),
    ...(env.ALMMA_TEMPERATURE ? { temperature: Number(env.ALMMA_TEMPERATURE) } : {}),
    ...(env.ALMMA_USE_RESPONSES_API ? { useResponsesApi: env.ALMMA_USE_RESPONSES_API !== '0' } : {}),
    key: env.ALMMA_PROVIDER_KEY_SENTINEL || 'never',
    modelDisplayLabel: env.ALMMA_MODEL_DISPLAY_LABEL || endpoint,
    isTemporary: env.ALMMA_IS_TEMPORARY === '1',
    isRegenerate: false,
    isContinued: false,
  };

  const path = `/api/agents/chat/${encodeURIComponent(endpoint)}`;
  const result = await requestJson(path, { method: 'POST', token, body });
  console.log(`Chat started. conversationId=${result.conversationId} streamId=${result.streamId}`);
  return result;
}

function collectTextFromDelta(data) {
  const chunks = data?.data?.delta?.content;
  if (!Array.isArray(chunks)) return '';
  return chunks
    .filter((chunk) => chunk.type === 'text' && typeof chunk.text === 'string')
    .map((chunk) => chunk.text)
    .join('');
}

async function streamChat(token, streamId) {
  const url = new URL(`/api/agents/chat/stream/${streamId}`, baseUrl);
  const res = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      ...authHeaders(token),
    },
  });
  if (!res.ok) {
    throw new Error(`SSE failed: ${res.status} ${res.statusText} ${await res.text()}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let assistantText = '';
  let finalPayload = null;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!dataLine) continue;
      let data;
      try {
        data = JSON.parse(dataLine);
      } catch {
        continue;
      }
      assistantText += collectTextFromDelta(data);
      if (data.final) {
        finalPayload = data;
      }
    }
  }

  if (assistantText) {
    console.log('\nAssistant text:');
    console.log(assistantText);
  }
  if (finalPayload?.responseMessage?.content) {
    const errors = finalPayload.responseMessage.content.filter((item) => item.type === 'error');
    if (errors.length) {
      console.log('\nResponse errors:');
      for (const item of errors) console.log(item.error);
    }
  }
  if (finalPayload?.conversation) {
    console.log(`\nFinal conversation tokenLimitReached=${finalPayload.conversation.tokenLimitReached}`);
  }
}

async function main() {
  if (!env.TURNSTILE_TOKEN) {
    console.error('TURNSTILE_TOKEN is required. The Turnstile secret can verify a widget token, but it cannot mint one.');
    process.exit(1);
  }

  const token = await login();
  if (env.ALMMA_SKIP_WARMUP !== '1') {
    await warmup(token);
  }
  const chat = await sendChat(token);
  if (env.ALMMA_SKIP_STREAM !== '1') {
    await streamChat(token, chat.streamId);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
