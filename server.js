const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const { Readable } = require('stream');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = '0.0.0.0';
const API_KEY = process.env.OPENAI_API_KEY || '';
const POLL_INTERVAL_MS = 5000;

const videos = new Map();
const pollHandles = new Map();

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function methodNotAllowed(res) {
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, filePath) {
  const resolvedPath = path.join(__dirname, 'public', filePath);
  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      notFound(res);
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(resolvedPath).pipe(res);
  });
}

function sanitizeVideoParams(params) {
  const errors = [];
  // 後方互換のため旧フィールド名を新フィールドへマップ
  const prompt = params.prompt;
  const model = params.model ?? 'sora-2';
  const size = (params.size || params.resolution || '720x1280');
  const rawSeconds =
    params.seconds != null
      ? params.seconds
      : params.durationSeconds != null
        ? params.durationSeconds
        : '4';
  const seconds = typeof rawSeconds === 'string' ? rawSeconds : String(rawSeconds);

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    errors.push('prompt is required');
  }
  const allowedModels = ['sora-2', 'sora-2-pro'];
  if (!allowedModels.includes(model)) {
    errors.push('model must be one of sora-2, sora-2-pro');
  }
  const sizePattern = /^\d{3,5}x\d{3,5}$/;
  if (!sizePattern.test(size)) {
    errors.push('size must follow WIDTHxHEIGHT');
  }
  const allowedSeconds = ['4', '8', '12'];
  if (!allowedSeconds.includes(seconds)) {
    errors.push('seconds must be one of 4, 8, 12');
  }

  return {
    errors,
    prompt: prompt ? prompt.trim() : '',
    model,
    size,
    seconds,
  };
}

async function callOpenAIVideoCreate(params) {
  if (!API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await fetch('https://api.openai.com/v1/videos', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      // API 仕様に合わせて seconds をそのまま送信
      seconds: params.seconds,
      // 解像度は API 仕様に従い "WxH" の size で指定
      size: params.size,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function callOpenAIVideoStatus(providerVideoId) {
  if (!API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const response = await fetch(`https://api.openai.com/v1/videos/${providerVideoId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }
  return response.json();
}

async function pipeOpenAIContent(req, res, providerVideoId) {
  if (!API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'OPENAI_API_KEY is not configured' }));
    return;
  }

  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
  };
  if (req.headers['range']) {
    headers['Range'] = req.headers['range'];
  }

  const response = await fetch(`https://api.openai.com/v1/videos/${providerVideoId}/content`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: errorText }));
    return;
  }

  const passthroughHeaders = {
    'Content-Type': response.headers.get('content-type') || 'video/mp4',
  };
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    passthroughHeaders['Content-Length'] = contentLength;
  }
  const acceptRanges = response.headers.get('accept-ranges');
  if (acceptRanges) {
    passthroughHeaders['Accept-Ranges'] = acceptRanges;
  }
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    passthroughHeaders['Content-Range'] = contentRange;
  }
  res.writeHead(response.status, passthroughHeaders);
  const body = response.body;
  if (body) {
    if (typeof body.pipe === 'function') {
      body.pipe(res);
      return;
    }
    if (Readable.fromWeb) {
      Readable.fromWeb(body).pipe(res);
      return;
    }
    const reader = body.getReader();
    const pump = () => {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            res.end();
            return;
          }
          res.write(Buffer.from(value));
          pump();
        })
        .catch((err) => {
          res.destroy(err);
        });
    };
    pump();
    return;
  }
  res.end();
}

