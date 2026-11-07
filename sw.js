// GrowBook Capture 画面の service worker（ホーム画面に置けるようにするための最小限。送信は素通し）
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) { /* キャッシュしない＝常に最新の画面を使う */ });
