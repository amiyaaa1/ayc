#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ZERO_WIDTH = /\u200b|\u200c|\u200d|\ufeff/g;

function parseArgs(argv) {
  const args = {
    config: 'almma-bootstrap.config.json',
    dryRun: false,
    noWriteResult: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') args.config = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-write-result') args.noWriteResult = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node almma-bootstrap-agent.mjs --config almma-bootstrap.config.json

Required environment variables by default:
  MOEMAIL_API_KEY              API key for https://mail.mui.moe
  ALMMA_AGENT_INSTRUCTIONS     Agent system prompt / instructions

Optional:
  ALMMA_ACCOUNT_PASSWORD       Account password; generated if omitted

Flags:
  --dry-run                    Validate config and stop before network writes
  --no-write-result            Do not write result file with created API key
`);
}

function nowIso() {
  return new Date().toISOString();
}

function envOrValue(value, envName) {
  return envName && process.env[envName] ? process.env[envName] : value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required config value: ${label}`);
  }
  return value.trim();
}

function randomSuffix(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

function generatePassword() {
  return `A1m!${randomBytes(12).toString('base64url')}`;
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
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
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function statePatch(state, patch) {
  return {
    ...state,
    ...patch,
    updatedAt: nowIso(),
  };
}

async function saveState(filePath, state) {
  await writeJsonFile(filePath, state);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
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
  return body;
}

function createAlmmaClient(baseUrl) {
  const root = normalizeBaseUrl(baseUrl);
  return async function almma(pathname, { token, method = 'GET', body } = {}) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      origin: root,
      referer: `${root}/`,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return requestJson(`${root}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
}

function createMailClient(mailConfig) {
  const root = normalizeBaseUrl(requiredString(mailConfig.baseUrl, 'mail.baseUrl'));
  const apiKey = requiredString(envOrValue(mailConfig.apiKey, mailConfig.apiKeyEnv), `mail.apiKey or ${mailConfig.apiKeyEnv}`);
  return async function mail(pathname, { method = 'GET', body } = {}) {
    const headers = {
      accept: 'application/json',
      'x-api-key': apiKey,
    };
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

function extractGeneratedEmail(response) {
  const objects = collectObjects(response);
  const candidates = [];
  for (const object of objects) {
    const email = pickFirstString(object, ['email', 'address', 'mail', 'emailAddress']);
    const id = pickFirstString(object, ['id', '_id', 'emailId']);
    if (email.includes('@')) candidates.push({ id, email });
  }
  if (candidates.length === 0) {
    throw new Error(`Could not find generated email address in response: ${JSON.stringify(response)}`);
  }
  const best = candidates.find((item) => item.id) || candidates[0];
  if (!best.id) {
    throw new Error(`Generated email response has an address but no email id: ${JSON.stringify(response)}`);
  }
  return best;
}

function extractMessageList(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  for (const key of ['messages', 'data', 'items', 'results', 'mail', 'mails']) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

function extractMessageId(message) {
  if (!message || typeof message !== 'object') return '';
  return pickFirstString(message, ['id', '_id', 'messageId', 'mailId']);
}

function stringifyMessage(message) {
  if (typeof message === 'string') return message;
  return JSON.stringify(message);
}

function extractVerificationFromMessage(message, expectedBaseUrl) {
  const raw = stringifyMessage(message).replace(ZERO_WIDTH, '');
  const root = normalizeBaseUrl(expectedBaseUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkPattern = new RegExp(`${root}/verify\\?[^"'\\s<>\\\\]+`, 'i');
  const linkMatch = raw.match(linkPattern);
  if (linkMatch) {
    const decodedLink = linkMatch[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    const url = new URL(decodedLink);
    return {
      link: decodedLink,
      email: url.searchParams.get('email') || '',
      token: url.searchParams.get('token') || '',
    };
  }

  const token = raw.match(/token[=:]"?([a-f0-9]{32,128})/i)?.[1] || '';
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  if (token && email) return { link: '', email, token };
  return null;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function solveTurnstile(config, pageUrl) {
  const solverBaseUrl = normalizeBaseUrl(requiredString(config.solverBaseUrl, 'turnstile.solverBaseUrl'));
  const siteKey = requiredString(config.siteKey, 'turnstile.siteKey');
  const timeoutMs = Number(config.timeoutMs || 180000);
  const pollIntervalMs = Number(config.pollIntervalMs || 3000);

  const start = Date.now();
  const taskUrl = new URL(`${solverBaseUrl}/turnstile`);
  taskUrl.searchParams.set('url', pageUrl);
  taskUrl.searchParams.set('sitekey', siteKey);

  const task = await requestJson(taskUrl, { headers: { accept: 'application/json' } });
  if (task.errorId) throw new Error(`Turnstile solver task failed: ${JSON.stringify(task)}`);
  const taskId = requiredString(task.taskId, 'turnstile taskId');

  while (Date.now() - start < timeoutMs) {
    await sleep(pollIntervalMs);
    const resultUrl = new URL(`${solverBaseUrl}/result`);
    resultUrl.searchParams.set('id', taskId);
    const result = await requestJson(resultUrl, { headers: { accept: 'application/json' } });
    if (result.status === 'processing') {
      process.stdout.write('.');
      continue;
    }
    if (result.errorId) throw new Error(`Turnstile solve failed: ${JSON.stringify(result)}`);
    const token = result.solution?.token;
    if (token) {
      process.stdout.write('\n');
      return token;
    }
  }
  throw new Error(`Turnstile solve timed out after ${timeoutMs}ms`);
}

async function generateEmail(mail, config) {
  const name = `${config.namePrefix || 'almma'}-${randomSuffix()}`;
  const response = await mail('/api/emails/generate', {
    method: 'POST',
    body: {
      name,
      expiryTime: Number(config.expiryTime || 3600000),
      domain: config.domain,
    },
  });
  return extractGeneratedEmail(response);
}

async function waitForVerificationEmail(mail, config, emailId, expectedBaseUrl) {
  const timeoutMs = Number(config.timeoutMs || 180000);
  const pollIntervalMs = Number(config.pollIntervalMs || 5000);
  const start = Date.now();
  const seen = new Set();

  while (Date.now() - start < timeoutMs) {
    const list = await mail(`/api/emails/${encodeURIComponent(emailId)}`);
    const messages = extractMessageList(list);
    for (const item of messages) {
      const messageId = extractMessageId(item);
      if (!messageId) {
        const found = extractVerificationFromMessage(item, expectedBaseUrl);
        if (found?.token) return found;
        continue;
      }
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      const full = await mail(`/api/emails/${encodeURIComponent(emailId)}/${encodeURIComponent(messageId)}`);
      const found = extractVerificationFromMessage(full, expectedBaseUrl);
      if (found?.token) return found;
    }
    process.stdout.write('.');
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for verification email after ${timeoutMs}ms`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const config = await readJsonFile(configPath);
  if (!config) throw new Error(`Config file not found: ${configPath}`);

  const baseUrl = normalizeBaseUrl(requiredString(config.baseUrl, 'baseUrl'));
  const accountName = requiredString(config.account?.name, 'account.name');
  const accountUsername = config.account?.username || '';
  const configuredPassword = envOrValue(config.account?.password, config.account?.passwordEnv);
  const agentInstructions = requiredString(
    envOrValue(config.agent?.instructions, config.agent?.instructionsEnv),
    `agent.instructions or ${config.agent?.instructionsEnv || 'ALMMA_AGENT_INSTRUCTIONS'}`
  );

  const outputConfig = config.output || {};
  const stateFile = path.resolve(path.dirname(configPath), outputConfig.stateFile || 'almma-bootstrap.state.json');
  const resultFile = path.resolve(path.dirname(configPath), outputConfig.resultFile || 'almma-bootstrap.result.json');
  let state = await readJsonFile(stateFile, {});

  const mail = createMailClient(config.mail || {});
  const almma = createAlmmaClient(baseUrl);

  console.log(`Config OK. Base URL: ${baseUrl}`);
  if (args.dryRun) {
    console.log('Dry run complete. No write operations were performed.');
    return;
  }

  if (!state.email?.address || !state.email?.id) {
    console.log('Generating temporary email...');
    const email = await generateEmail(mail, config.mail || {});
    state = statePatch(state, { email: { id: email.id, address: email.email }, createdAt: state.createdAt || nowIso() });
    await saveState(stateFile, state);
    console.log(`Generated email: ${email.email}`);
  }

  if (!state.account?.password) {
    const password = configuredPassword && configuredPassword.trim() ? configuredPassword.trim() : generatePassword();
    state = statePatch(state, {
      account: {
        name: accountName,
        username: accountUsername,
        password,
      },
    });
    await saveState(stateFile, state);
  }

  if (!state.registeredAt) {
    console.log('Solving Turnstile for registration...');
    const turnstileToken = await solveTurnstile(config.turnstile || {}, config.turnstile?.registerPageUrl || `${baseUrl}/register`);
    console.log('Registering account...');
    const registerResult = await almma('/api/auth/register', {
      method: 'POST',
      body: {
        name: state.account.name,
        username: state.account.username,
        email: state.email.address,
        password: state.account.password,
        confirm_password: state.account.password,
        turnstileToken,
      },
    });
    state = statePatch(state, { registeredAt: nowIso(), registerMessage: registerResult?.message || '' });
    await saveState(stateFile, state);
    console.log(`Register response: ${registerResult?.message || 'ok'}`);
  }

  if (!state.verifiedAt) {
    console.log('Waiting for verification email...');
    const verification = await waitForVerificationEmail(mail, config.mail || {}, state.email.id, baseUrl);
    console.log('\nVerifying email...');
    const verifyResult = await almma('/api/user/verify', {
      method: 'POST',
      body: {
        email: verification.email || state.email.address,
        token: verification.token,
      },
    });
    state = statePatch(state, {
      verifiedAt: nowIso(),
      verification: {
        email: verification.email || state.email.address,
        token: verification.token,
        link: verification.link,
        message: verifyResult?.message || '',
      },
    });
    await saveState(stateFile, state);
    console.log(`Verify response: ${verifyResult?.message || 'ok'}`);
  }

  if (!state.login?.token) {
    console.log('Solving Turnstile for login...');
    const turnstileToken = await solveTurnstile(config.turnstile || {}, config.turnstile?.loginPageUrl || `${baseUrl}/login`);
    console.log('Logging in...');
    const loginResult = await almma('/api/auth/login', {
      method: 'POST',
      body: {
        email: state.email.address,
        password: state.account.password,
        turnstileToken,
      },
    });
    const token = requiredString(loginResult?.token, 'login token');
    state = statePatch(state, {
      login: {
        token,
        userId: loginResult.user?._id || loginResult.user?.id || '',
        at: nowIso(),
      },
    });
    await saveState(stateFile, state);
    console.log(`Logged in as user ${state.login.userId || '<unknown>'}`);
  }

  if (!state.apiKey?.key) {
    console.log('Creating Agents API key...');
    const apiKeyResult = await almma('/api/api-keys', {
      method: 'POST',
      token: state.login.token,
      body: {
        name: config.apiKey?.name || `agent-api-key-${randomSuffix(3)}`,
      },
    });
    state = statePatch(state, {
      apiKey: {
        id: apiKeyResult.id,
        name: apiKeyResult.name,
        key: apiKeyResult.key,
        keyPrefix: apiKeyResult.keyPrefix,
        createdAt: apiKeyResult.createdAt,
      },
    });
    await saveState(stateFile, state);
    console.log(`Created API key: ${state.apiKey.keyPrefix || '<prefix unavailable>'}...`);
  }

  if (!state.agent?.id) {
    console.log('Creating agent...');
    const agentBody = {
      name: requiredString(config.agent?.name, 'agent.name'),
      artifacts: config.agent?.artifacts ?? '',
      description: config.agent?.description ?? '',
      instructions: agentInstructions,
      model: requiredString(config.agent?.model, 'agent.model'),
      provider: requiredString(config.agent?.provider, 'agent.provider'),
      model_parameters: config.agent?.model_parameters ?? {},
      edges: config.agent?.edges ?? [],
      category: config.agent?.category ?? 'general',
      support_contact: config.agent?.support_contact ?? { name: '', email: '' },
      tool_options: config.agent?.tool_options ?? {},
      conversation_starters: config.agent?.conversation_starters ?? [],
      tools: config.agent?.tools ?? [],
    };
    const agentResult = await almma('/api/agents', {
      method: 'POST',
      token: state.login.token,
      body: agentBody,
    });
    state = statePatch(state, {
      agent: {
        id: agentResult.id,
        name: agentResult.name,
        provider: agentResult.provider,
        model: agentResult.model,
        createdAt: agentResult.createdAt,
      },
    });
    await saveState(stateFile, state);
    console.log(`Created agent: ${state.agent.id}`);
  }

  console.log('Checking Agents API model list...');
  const models = await requestJson(`${baseUrl}/api/agents/v1/models`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${state.apiKey.key}`,
    },
  });
  const visibleAgent = extractMessageList(models).find((item) => item.id === state.agent.id)
    || (Array.isArray(models?.data) ? models.data.find((item) => item.id === state.agent.id) : null);
  if (!visibleAgent) {
    console.warn(`Warning: agent ${state.agent.id} was created but was not found in /api/agents/v1/models response yet.`);
  }

  const result = {
    baseUrl,
    email: state.email.address,
    apiKey: state.apiKey.key,
    apiKeyPrefix: state.apiKey.keyPrefix,
    agentId: state.agent.id,
    modelNameForChatCompletions: state.agent.id,
    provider: state.agent.provider,
    providerModel: state.agent.model,
    createdAt: nowIso(),
  };

  if ((outputConfig.writeResultFile !== false) && !args.noWriteResult) {
    await writeJsonFile(resultFile, result);
    console.log(`Wrote result file: ${resultFile}`);
  }

  console.log('\nDone. Use this for chat completions:');
  console.log(JSON.stringify({
    apiKey: result.apiKey,
    model: result.modelNameForChatCompletions,
    endpoint: `${baseUrl}/api/agents/v1/chat/completions`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
