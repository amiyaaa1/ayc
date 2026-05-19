#!/usr/bin/env node

const baseUrl = process.env.ALMMA_BASE_URL || 'https://chat.almma.ai';
const apiKey = process.env.ALMMA_AGENTS_API_KEY;
const model = process.env.ALMMA_AGENT_ID;

if (!apiKey) {
  console.error('Missing ALMMA_AGENTS_API_KEY. This must be a LibreChat Agents API key, not the /api/auth/login JWT.');
  process.exit(1);
}

async function request(path, options = {}) {
  const res = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function listModels() {
  const result = await request('/api/agents/v1/models');
  console.log(JSON.stringify(result, null, 2));
}

async function chatCompletions() {
  if (!model) {
    console.error('Missing ALMMA_AGENT_ID. Run without ALMMA_AGENT_ID first to list available agents.');
    process.exit(1);
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: process.env.ALMMA_SYSTEM || 'You are a concise assistant.' },
      { role: 'user', content: process.env.ALMMA_USER_1 || '请回复：role 测试第一轮。' },
      { role: 'assistant', content: process.env.ALMMA_ASSISTANT_1 || '收到，这是第一轮助手消息。' },
      { role: 'user', content: process.env.ALMMA_MESSAGE || '请判断你是否看到了上一轮 assistant role。' },
    ],
    stream: process.env.ALMMA_STREAM === '1',
  };

  const result = await request('/api/agents/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.env.ALMMA_LIST_MODELS === '1' || !model) {
  await listModels();
} else {
  await chatCompletions();
}
