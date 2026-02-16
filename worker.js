import PostalMime from 'postal-mime';
import { createMimeMessage } from 'mimetext';
import { EmailMessage } from 'cloudflare:email';

const MODES = {
  REPLY: 'reply',
  HEADER: 'header',
  NOTIFY: 'notify'
};

const KV_STATS_KEY = 'email_stats';
const RATE_LIMIT_PREFIX = 'rate_limit_';

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeHeaderValue(value) {
  return value
    .replace(/[\x00-\x1F\x7F-\uFFFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 998);
}

function decodeBase64Utf8(str) {
  try {
    const binaryString = atob(str.replace(/\s/g, ''));
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return str;
  }
}

function decodeQuotedPrintable(str) {
  try {
    return str.replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  } catch (e) {
    return str;
  }
}

function parseAddresses(addressStr) {
  const addresses = [];
  const regex = /<([^>]+)>|([^\s,<]+@[^\s,>]+)/g;
  let match;
  while ((match = regex.exec(addressStr)) !== null) {
    addresses.push(match[1] || match[2]);
  }
  return addresses;
}

function isBounceEmail(email) {
  const subject = email.subject?.toLowerCase() || '';
  const from = email.from?.address?.toLowerCase() || '';
  const to = email.to?.toLowerCase() || '';
  
  const bounceIndicators = [
    'undelivered',
    'bounced',
    'delivery failed',
    'mail delivery failed',
    'returned',
    'mailer-daemon',
    'postmaster'
  ];
  
  return bounceIndicators.some(ind => subject.includes(ind)) || 
         from.includes('mailer-daemon') || 
         from.includes('postmaster');
}

function checkSpamScore(env, content, subject, from) {
  const spamKeywords = [
    'viagra', 'cialis', 'lottery', 'winner', 'prize', 'claim now',
    'click here', 'act now', 'limited time', 'free money', 'make money',
    'work from home', 'earn money', 'investment opportunity',
    'congratulations', 'you have been selected', 'urgent business'
  ];
  
  const text = `${subject} ${content} ${from}`.toLowerCase();
  let score = 0;
  
  for (const keyword of spamKeywords) {
    if (text.includes(keyword)) score += 1;
  }
  
  const threshold = parseInt(env.SPAM_THRESHOLD || '3', 10);
  return score >= threshold;
}

function isWhitelisted(env, from) {
  if (!env.SENDER_WHITELIST) return null;
  const whitelist = env.SENDER_WHITELIST.split(',').map(s => s.trim().toLowerCase());
  const fromLower = from.toLowerCase();
  
  for (const allowed of whitelist) {
    if (fromLower.includes(allowed) || fromLower.endsWith(allowed)) {
      return true;
    }
  }
  return false;
}

function isBlacklisted(env, from) {
  if (!env.SENDER_BLACKLIST) return false;
  const blacklist = env.SENDER_BLACKLIST.split(',').map(s => s.trim().toLowerCase());
  const fromLower = from.toLowerCase();
  
  for (const blocked of blacklist) {
    if (fromLower.includes(blocked) || fromLower.endsWith(blocked)) {
      return true;
    }
  }
  return false;
}

async function checkRateLimit(env, sender, ctx) {
  const limit = parseInt(env.RATE_LIMIT || '20', 10);
  const windowSeconds = parseInt(env.RATE_LIMIT_WINDOW || '3600', 10);
  
  if (!env.EMAIL_KV) return { allowed: true, remaining: limit };
  
  const key = `${RATE_LIMIT_PREFIX}${sender}`;
  const now = Date.now();
  
  try {
    const stored = await env.EMAIL_KV.get(key, 'json');
    
    if (!stored) {
      await env.EMAIL_KV.put(key, JSON.stringify({ count: 1, resetAt: now + windowSeconds * 1000 }), { expirationTtl: windowSeconds });
      return { allowed: true, remaining: limit - 1 };
    }
    
    if (now > stored.resetAt) {
      await env.EMAIL_KV.put(key, JSON.stringify({ count: 1, resetAt: now + windowSeconds * 1000 }), { expirationTtl: windowSeconds });
      return { allowed: true, remaining: limit - 1 };
    }
    
    if (stored.count >= limit) {
      return { allowed: false, remaining: 0, resetAt: stored.resetAt };
    }
    
    stored.count += 1;
    await env.EMAIL_KV.put(key, JSON.stringify(stored), { expirationTtl: windowSeconds });
    return { allowed: true, remaining: limit - stored.count };
    
  } catch (e) {
    console.error('Rate limit check error:', e);
    return { allowed: true, remaining: limit };
  }
}

function getDomainFromEmail(email) {
  if (!email) return null;
  const atIndex = email.indexOf('@');
  if (atIndex === -1) return null;
  return email.substring(atIndex + 1).toLowerCase();
}

function getAliasForward(toAddress, aliasConfig) {
  if (!aliasConfig || !toAddress) return null;
  
  const rules = aliasConfig.split(',').map(r => r.trim());
  const toLower = toAddress.toLowerCase();
  
  for (const rule of rules) {
    const [alias, forwardAddr] = rule.split(':').map(s => s.trim());
    if (!alias || !forwardAddr) continue;
    
    if (toLower === alias.toLowerCase()) {
      return forwardAddr;
    }
  }
  return null;
}

function getOverrideByDomain(senderDomain, overrideConfig) {
  if (!overrideConfig || !senderDomain) return null;
  
  const rules = overrideConfig.split(',').map(r => r.trim());
  for (const rule of rules) {
    const [domain, value] = rule.split(':').map(s => s.trim());
    if (domain.startsWith('@')) {
      const ruleDomain = domain.substring(1).toLowerCase();
      if (senderDomain === ruleDomain || senderDomain.endsWith('.' + ruleDomain)) {
        return value;
      }
    }
  }
  return null;
}

function getConfigByDomain(env, domain, configKey) {
  const domainConfigKey = configKey + '_BY_DOMAIN';
  const domainOverride = domain && env[domainConfigKey] ? getOverrideByDomain(domain, env[domainConfigKey]) : null;
  
  return domainOverride || env[configKey];
}

async function updateStats(env, mode) {
  if (!env.EMAIL_KV) return;
  
  try {
    const stats = await env.EMAIL_KV.get(KV_STATS_KEY, 'json') || { total: 0, modes: {}, lastEmail: null };
    stats.total += 1;
    stats.modes[mode] = (stats.modes[mode] || 0) + 1;
    stats.lastEmail = new Date().toISOString();
    await env.EMAIL_KV.put(KV_STATS_KEY, JSON.stringify(stats));
  } catch (e) {
    console.error('Stats update error:', e);
  }
}

async function getStats(env) {
  if (!env.EMAIL_KV) return null;
  try {
    return await env.EMAIL_KV.get(KV_STATS_KEY, 'json');
  } catch (e) {
    return null;
  }
}

function getThreadId(message) {
  const references = message.headers.get('references');
  const messageId = message.headers.get('message-id');
  return references || messageId || null;
}

async function getEmailContent(message) {
  const rawEmail = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const email = await parser.parse(rawEmail);
  
  const attachments = email.attachments || [];
  
  return {
    subject: email.subject || 'No subject',
    from: email.from?.address || message.from,
    fromName: email.from?.name || '',
    to: message.to,
    content: email.text || stripHtml(email.html || ''),
    html: email.html || '',
    rawEmail: rawEmail,
    attachments: attachments.map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      size: att.content?.length || 0
    })),
    messageId: email.messageId,
    threadId: getThreadId(message),
    inReplyTo: email.inReplyTo
  };
}