function scheduleStatusPoll(videoId) {
  if (pollHandles.has(videoId)) {
    return;
  }
  const poll = async () => {
    const record = videos.get(videoId);
    if (!record || !['queued', 'in_progress'].includes(record.status)) {
      pollHandles.delete(videoId);
      return;
    }
    try {
      const statusResponse = await callOpenAIVideoStatus(record.providerVideoId);
      if (statusResponse.status) {
        record.status = statusResponse.status;
      }
      if (typeof statusResponse.progress === 'number') {
        record.progress = statusResponse.progress;
      }
      if (statusResponse.error) {
        record.status = 'failed';
        record.errorMessage = statusResponse.error.message || String(statusResponse.error);
      }
      const dur =
        (statusResponse && (statusResponse.duration_seconds ?? statusResponse.duration ?? statusResponse.length_seconds));
      if (typeof dur === 'number') {
        record.durationSeconds = dur;
      }
      if (statusResponse.resolution) {
        record.resolution = statusResponse.resolution;
      } else if (statusResponse.dimensions) {
        record.resolution = statusResponse.dimensions;
      } else if (statusResponse.width && statusResponse.height) {
        record.resolution = `${statusResponse.width}x${statusResponse.height}`;
      }
      record.updatedAt = new Date().toISOString();
      if (!['queued', 'in_progress'].includes(record.status)) {
        pollHandles.delete(videoId);
        return;
      }
    } catch (err) {
      record.lastError = err.message;
      record.updatedAt = new Date().toISOString();
    }
    pollHandles.set(videoId, setTimeout(poll, POLL_INTERVAL_MS));
  };
  pollHandles.set(videoId, setTimeout(poll, POLL_INTERVAL_MS));
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = requestUrl;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const sendJson = (status, payload) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(payload));
    };

    if (pathname.startsWith('/api')) {
      if (req.method === 'GET' && pathname === '/api/videos') {
        const list = Array.from(videos.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        sendJson(200, { videos: list });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/videos') {
        const body = await parseJsonBody(req);
        const sanitized = sanitizeVideoParams(body);
        if (sanitized.errors.length > 0) {
          sendJson(400, { message: 'Validation error', errors: sanitized.errors });
          return;
        }

        let apiResponse;
        try {
          apiResponse = await callOpenAIVideoCreate(sanitized);
        } catch (err) {
          sendJson(502, { message: err.message });
          return;
        }

        const videoId = crypto.randomUUID();
        const now = new Date().toISOString();
        const record = {
          id: videoId,
          providerVideoId: apiResponse.id || apiResponse.video_id || apiResponse.videoId,
          status: apiResponse.status || 'queued',
          progress: typeof apiResponse.progress === 'number' ? apiResponse.progress : 0,
          prompt: sanitized.prompt,
          model: sanitized.model,
          // 新フィールド
          size: sanitized.size,
          seconds: sanitized.seconds,
          // 旧フィールド（後方互換のため併記）
          resolution: sanitized.size,
          durationSeconds: sanitized.seconds,
          createdAt: now,
          updatedAt: now,
          metadata: apiResponse.metadata || {},
        };
        videos.set(videoId, record);
        if (record.providerVideoId) {
          scheduleStatusPoll(videoId);
        }
        sendJson(201, { videoId, video: record });
        return;
      }

      const statusMatch = pathname.match(/^\/api\/videos\/([^/]+)\/status$/);
      if (statusMatch) {
        const id = statusMatch[1];
        const record = videos.get(id);
        if (!record) {
          sendJson(404, { message: 'Video not found' });
          return;
        }
        if (req.method !== 'GET') {
          methodNotAllowed(res);
          return;
        }
        sendJson(200, { video: record });
        return;
      }

      const contentMatch = pathname.match(/^\/api\/videos\/([^/]+)\/content$/);
      if (contentMatch) {
        if (req.method !== 'GET') {
          methodNotAllowed(res);
          return;
        }
        const id = contentMatch[1];
        const record = videos.get(id);
        if (!record) {
          sendJson(404, { message: 'Video not found' });
          return;
        }
        if (!record.providerVideoId) {
          sendJson(400, { message: 'Video is not ready yet' });
          return;
        }
        await pipeOpenAIContent(req, res, record.providerVideoId);
        return;
      }

      if (pathname === '/api/settings' && req.method === 'GET') {
        sendJson(200, { hasApiKey: Boolean(API_KEY) });
        return;
      }

      notFound(res);
      return;
    }

    if (pathname === '/' || pathname === '') {
      serveStatic(req, res, 'index.html');
      return;
    }

    const staticPath = pathname.replace(/^\//, '');
    serveStatic(req, res, staticPath);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
