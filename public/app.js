const api = {
  async createVideo(payload) {
    const response = await fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: '不明なエラー' }));
      throw new Error(error.message || '生成に失敗しました');
    }
    return response.json();
  },
  async listVideos() {
    const response = await fetch('/api/videos');
    if (!response.ok) {
      throw new Error('一覧の取得に失敗しました');
    }
    return response.json();
  },
  async getVideoStatus(id) {
    const response = await fetch(`/api/videos/${id}/status`);
    if (!response.ok) {
      throw new Error('ステータスの取得に失敗しました');
    }
    return response.json();
  },
  async hasApiKey() {
    const response = await fetch('/api/settings');
    if (!response.ok) {
      return { hasApiKey: false };
    }
    return response.json();
  },
};

const state = {
  videos: new Map(),
  pollingTimers: new Map(),
  currentVideoId: null,
};

const elements = {
  form: document.getElementById('video-form'),
  prompt: document.getElementById('prompt'),
  model: document.getElementById('model'),
  size: document.getElementById('size'),
  seconds: document.getElementById('seconds'),
  inputReference: document.getElementById('input_reference'),
  message: document.getElementById('form-message'),
  generateBtn: document.getElementById('generate-btn'),
  apiStatus: document.getElementById('api-status'),
  list: document.getElementById('video-list'),
  refreshBtn: document.getElementById('refresh-btn'),
  player: document.getElementById('video-player'),
  metadata: document.getElementById('video-metadata'),
  download: document.getElementById('download-container'),
  cardTemplate: document.getElementById('video-card-template'),
};

function setMessage(text, type = '') {
  elements.message.textContent = text;
  elements.message.className = 'form-message';
  if (type) {
    elements.message.classList.add(type);
  }
}