function parseRawEmailText(rawEmail) {
  const decoder = new TextDecoder('utf-8');
  const rawText = decoder.decode(rawEmail);
  const bodyStartIndex = rawText.indexOf('\r\n\r\n');
  let body = bodyStartIndex !== -1 ? rawText.substring(bodyStartIndex + 4) : rawText;
  
  const encodingMatch = rawText.substring(0, bodyStartIndex || 0).match(/Content-Transfer-Encoding:\s*([a-zA-Z0-9\-]+)/i);
  const encoding = encodingMatch ? encodingMatch[1].toLowerCase() : '7bit';
  
  let content;
  if (encoding === 'base64') {
    content = decodeBase64Utf8(body);
  } else if (encoding === 'quoted-printable') {
    content = decodeQuotedPrintable(body);
  } else {
    content = body;
  }
  
  return content.trim();
}

function getModelForMode(env, mode) {
  switch (mode) {
    case MODES.REPLY:
      return env.AI_MODEL_REPLY || env.AI_MODEL || '@cf/ibm-granite/granite-4.0-h-micro';
    case MODES.HEADER:
      return env.AI_MODEL_HEADER || env.AI_MODEL || '@cf/ibm-granite/granite-4.0-h-micro';
    case MODES.NOTIFY:
      return env.AI_MODEL_NOTIFY || env.AI_MODEL || '@cf/ibm-granite/granite-4.0-h-micro';
    default:
      return env.AI_MODEL || '@cf/ibm-granite/granite-4.0-h-micro';
  }
}

