const CACHE = 'tokyo-trip-v15';
const FETCH_TIMEOUT_MS = 4000; // 訊號差時最多等這麼久，逾時就改用快取

// 預先快取：第一次安裝就存好，之後沒訊號也能開
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './js/utils.js',
  './js/sortable.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      // 個別加入，某個檔案失敗不影響其他檔案和安裝
      Promise.all(PRECACHE.map(u => cache.add(u).catch(() => {})))
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 網路優先；網路失敗或超過 FETCH_TIMEOUT_MS 才改回傳快取（沒有快取就繼續等網路）
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  net.catch(() => {}); // 逾時後網路才失敗時，避免出現未處理的錯誤
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS));
  try {
    return await Promise.race([net, timeout]);
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return net;
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 外部 API 不攔截
  if (e.request.method !== 'GET') return;
  e.respondWith(networkFirst(e.request));
});