function createMetadataList(video) {
  const dl = document.createElement('dl');
  const progressValue = formatProgress(video.progress);
  const entries = [
    ['プロンプト', video.prompt],
    ['モデル', video.model],
    ['解像度', video.size ?? video.resolution],
    ['長さ', `${video.seconds ?? video.durationSeconds ?? '-'} 秒`],
    ['ステータス', translateStatus(video.status)],
    ['進捗', `${Math.round(progressValue * 100) / 100}%`],
    ['参照メディア', video.input_reference ? 'あり' : 'なし'],
    ['生成開始', new Date(video.createdAt).toLocaleString()],
    ['最終更新', new Date(video.updatedAt).toLocaleString()],
  ];

  for (const [label, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  return dl;
}

function translateStatus(status) {
  switch (status) {
    case 'queued':
      return 'キュー待ち';
    case 'processing':
      return '生成中';
    case 'completed':
      return '完了';
    case 'failed':
      return '失敗';
    default:
      return status;
  }
}

function formatProgress(progress) {
  if (progress === null || progress === undefined) {
    return 0;
  }
  if (progress <= 1) {
    return progress * 100;
  }
  return progress;
}

function renderVideos() {
  elements.list.innerHTML = '';
  const sorted = Array.from(state.videos.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
  if (sorted.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'まだ生成された動画はありません。フォームから作成しましょう。';
    empty.className = 'empty';
    elements.list.appendChild(empty);
    return;
  }

  for (const video of sorted) {
    const clone = elements.cardTemplate.content.firstElementChild.cloneNode(true);
    clone.dataset.videoId = video.id;
    const statusIndicator = clone.querySelector('.status-indicator');
    const statusText = clone.querySelector('.status-text');
    const timestamp = clone.querySelector('.timestamp');
    const title = clone.querySelector('.video-title');
    const meta = clone.querySelector('.video-meta');
    const playBtn = clone.querySelector('.play-btn');

    clone.classList.remove('queued', 'processing', 'completed', 'failed');
    clone.classList.add(video.status);

    statusIndicator.title = translateStatus(video.status);
    const progressValue = formatProgress(video.progress);
    statusText.textContent = `${translateStatus(video.status)} / ${progressValue.toFixed(0)}%`;
    timestamp.dateTime = video.createdAt;
    timestamp.textContent = new Date(video.createdAt).toLocaleString();

    title.textContent = video.prompt.slice(0, 48) + (video.prompt.length > 48 ? '…' : '');
    meta.textContent = `${video.model} · ${(video.size ?? video.resolution) || '-'} · ${(video.seconds ?? video.durationSeconds) || '-'}秒`;

    if (video.status !== 'completed') {
      playBtn.disabled = true;
      playBtn.textContent = '準備中';
    } else {
      playBtn.disabled = false;
      playBtn.textContent = '再生';
      playBtn.addEventListener('click', () => loadVideo(video.id));
    }

    if (video.status === 'failed') {
      playBtn.textContent = '失敗';
      playBtn.disabled = true;
    }

    elements.list.appendChild(clone);
  }
}

function updatePlayer(video) {
  if (!video) {
    elements.player.removeAttribute('src');
    elements.player.load();
    elements.metadata.innerHTML = '';
    elements.download.innerHTML = '';
    return;
  }

  const url = `/api/videos/${video.id}/content`;
  elements.player.src = url;
  elements.player.load();
  elements.metadata.innerHTML = '';
  elements.metadata.appendChild(createMetadataList(video));

  const downloadLink = document.createElement('a');
  downloadLink.href = url;
  downloadLink.download = `${video.id}.mp4`;
  downloadLink.textContent = '動画をダウンロード';
  elements.download.innerHTML = '';
  elements.download.appendChild(downloadLink);
}

async function loadVideo(id) {
  const record = state.videos.get(id);
  if (!record) return;
  state.currentVideoId = id;
  updatePlayer(record);
}

async function refreshStatus(id) {
  try {
    const { video } = await api.getVideoStatus(id);
    state.videos.set(video.id, video);
    renderVideos();
    if (state.currentVideoId === video.id) {
      updatePlayer(video);
    }
    if (['queued', 'processing'].includes(video.status)) {
      schedulePolling(id);
    } else {
      stopPolling(id);
    }
  } catch (error) {
    console.error(error);
  }
}

function schedulePolling(id) {
  if (state.pollingTimers.has(id)) {
    return;
  }
  const timer = setTimeout(async () => {
    state.pollingTimers.delete(id);
    await refreshStatus(id);
  }, 5000);
  state.pollingTimers.set(id, timer);
}

function stopPolling(id) {
  const timer = state.pollingTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    state.pollingTimers.delete(id);
  }
}

function stopAllPolling() {
  for (const id of Array.from(state.pollingTimers.keys())) {
    stopPolling(id);
  }
}

async function refreshList() {
  try {
    stopAllPolling();
    const { videos } = await api.listVideos();
    state.videos = new Map(videos.map((video) => [video.id, video]));
    renderVideos();
    videos
      .filter((video) => ['queued', 'processing'].includes(video.status))
      .forEach((video) => schedulePolling(video.id));
  } catch (error) {
    console.error(error);
    setMessage(error.message, 'error');
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();
  setMessage('OpenAI へリクエストを送信中…');
  elements.generateBtn.disabled = true;

  const payload = {
    prompt: elements.prompt.value,
    model: elements.model.value,
    size: elements.size.value,
    seconds: Number(elements.seconds.value),
  };

  try {
    const { videoId, video } = await api.createVideo(payload);
    state.videos.set(videoId, video);
    renderVideos();
    schedulePolling(videoId);
    setMessage('生成ジョブを開始しました。ステータスが完了になるまで待ちましょう。', 'success');
    elements.form.reset();
    elements.seconds.value = '4';
  } catch (error) {
    console.error(error);
    setMessage(error.message, 'error');
  } finally {
    elements.generateBtn.disabled = false;
  }
}

async function init() {
  const { hasApiKey } = await api.hasApiKey();
  if (!hasApiKey) {
    elements.apiStatus.textContent = '⚠️ OPENAI_API_KEY が未設定です';
  } else {
    elements.apiStatus.textContent = 'API キー設定済み';
  }

  await refreshList();
}

document.addEventListener('DOMContentLoaded', () => {
  elements.form.addEventListener('submit', handleFormSubmit);
  elements.refreshBtn.addEventListener('click', refreshList);
  init();
});