async function generateSummary(env, content, subject, mode) {
  const aiModel = getModelForMode(env, mode);
  const systemPrompt = env.AI_SYSTEM_PROMPT || 'You are a helpful assistant that summarizes emails concisely. Provide a brief summary that captures the main point.';
  const userPrompt = env.AI_USER_PROMPT || `Summarize this email in under 100 words. Focus on key facts, deadlines, and action items.\n\nEmail content:\n${content}`;
  
  console.log(`Calling AI model: ${aiModel} for mode: ${mode}`);
  
  try {
    const aiResponse = await env.AI.run(aiModel, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    
    console.log(`AI response:`, JSON.stringify(aiResponse).substring(0, 200));
    
    const summary = aiResponse.response 
      || aiResponse.text 
      || aiResponse.generated_text
      || (aiResponse.choices && aiResponse.choices[0]?.message?.content)
      || 'No summary generated.';
    
    return summary;
  } catch (e) {
    console.error('AI error:', e);
    return 'Summary unavailable due to AI error.';
  }
}

async function handleReplyMode(message, env, emailData) {
  const summary = await generateSummary(env, emailData.content, emailData.subject, MODES.REPLY);
  
  const msg = createMimeMessage();
  msg.setSender({ addr: message.to });
  msg.setRecipient(emailData.from);
  
  const messageId = message.headers.get('Message-ID');
  const references = message.headers.get('References');
  
  if (messageId) {
    msg.setHeader('In-Reply-To', messageId);
    if (references) {
      msg.setHeader('References', references + ' ' + messageId);
    } else {
      msg.setHeader('References', messageId);
    }
  }
  
  msg.setSubject(`Summary of your email: ${emailData.subject}`);
  msg.addMessage({ contentType: 'text/plain', data: summary });
  
  const replyMessage = new EmailMessage(message.to, emailData.from, msg.asRaw());
  await message.reply(replyMessage);
  
  await updateStats(env, MODES.REPLY);
}

async function handleHeaderMode(message, env, emailData) {
  const summary = await generateSummary(env, emailData.content, emailData.subject, MODES.HEADER);
  const truncatedSummary = summary.length > 998 ? summary.substring(0, 998) : summary;
  
  const aliasForward = getAliasForward(message.to, env.ALIAS_MAPPING);
  const recipientDomain = getDomainFromEmail(message.to);
  const senderDomain = getDomainFromEmail(emailData.from);
  const forwardAddress = aliasForward || getConfigByDomain(env, recipientDomain, 'MAIN_EMAIL_ADDRESS');
  const pushoverEnabled = getConfigByDomain(env, senderDomain, 'PUSHOVER_ENABLED') === 'true' || env.PUSHOVER_ENABLED === 'true';
  
  console.log(`Header mode - to: ${message.to}, alias forward: ${aliasForward}, domain forward: ${forwardAddress}, pushover: ${pushoverEnabled}`);
  
  const headers = new Headers(message.headers);
  headers.set('X-Email-Summary', sanitizeHeaderValue(truncatedSummary));
  
  if (forwardAddress) {
    if (env.FORWARD_ORIGINAL === 'true') {
      await message.forward(forwardAddress, headers);
    } else {
      const msg = createMimeMessage();
      msg.setSender({ addr: message.to });
      msg.setRecipient(forwardAddress);
      msg.setSubject(emailData.subject);
      msg.addMessage({ contentType: 'text/plain', data: `${summary}\n\n---\nOriginal from: ${emailData.from}` });
      await message.forward(forwardAddress);
    }
  }
  
  if (pushoverEnabled && env.PUSHOVER_USER_KEY && env.PUSHOVER_APP_TOKEN) {
    await sendPushover(env, truncatedSummary, emailData);
  }
  
  await updateStats(env, MODES.HEADER);
}

async function sendPushover(env, summary, emailData) {
  const pushoverMessage = `${summary}\n\nFrom: ${emailData.from}\nTo: ${emailData.to}\nSubject: ${emailData.subject}`;
  const maxLen = env.PUSHOVER_MAX_MESSAGE_LENGTH ? parseInt(env.PUSHOVER_MAX_MESSAGE_LENGTH, 10) : 1000;
  
  const sanitize = s => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\u{7F}-\u{FFFF}]/gu, '');
  let finalMessage = sanitize(pushoverMessage);
  
  const chunkSize = Math.max(100, maxLen - 20);
  const chunks = finalMessage.length > chunkSize 
    ? finalMessage.match(new RegExp(`.{1,${chunkSize}}`, 'g')) 
    : [finalMessage];
  
  for (let i = 0; i < chunks.length; i++) {
    const form = new URLSearchParams();
    form.append('token', env.PUSHOVER_APP_TOKEN);
    form.append('user', env.PUSHOVER_USER_KEY);
    form.append('message', chunks[i] + (chunks.length > 1 ? `\n\n(Part ${i + 1}/${chunks.length})` : ''));
    form.append('title', chunks.length > 1 ? `📧 Email Summary (${i + 1}/${chunks.length})` : '📧 New Email Summary');
    if (env.PUSHOVER_PRIORITY) form.append('priority', env.PUSHOVER_PRIORITY);
    if (env.PUSHOVER_SOUND) form.append('sound', env.PUSHOVER_SOUND);
    
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
  }
}

