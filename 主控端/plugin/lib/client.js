window.__ModuleLoader__.load({
  id: "dsh-fleet-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var BASE = "http://127.0.0.1:7800";
    var TOKEN_KEY = "fleet.token";
    var opened = false;
    var root = null;
    var btn = null;
    var state = { nodes: [], sel: "", items: [], running: false, jobId: null };

    function token() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
    function setToken(v) {
      try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    }

    async function api(path, opts) {
      opts = opts || {};
      var res = await fetch(BASE + path, {
        method: opts.method || "GET",
        headers: { "content-type": "application/json", "x-ctl-token": token() },
        body: opts.body,
      });
      var txt = await res.text();
      var data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { raw: txt }; }
      if (res.status === 401) { setToken(""); throw new Error("登录已过期，请重新输入口令"); }
      if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
      return data;
    }

    function injectCss() {
      if (document.querySelector("style[data-fleet]")) return;
      var s = document.createElement("style");
      s.setAttribute("data-fleet", "1");
      s.textContent = [
        ".fleet-launch{position:fixed;left:12px;bottom:10px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;",
        "height:30px;padding:0 12px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;color:#374151;",
        "font:12.5px -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(16,24,40,.12)}",
        ".fleet-launch:hover{border-color:#93c5fd;color:#1d4ed8}",
        ".fleet-launch i{width:7px;height:7px;border-radius:50%;background:#9ca3af}",
        ".fleet-launch i.on{background:#22c55e}.fleet-launch i.busy{background:#f59e0b}",
        ".fleet-win{position:fixed;left:12px;bottom:48px;width:460px;height:min(680px,80vh);z-index:2147483001;display:flex;",
        "flex-direction:column;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;",
        "box-shadow:0 24px 60px -12px rgba(16,24,40,.28);font:13px -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#111827}",
        ".fleet-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #f1f5f9}",
        ".fleet-hd b{font-size:13px}.fleet-hd .sp{flex:1}",
        ".fleet-hd button{border:none;background:none;cursor:pointer;color:#9ca3af;font-size:14px}",
        ".fleet-pill{font-size:11px;padding:1px 8px;border-radius:999px;background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}",
        ".fleet-list{max-height:150px;overflow:auto;border-bottom:1px solid #f1f5f9}",
        ".fleet-row{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer}",
        ".fleet-row:hover{background:#f8fafc}.fleet-row.on{background:#eff6ff}",
        ".fleet-row i{width:7px;height:7px;border-radius:50%;background:#d1d5db;flex:none}",
        ".fleet-row i.on{background:#22c55e}.fleet-row i.busy{background:#f59e0b}",
        ".fleet-row .nm{font-weight:600;font-size:12.5px}",
        ".fleet-row .sub{font-size:11px;color:#9ca3af;font-family:ui-monospace,Consolas,monospace}",
        ".fleet-row .rt{margin-left:auto;font-size:11px;color:#6b7280;font-family:ui-monospace,Consolas,monospace}",
        ".fleet-log{flex:1;overflow:auto;padding:10px 12px}",
        ".fleet-u{display:flex;justify-content:flex-end;margin:10px 0}",
        ".fleet-u span{background:#2563eb;color:#fff;border-radius:12px 12px 3px 12px;padding:6px 11px;max-width:82%;font-size:12.5px;white-space:pre-wrap}",
        ".fleet-step{border:1px solid #eef2f7;border-radius:9px;margin:6px 0;overflow:hidden}",
        ".fleet-step .c{padding:6px 9px;background:#f9fafb;font:11.5px ui-monospace,Consolas,monospace;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".fleet-step pre{margin:0;padding:8px 9px;background:#fcfdff;color:#475569;font:11.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;max-height:160px;overflow:auto}",
        ".fleet-ans{background:#f8fafc;border:1px solid #eef2f7;border-radius:9px;padding:9px 11px;font-size:12.5px;white-space:pre-wrap;margin:6px 0}",
        ".fleet-think{color:#6b7280;font-size:12px;padding:4px 0}",
        ".fleet-err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:9px;padding:8px 10px;font-size:12.5px;margin:6px 0}",
        ".fleet-cp{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #f1f5f9}",
        ".fleet-cp textarea{flex:1;resize:none;border:1px solid #e5e7eb;border-radius:12px;padding:8px 11px;font:12.5px/1.5 inherit;outline:none;max-height:90px;min-height:36px}",
        ".fleet-cp textarea:focus{border-color:#bfdbfe}",
        ".fleet-cp button{width:34px;height:34px;border-radius:50%;border:none;background:#2563eb;color:#fff;cursor:pointer;flex:none}",
        ".fleet-cp button.stop{background:#111827}.fleet-cp button:disabled{background:#e5e7eb;color:#9ca3af}",
        ".fleet-login{padding:16px;display:flex;flex-direction:column;gap:8px}",
        ".fleet-login input{height:36px;border:1px solid #e5e7eb;border-radius:10px;padding:0 11px;font:13px inherit;outline:none}",
        ".fleet-login button{height:36px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}",
        ".fleet-login .err{color:#b91c1c;font-size:12px}",
      ].join("");
      document.head.appendChild(s);
    }

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function dotClass(n) {
      if (!n.online) return "";
      return (n.busy || n.queue) ? "busy" : "on";
    }

    async function refresh() {
      if (!token()) { paint(); return; }
      try {
        var d = await api("/api/nodes");
        state.nodes = d.nodes || [];
        if (!state.sel && state.nodes.length) state.sel = state.nodes[0].id;
      } catch (e) {
        state.nodes = [];
      }
      paint();
    }

    async function loadHistory(nodeId) {
      try {
        var d = await api("/api/ai/jobs");
        var list = (d.jobs || []).filter(function (j) { return j.nodeId === nodeId; }).slice(0, 10).reverse();
        state.items = list.map(function (j) {
          return { prompt: j.prompt, steps: j.steps || [], running: false, error: j.error || "" };
        });
      } catch (e) { state.items = []; }
      paint();
    }

    function paint() {
      if (!opened || !root) return;
      root.innerHTML = "";

      var hd = el("div", "fleet-hd");
      hd.appendChild(el("b", null, "远程机器"));
      var online = state.nodes.filter(function (n) { return n.online; }).length;
      if (token()) hd.appendChild(el("span", "fleet-pill", online + "/" + state.nodes.length + " 在线"));
      hd.appendChild(el("span", "sp"));
      var close = el("button", null, "✕");
      close.onclick = function () { opened = false; root.style.display = "none"; };
      hd.appendChild(close);
      root.appendChild(hd);

      if (!token()) {
        var box = el("div", "fleet-login");
        var inp = el("input");
        inp.type = "password";
        inp.placeholder = "控制台口令";
        var err = el("div", "err");
        var go = el("button", null, "连接");
        go.onclick = async function () {
          err.textContent = "";
          try {
            var res = await fetch(BASE + "/api/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ password: inp.value }),
            });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || "口令不对");
            setToken(d.token);
            await refresh();
          } catch (e) { err.textContent = e.message; }
        };
        inp.onkeydown = function (e) { if (e.key === "Enter") go.onclick(); };
        box.appendChild(inp); box.appendChild(go); box.appendChild(err);
        root.appendChild(box);
        return;
      }

      var list = el("div", "fleet-list");
      if (!state.nodes.length) {
        list.appendChild(el("div", "sub", "还没有机器接入"));
      } else {
        state.nodes.forEach(function (n) {
          var row = el("div", "fleet-row" + (n.id === state.sel ? " on" : ""));
          var d = el("i");
          d.className = dotClass(n);
          row.appendChild(d);
          var info = el("div");
          info.appendChild(el("div", "nm", n.label || (n.metrics && n.metrics.hostname) || n.id));
          var m = n.metrics || {};
          var sub = (m.user || "—") + (!n.online ? "  · 离线" : ((n.busy || n.queue) ? ("  · 忙 " + (n.busy || 0) + "/排 " + (n.queue || 0)) : ""));
          info.appendChild(el("div", "sub", sub));
          row.appendChild(info);
          var d0 = (m.disks || [])[0];
          row.appendChild(el("div", "rt", d0 ? d0.freeGB + "G" : ""));
          row.onclick = function () { state.sel = n.id; loadHistory(n.id); };
          list.appendChild(row);
        });
      }
      root.appendChild(list);

      var log = el("div", "fleet-log");
      if (!state.items.length) log.appendChild(el("div", "sub", "说一句话，它自己在那台机器上跑命令并给结论"));
      state.items.forEach(function (it) {
        var u = el("div", "fleet-u");
        u.appendChild(el("span", null, it.prompt));
        log.appendChild(u);
        (it.steps || []).forEach(function (s) {
          if (s.type === "answer") { log.appendChild(el("div", "fleet-ans", s.text)); return; }
          var card = el("div", "fleet-step");
          card.appendChild(el("div", "c", (s.status === "running" ? "▸ " : "✓ ") + (s.command || "")));
          card.appendChild(el("pre", null, s.output || (s.status === "running" ? "执行中…" : "（无输出）")));
          log.appendChild(card);
        });
        if (it.running) log.appendChild(el("div", "fleet-think", "处理中…"));
        if (it.error) log.appendChild(el("div", "fleet-err", it.error));
      });
      root.appendChild(log);

      var cp = el("div", "fleet-cp");
      var ta = el("textarea");
      ta.rows = 1;
      var cur = null;
      state.nodes.forEach(function (n) { if (n.id === state.sel) cur = n; });
      ta.placeholder = cur ? ("对 " + (cur.label || "") + " 说…") : "先选一台机器";
      var send = el("button", null, state.running ? "■" : "↑");
      if (state.running) send.className = "stop";
      if (!state.running) send.disabled = true;

      function go() {
        if (state.running) { stopJob(); return; }
        var p = ta.value.trim();
        if (!p || !state.sel) return;
        ta.value = "";
        run(p);
      }

      ta.oninput = function () { if (!state.running) send.disabled = !ta.value.trim(); };
      ta.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } };
      send.onclick = go;
      cp.appendChild(ta); cp.appendChild(send);
      root.appendChild(cp);
      log.scrollTop = log.scrollHeight;
    }

    async function run(prompt) {
      var item = { prompt: prompt, steps: [], running: true, error: "" };
      state.items.push(item);
      state.running = true;
      paint();
      try {
        var d = await api("/api/ai/run", { method: "POST", body: JSON.stringify({ nodeId: state.sel, prompt: prompt }) });
        state.jobId = d.job.id;
        var poll = async function () {
          try {
            var r = await api("/api/ai/job/" + d.job.id);
            var job = r.job;
            item.steps = job.steps || [];
            item.running = job.status === "running" || job.status === "stopping";
            item.error = job.error || "";
            if (item.running) setTimeout(poll, 800);
            else { state.running = false; state.jobId = null; }
            paint();
          } catch (e) { state.running = false; paint(); }
        };
        poll();
      } catch (e) {
        item.running = false;
        item.error = e.message;
        state.running = false;
        paint();
      }
    }

    async function stopJob() {
      if (!state.jobId) { state.running = false; paint(); return; }
      try { await api("/api/ai/job/" + state.jobId + "/stop", { method: "POST" }); } catch (e) {}
    }

    function mount() {
      if (document.querySelector(".fleet-launch")) return;
      injectCss();

      btn = document.createElement("button");
      btn.className = "fleet-launch";
      btn.title = "远程机器（点开面板）";
      var dot = document.createElement("i");
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode("远程机器"));
      btn.onclick = function () {
        opened = !opened;
        if (opened) {
          if (!root) {
            root = document.createElement("div");
            root.className = "fleet-win";
            document.body.appendChild(root);
          }
          root.style.display = "flex";
          refresh();
        } else if (root) {
          root.style.display = "none";
        }
      };
      document.body.appendChild(btn);

      var tick = async function () {
        if (!token()) { dot.className = ""; return; }
        try {
          var d = await api("/api/nodes");
          var ns = d.nodes || [];
          var anyIdle = ns.some(function (n) { return n.online && !(n.busy || n.queue); });
          var anyOn = ns.some(function (n) { return n.online; });
          dot.className = anyIdle ? "on" : (anyOn ? "busy" : "");
        } catch (e) { dot.className = ""; }
      };
      tick();
      setInterval(tick, 8000);
    }

    function apply() {
      try { mount(); } catch (e) {
        try { console.warn("[dsh-fleet] 挂载失败: " + (e && e.message)); } catch (x) {}
      }
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
