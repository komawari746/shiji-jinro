/* 指示人狼 — サービスワーカー
   アプリを閉じていても、指示や通知が届いたときにプッシュ通知を表示するための最小限の仕組み。
   人狼の指示か市民への自動通知かは、この通知の文面からは分からないようにしてある。 */

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", (event) => {
  let data = { title: "あなたへの指示があります", body: "タップして確認してください" };
  try { if (event.data) data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || "指示人狼", {
      body: data.body || "タップして確認してください",
      icon: undefined,
      tag: "shiji-jinro",
      renotify: true
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