async function handleNotifyMode(message, env, emailData) {
  const to = message.to;
  const subject = emailData.subject;
  const fromHeader = message.headers.get('from') || 'Unknown Sender';
  const replyToHeader = message.headers.get('reply-to');
  const originalSender = (replyToHeader && replyToHeader !== fromHeader) ? replyToHeader : fromHeader;
  const notificationTitle = `📧 Email from ${originalSender}`;
  
  const aliasForward = getAliasForward(to, env.ALIAS_MAPPING);
  const recipientDomain = getDomainFromEmail(to);
  const senderDomain = getDomainFromEmail(emailData.from);
  const forwardAddress = aliasForward || getConfigByDomain(env, recipientDomain, 'MAIN_EMAIL_ADDRESS');
  const domainTopic = getConfigByDomain(env, senderDomain, 'DEFAULT_TOPIC');
  
  let topic = domainTopic || env.DEFAULT_TOPIC || 'default';
  
  if (to.includes('+')) {
    const parts = to.split('+');
    if (parts.length > 1) {
      const afterPlus = parts[1].split('@')[0];
      if (afterPlus) topic = afterPlus;
    }
  }
  
  console.log(`Notify mode - topic: ${topic}, forward to: ${forwardAddress}`);
  
  const emailContent = parseRawEmailText(emailData.rawEmail);
  const summary = await generateSummary(env, emailContent.substring(0, 2000), subject, MODES.NOTIFY);
  
  const isTelegramChatId = /^-?\d+$/.test(topic);
  
  if (isTelegramChatId) {
    if (env.TELEGRAM_BOT_TOKEN) {
      const messageText = `*${notificationTitle}*\n\n*Subject:* ${subject}\n\n${summary}`;
      try {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(topic), text: messageText, parse_mode: 'Markdown' })
        });
        console.log(`Telegram response: ${response.status}`);
      } catch (e) {
        console.error('Telegram error:', e);
      }
    }
  } else {
    const ntfyUrl = `${env.NTFY_URL || 'https://ntfy.sh'}/${topic}`;
    console.log(`Sending to ntfy: ${ntfyUrl}`);
    try {
      const response = await fetch(ntfyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Title': notificationTitle, 'Priority': '3', 'Tags': 'email' },
        body: `Subject: ${subject}\n\n${summary}`
      });
      console.log(`ntfy response: ${response.status}`);
      if (!response.ok) {
        console.error('ntfy error:', await response.text());
      }
    } catch (e) {
      console.error('ntfy error:', e);
    }
  }
  
  if (forwardAddress) {
    await message.forward(forwardAddress);
  }
  
  await updateStats(env, MODES.NOTIFY);
}

function determineMode(to, env) {
  const address = to.toLowerCase();
  
  if (address.includes('+reply@') || address.includes('+summary@')) {
    return MODES.REPLY;
  }
  
  if (address.includes('+')) {
    return MODES.NOTIFY;
  }
  
  return (env.MODE || MODES.HEADER).toLowerCase();
}

export default {
  async email(message, env, ctx) {
    const mode = determineMode(message.to, env);
    const emailData = await getEmailContent(message);
    
    console.log(`Mode detected: ${mode} for email to ${message.to}, from ${emailData.from}`);
    
    if (isBounceEmail(emailData)) {
      console.log('Bounce email detected, skipping processing');
      return;
    }
    
    const whitelistStatus = isWhitelisted(env, emailData.from);
    if (whitelistStatus === false && !isWhitelisted(env, emailData.from)) {
      console.log('Sender is blacklisted, skipping');
      return;
    }
    
    if (checkSpamScore(env, emailData.content, emailData.subject, emailData.from)) {
      console.log('Email flagged as spam, skipping');
      if (env.SPAM_FORWARD_EMAIL && env.MAIN_EMAIL_ADDRESS) {
        await message.forward(env.SPAM_FORWARD_EMAIL);
      }
      return;
    }
    
    const rateLimit = await checkRateLimit(env, emailData.from, ctx);
    console.log(`Rate limit check: allowed=${rateLimit.allowed}, remaining=${rateLimit.remaining}`);
    if (!rateLimit.allowed) {
      console.log('Rate limit exceeded, skipping email');
      return;
    }
    
    try {
      switch (mode) {
        case MODES.REPLY:
          await handleReplyMode(message, env, emailData);
          break;
        case MODES.HEADER:
          await handleHeaderMode(message, env, emailData);
          break;
        case MODES.NOTIFY:
        default:
          await handleNotifyMode(message, env, emailData);
          break;
      }
    } catch (error) {
      console.error('Error processing email:', error);
    }
  },
  
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.pathname === '/stats') {
      const stats = await getStats(env);
      return new Response(JSON.stringify(stats || { message: 'No stats available' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/test') {
      return new Response(JSON.stringify({
        message: 'Email AI Worker is running',
        envVars: Object.keys(env).filter(k => !k.includes('KEY') && !k.includes('TOKEN') && !k.includes('SECRET'))
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(`Email AI Worker - Use /stats, /health, or /test endpoints`, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  },
  
  async scheduled(event, env, ctx) {
    console.log('Scheduled digest triggered');
  }
};
